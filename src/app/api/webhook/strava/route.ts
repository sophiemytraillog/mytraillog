import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { pool } from "@/lib/db";
import {
  getValidAccessToken,
  decodePolylineToWKT,
  SYNC_ACTIVITY_TYPES,
  CYCLING_ACTIVITY_TYPES,
} from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
} from "@/lib/trail-descriptions";

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
// New activity events are processed in the background (trail matching can be slow).
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

    const { rows: [userPrefs] } = await pool.query<{ strava_description_updates: boolean; include_cycling: boolean }>(
      "SELECT strava_description_updates, include_cycling FROM users WHERE id = $1",
      [user.id]
    );
    const allowedTypes = userPrefs?.include_cycling
      ? new Set([...Array.from(SYNC_ACTIVITY_TYPES), ...Array.from(CYCLING_ACTIVITY_TYPES)])
      : SYNC_ACTIVITY_TYPES;

    if (!allowedTypes.has(activityType)) {
      console.log(
        `[webhook/strava] Skipping — type "${activityType}" not tracked`
      );
      return;
    }

    const wkt = decodePolylineToWKT(activity.map?.summary_polyline);
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
        activity.map?.summary_polyline ?? null, wkt,
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

    console.log(
      `[webhook/strava] Saved activity ${activityId}, matching ${trailIds.length} nearby trail(s)…`
    );
    const matched = await computeTrailProgress(user.id, trailIds.length > 0 ? trailIds : undefined);
    console.log(
      `[webhook/strava] Trail matching complete — ${matched} trail(s) updated`
    );

    // Optionally append trail info to the Strava activity description
    if (userPrefs?.strava_description_updates) {
      const matches = await getActivityTrailMatches(user.id, savedAct.id);
      if (matches.length > 0) {
        console.log(
          `[webhook/strava] Updating description for activity ${activityId}…`
        );
        await writeTrailDescription(user.id, savedAct.id, activityId, matches)
          .catch((err) => {
            if (err instanceof ScopeError) {
              console.warn(`[webhook/strava] Scope error — user needs to reconnect: ${err.message}`);
            } else {
              console.error(`[webhook/strava] Description update failed:`, err);
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
