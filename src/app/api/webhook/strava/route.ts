import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { pool } from "@/lib/db";
import {
  getValidAccessToken,
  decodePolylineToWKT,
  selectPolyline,
  ALL_TRACKED_ACTIVITY_TYPES,
} from "@/lib/strava";
import { computeTrailProgress, snapshotTrailProgress } from "@/lib/match-trails";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  recordDescriptionUpdateFailure,
  ScopeError,
  type DescriptionMode,
} from "@/lib/trail-descriptions";

// A single trail's match computation can legitimately take well over a
// minute for an active user — ST_Union over hundreds/thousands of nearby
// activities is genuinely expensive at that scale (confirmed elsewhere:
// e.g. ~112s for one trail on a ~1,300-activity account). handleNewActivity
// used to await computeTrailProgress for ALL nearby trails, unbounded,
// before ever attempting the description write — for a power user this
// routinely exceeds whatever real execution budget Vercel gives this
// waitUntil()-deferred background task, killing the whole function before
// writeTrailDescription is ever reached. No error gets logged either: an
// abrupt kill doesn't run any catch block. Confirmed happening in practice:
// a user's evening run had genuine trail matches (activity_trail_matches
// populated correctly) but its Strava description was never touched.
// Race matching against this budget so description-writing always gets a
// chance to run — using whatever matches exist by then, complete or not.
// (Promise.race doesn't cancel the underlying query; matching keeps
// running and its results still land, just no longer blocking the write.)
const TRAIL_MATCHING_TIME_BUDGET_MS = 20_000;

function withTimeBudget<T>(promise: Promise<T>, ms: number): Promise<T | "timed_out"> {
  return Promise.race([
    promise,
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), ms)),
  ]);
}

interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  aspect_type: "create" | "update" | "delete";
  object_id: number;   // activity ID for activity events; athlete Strava ID for athlete events
  owner_id: number;    // always the athlete's Strava ID
  subscription_id: number;
  event_time: number;
  updates?: Record<string, string>;
}

// ── GET: Strava subscription validation ────────────────────────────────────────
// Strava sends this once when you register the webhook subscription.
// Must echo back hub.challenge to confirm ownership of the endpoint.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode        = searchParams.get("hub.mode");
  const challenge   = searchParams.get("hub.challenge");
  const verifyToken = searchParams.get("hub.verify_token");

  if (
    mode === "subscribe" &&
    challenge &&
    verifyToken === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN
  ) {
    return NextResponse.json({ "hub.challenge": challenge });
  }

  console.warn("[webhook/strava] Validation failed — wrong verify_token or missing params");
  return new Response("Forbidden", { status: 403 });
}

// ── POST: Event callback ───────────────────────────────────────────────────────
// Strava requires a 200 response within 2 seconds.
// Deauth events are processed synchronously (fast DB delete, must not be missed).
// New activity events are processed in the background (trail matching can be slow) —
// via waitUntil(), which lets handleNewActivity keep running after the response is
// sent, up to this configured ceiling. Vercel Hobby plan hard-caps function
// duration at 60s — this cannot be raised without a plan upgrade (same ceiling
// used by every other heavy route in this app, see vercel.json). Still not
// enough to let TRAIL_MATCHING_TIME_BUDGET_MS's background continuation
// actually finish for a power user (confirmed: 127-283s for 5-7 nearby
// trails), but every extra second here is a second less work update-descriptions'
// backlog scan has left to do later.
export const maxDuration = 60;

export async function POST(req: Request) {
  let event: StravaWebhookEvent;
  try {
    event = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  console.log("[webhook/strava] Event:", JSON.stringify(event));

  if (event.object_type === "athlete" && event.aspect_type === "delete") {
    await handleDeauth(event.object_id);
  } else if (event.object_type === "activity" && event.aspect_type === "create") {
    waitUntil(handleNewActivity(event.object_id, event.owner_id));
  } else if (event.object_type === "activity" && event.aspect_type === "delete") {
    waitUntil(handleDeletedActivity(event.object_id, event.owner_id));
  } else if (event.object_type === "activity" && event.aspect_type === "update") {
    waitUntil(handleUpdatedActivity(event.object_id, event.owner_id));
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

// ── Deauthorisation ────────────────────────────────────────────────────────────
// Strava requires apps to delete all user data when access is revoked.
// The users table cascades to activities, user_trail_progress, and
// user_trail_manual_segments via ON DELETE CASCADE.
async function handleDeauth(stravaAthleteId: number) {
  console.log(`[webhook/strava] Deauth for Strava athlete ${stravaAthleteId}`);
  const { rowCount } = await pool.query(
    "DELETE FROM users WHERE strava_id = $1",
    [stravaAthleteId]
  );
  console.log(
    `[webhook/strava] Deleted ${rowCount ?? 0} user record(s) for athlete ${stravaAthleteId}`
  );
}

// ── Deleted activity ───────────────────────────────────────────────────────────
// Removes the activity from our DB and recomputes trail progress for any trails
// that were nearby, so completion percentages stay accurate.
async function handleDeletedActivity(activityId: number, stravaAthleteId: number) {
  console.log(`[webhook/strava] Delete activity ${activityId} for athlete ${stravaAthleteId}`);

  try {
    const { rows: [user] } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE strava_id = $1",
      [stravaAthleteId]
    );
    if (!user) {
      console.log(`[webhook/strava] Athlete ${stravaAthleteId} not in our DB — ignoring`);
      return;
    }

    // Capture nearby trail IDs before deleting so we can do a targeted recompute
    const { rows: nearbyTrails } = await pool.query<{ id: string }>(
      `SELECT DISTINCT t.id
       FROM trails t
       JOIN activities a ON ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
       WHERE a.strava_activity_id = $1 AND a.user_id = $2 AND a.geometry IS NOT NULL`,
      [activityId, user.id]
    );
    const trailIds = nearbyTrails.map(r => r.id);

    const { rowCount } = await pool.query(
      "DELETE FROM activities WHERE strava_activity_id = $1 AND user_id = $2",
      [activityId, user.id]
    );

    if ((rowCount ?? 0) === 0) {
      console.log(`[webhook/strava] Activity ${activityId} not in our DB — nothing to delete`);
      return;
    }

    console.log(
      `[webhook/strava] Deleted activity ${activityId}, recomputing ${trailIds.length} trail(s)…`
    );
    const matched = await computeTrailProgress(user.id, trailIds.length > 0 ? trailIds : undefined);
    console.log(`[webhook/strava] Recompute complete — ${matched} trail(s) updated`);
  } catch (err) {
    console.error(`[webhook/strava] Error deleting activity ${activityId}:`, err);
  }
}

// ── Updated activity ───────────────────────────────────────────────────────────
// Handles metadata changes (name, type) and the case where Strava sends an
// update event but the activity no longer exists (404) — treat that as a delete.
async function handleUpdatedActivity(activityId: number, stravaAthleteId: number) {
  console.log(`[webhook/strava] Update activity ${activityId} for athlete ${stravaAthleteId}`);

  try {
    const { rows: [user] } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE strava_id = $1",
      [stravaAthleteId]
    );
    if (!user) return;

    // Only act if we have this activity in our DB
    const { rows: [existing] } = await pool.query<{ id: string }>(
      "SELECT id FROM activities WHERE strava_activity_id = $1 AND user_id = $2",
      [activityId, user.id]
    );
    if (!existing) {
      console.log(`[webhook/strava] Activity ${activityId} not in our DB — ignoring update`);
      return;
    }

    const accessToken = await getValidAccessToken(user.id);
    const res = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // 404 means the activity was deleted on Strava — remove it from our DB
    if (res.status === 404) {
      console.log(`[webhook/strava] Activity ${activityId} returned 404 — treating as delete`);
      await handleDeletedActivity(activityId, stravaAthleteId);
      return;
    }

    if (!res.ok) {
      console.error(`[webhook/strava] Failed to fetch activity ${activityId}: HTTP ${res.status}`);
      return;
    }

    const activity = await res.json();
    const activityType: string = activity.sport_type || activity.type;

    // Type changed to something we no longer track — delete it and recompute
    if (!ALL_TRACKED_ACTIVITY_TYPES.has(activityType)) {
      console.log(
        `[webhook/strava] Activity ${activityId} type changed to "${activityType}" (not tracked) — deleting`
      );
      await handleDeletedActivity(activityId, stravaAthleteId);
      return;
    }

    // Otherwise update the stored name and type in case they changed
    await pool.query(
      `UPDATE activities SET name = $1, activity_type = $2 WHERE strava_activity_id = $3 AND user_id = $4`,
      [activity.name, activityType, activityId, user.id]
    );
    console.log(`[webhook/strava] Updated activity ${activityId} metadata (name/type)`);
  } catch (err) {
    console.error(`[webhook/strava] Error handling update for activity ${activityId}:`, err);
  }
}

// ── New activity ───────────────────────────────────────────────────────────────
// Fetches the full activity from Strava (needed for the polyline), stores it,
// then runs trail matching for the user.
async function handleNewActivity(activityId: number, stravaAthleteId: number) {
  console.log(
    `[webhook/strava] New activity ${activityId} for athlete ${stravaAthleteId}`
  );

  try {
    const { rows: [user] } = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE strava_id = $1",
      [stravaAthleteId]
    );
    if (!user) {
      console.log(
        `[webhook/strava] Athlete ${stravaAthleteId} not in our DB — ignoring`
      );
      return;
    }

    const accessToken = await getValidAccessToken(user.id);

    const res = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      console.error(
        `[webhook/strava] Failed to fetch activity ${activityId}: HTTP ${res.status}`
      );
      return;
    }
    const activity = await res.json();

    const activityType: string = activity.sport_type || activity.type;

    const { rows: [userPrefs] } = await pool.query<{
      strava_description_updates: boolean;
      description_mode: DescriptionMode;
    }>(
      "SELECT strava_description_updates, description_mode FROM users WHERE id = $1",
      [user.id]
    );

    if (!ALL_TRACKED_ACTIVITY_TYPES.has(activityType)) {
      console.log(
        `[webhook/strava] Skipping — type "${activityType}" not tracked`
      );
      return;
    }

    const rawPolyline = selectPolyline(activity.map);
    const wkt = decodePolylineToWKT(rawPolyline);
    const { rowCount } = await pool.query(
      `INSERT INTO activities (
         user_id, strava_activity_id, name, activity_type,
         distance, moving_time, start_date, polyline, geometry
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
           ST_GeomFromText($9, 4326))
       ON CONFLICT (strava_activity_id) DO NOTHING`,
      [
        user.id, activity.id, activity.name, activityType,
        activity.distance, activity.moving_time, activity.start_date,
        rawPolyline, wkt,
      ]
    );

    if ((rowCount ?? 0) === 0) {
      console.log(
        `[webhook/strava] Activity ${activityId} already in DB — skipping trail match`
      );
      return;
    }

    // Find only the trails near this activity and re-match just those —
    // much faster than re-matching every trail in the DB.
    const { rows: [savedAct] } = await pool.query<{ id: string }>(
      "SELECT id FROM activities WHERE strava_activity_id = $1 AND user_id = $2",
      [activityId, user.id]
    );

    if (!savedAct) return;

    const { rows: nearbyTrails } = await pool.query<{ id: string }>(
      `SELECT DISTINCT t.id
       FROM trails t
       JOIN activities a ON ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
       WHERE a.id = $1 AND a.geometry IS NOT NULL`,
      [savedAct.id]
    );
    const trailIds = nearbyTrails.map(r => r.id);

    // Register these as description-backfill candidates immediately, from
    // the same cheap proximity check above — not gated behind the expensive
    // per-trail union computation below. Confirmed in production (Glen: 5
    // trails, David: 7) that computeTrailProgress can take 2-5 *minutes* for
    // a handful of nearby trails, far past anything a single invocation can
    // wait out. activity_trail_matches previously only got a row for a
    // trail as a side effect of that slow loop finishing that trail's
    // ACTIVITY_MATCH_SQL step — so when the invocation got cut off partway
    // through, later trails never became backfill candidates either,
    // making the activity invisible to BOTH the real-time write AND the
    // update-descriptions safety net that's supposed to catch what
    // real-time missed.
    if (trailIds.length > 0) {
      await pool.query(
        `INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
         SELECT $1, id, $2 FROM UNNEST($3::uuid[]) AS id
         ON CONFLICT (activity_id, trail_id) DO NOTHING`,
        [savedAct.id, user.id, trailIds]
      ).catch((err) => {
        console.error(`[webhook/strava] Failed to register backfill candidates for activity ${activityId}:`, err);
      });
    }

    // Snapshot completed_distance before/after matching so writeTrailDescription
    // can report exactly how much new ground THIS activity added — see the
    // comment on snapshotTrailProgress. Only meaningful for the nearby-trails
    // fast path (trailIds non-empty); the rare full-account fallback below
    // isn't scoped to specific trails, so there's nothing to diff for it and
    // getActivityTrailMatches just falls back to its own cheap approximation.
    // Skipped entirely when the user doesn't have description writes on —
    // no point taking two extra snapshots nothing will ever read.
    const wantsDescriptionUpdate = userPrefs?.strava_description_updates ?? false;
    const beforeSnapshot = wantsDescriptionUpdate
      ? await snapshotTrailProgress(user.id, trailIds)
      : new Map<string, number>();

    console.log(
      `[webhook/strava] Saved activity ${activityId}, matching ${trailIds.length} nearby trail(s)…`
    );
    const matchResult = await withTimeBudget(
      computeTrailProgress(user.id, trailIds.length > 0 ? trailIds : undefined),
      TRAIL_MATCHING_TIME_BUDGET_MS
    );
    if (matchResult === "timed_out") {
      console.warn(
        `[webhook/strava] Trail matching for activity ${activityId} exceeded ${TRAIL_MATCHING_TIME_BUDGET_MS}ms — remaining trails keep processing in the background and will be picked up next time`
      );
    } else {
      console.log(
        `[webhook/strava] Trail matching complete — ${matchResult} trail(s) updated`
      );
    }

    // Optionally append trail info to the Strava activity description.
    // Skipped entirely (not attempted with a guessed value) when matching
    // timed out: the "after" snapshot below would be taken before the
    // still-running background matching has actually landed its DB
    // updates, making every trail's new-ground delta compute as a false
    // zero — confirmed in production, this is exactly what silently
    // blocked Glen's and David's 'new_with_totals' writes despite both
    // activities genuinely covering several km of new ground. Since
    // activity_trail_matches is now registered unconditionally above,
    // update-descriptions' backlog scan will find and correctly write
    // this once matching actually finishes, instead of the write being
    // lost here with a wrong answer.
    if (wantsDescriptionUpdate && matchResult !== "timed_out") {
      const afterSnapshot = await snapshotTrailProgress(user.id, trailIds);
      const newGroundByTrailId = new Map(
        trailIds.map((id) => [id, Math.max(0, (afterSnapshot.get(id) ?? 0) - (beforeSnapshot.get(id) ?? 0))])
      );
      const matches = await getActivityTrailMatches(user.id, savedAct.id, newGroundByTrailId);
      if (matches.length > 0) {
        console.log(
          `[webhook/strava] Updating description for activity ${activityId}…`
        );
        await writeTrailDescription(
          user.id, savedAct.id, activityId, matches, userPrefs.description_mode ?? "full"
        )
          .catch(async (err) => {
            if (err instanceof ScopeError) {
              console.warn(`[webhook/strava] Scope error — user needs to reconnect: ${err.message}`);
              return;
            }
            console.error(`[webhook/strava] Description update failed:`, err);
            // Shares the same bounded-retry counter as update-descriptions'
            // backlog scan — an activity that fails here first still stops
            // getting retried once the backlog scan later picks it up, and
            // vice versa: if this call happens to be the one that crosses
            // the threshold, finalize it here too.
            const { giveUp } = await recordDescriptionUpdateFailure(user.id, savedAct.id).catch(() => ({ giveUp: false }));
            if (giveUp) {
              await pool.query(
                "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
                [savedAct.id]
              ).catch(() => {});
            }
          });
      }
    }
  } catch (err) {
    console.error(
      `[webhook/strava] Error processing activity ${activityId}:`,
      err
    );
  }
}
