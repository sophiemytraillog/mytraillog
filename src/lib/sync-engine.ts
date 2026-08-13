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
  StravaRateLimitError,
  type DescriptionMode,
} from "@/lib/trail-descriptions";
import { logSyncEvent } from "@/lib/sync-log";

// Finding which of ~1,180 trails are near a BATCH of activities (as opposed
// to computeTrailProgress's own per-trail queries, which are always scoped
// to one known trail) took four attempts to get right — see the Rosie
// Dyball investigation. In order, all confirmed too slow at real-world
// scale (373 activities): (1) ST_DWithin on raw t.geometry — Postgres 57014
// statement timeout outright; (2) ST_DWithin with ST_SimplifyPreserveTopology
// computed inline — still timed out, since there's no index on an
// expression computed fresh per call; (3) ST_DWithin against
// trails.simplified_geometry, a materialized+GIST-indexed column (kept —
// it's used elsewhere and is good practice) — STILL timed out, because
// EXPLAIN showed Postgres evaluating ST_DWithin as a brute-force
// Join Filter across the full activities x trails cross product, never
// as an Index Cond — a GIST index on a geometry column can't accelerate a
// ::geography-cast distance predicate here; (4) unioning all the batch's
// activities into one geometry first, then checking that ONE geometry
// against each trail — union itself was fast (~2s), but produced a
// 481,230-point merged geometry, making every one of the 1,181 per-trail
// comparisons individually expensive.
//
// What actually works: skip ST_DWithin/::geography entirely for this
// discovery step and use the plain geometry `&&` bounding-box overlap
// operator, which — unlike ST_DWithin on geography — genuinely uses the
// GIST index. Applied PER ACTIVITY (not one envelope around the whole
// batch — a user with activities spread across the whole country makes a
// single combined envelope worthless as a filter, confirmed: it matched
// 985 of 1,181 trails). ST_Expand(geometry, degrees) grows each activity's
// own bounding box by pure coordinate arithmetic — no actual buffer
// geometry gets computed, unlike ST_Buffer, which was also too slow when
// computed per-row. 0.003° is a deliberately conservative approximation of
// ~250m (1° latitude ≈ 111km everywhere; longitude shrinks further north,
// so 0.003° is over-generous at UK latitudes, never under) — this is a
// coarse candidate list either way, computeTrailProgress still does the
// precise 50m intersection afterward, so a slightly wider net here only
// costs a few extra cheap no-coverage checks, never a wrong match.
const NEARBY_TRAILS_BBOX_DEGREES = 0.003;

// A user with activities scattered nationwide can still legitimately
// produce hundreds of real candidate trails (confirmed: 245 for a
// 373-activity account) — processing all of them with computeTrailProgress
// synchronously could itself exceed whatever budget remains in this
// invocation (finishSync runs after runSyncChunk has already spent most of
// Vercel's 60s ceiling). Capping bounds the worst case; trails beyond the
// cap simply stay unmatched for now and get picked up by a later sync
// chunk, webhook event, or /admin rematch — same eventually-consistent
// model as trail_match_checks elsewhere, not a correctness issue, since
// computeTrailProgress's INSERT ON CONFLICT is idempotent either way.
const MAX_TRAILS_PER_FINISH_SYNC = 40;

const PER_PAGE = 30;
const PAGE_DELAY_MS = 2000;

// Vercel Hobby plan hard-caps function duration at 60s — this can't be
// raised without a plan upgrade. Default budget leaves margin for the final
// DB write and SSE close within that ceiling.
const DEFAULT_BUDGET_MS = 45_000;

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  start_date: string;
  // polyline (full-resolution) is only ever present on the detail endpoint
  // (GET /activities/{id}), never on this list endpoint's summary
  // representation — selectPolyline's fallback to it is a no-op here, kept
  // only so this type and the fallback stay consistent with the other
  // call sites that decode a Strava polyline.
  map?: { summary_polyline?: string | null; polyline?: string | null };
}

export interface SyncProgress {
  fetched: number;
  saved: number;
  message: string;
}

export type SyncChunkResult =
  | { status: "complete"; fetched: number; saved: number; newDbIds: string[] }
  | { status: "partial"; fetched: number; saved: number; newDbIds: string[] }
  | { status: "rate_limited"; message: string }
  | { status: "error"; message: string };

/**
 * Fetches and stores up to `budgetMs` worth of a user's Strava activity
 * history, resuming from wherever the last chunk left off (derived from
 * MIN/MAX(start_date) of what's already stored — no separate cursor needed).
 * Returns "partial" if the time budget was hit before both passes finished;
 * callers (the SSE route, the dashboard self-heal nudge, the cron sweep) are
 * expected to call this again later to continue. Only on "complete" does
 * sync_status flip to 'complete' and last_synced_at update.
 */
export async function runSyncChunk(
  userId: string,
  opts: { budgetMs?: number; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal } = {}
): Promise<SyncChunkResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > budgetMs;
  const aborted = () => signal?.aborted ?? false;

  let fetched = 0;
  let saved = 0;
  const newDbIds: string[] = [];

  // Every return point in this function should exit through here so
  // sync_log always has a record of how the chunk ended, without repeating
  // a log call at each individual return site.
  const logAndReturn = (result: SyncChunkResult): SyncChunkResult => {
    logSyncEvent(userId, "sync_chunk_result", { ...result, newDbIds: result.status === "complete" || result.status === "partial" ? result.newDbIds.length : undefined });
    return result;
  };

  try {
    const accessToken = await getValidAccessToken(userId);

    const savePage = async (activities: StravaActivity[]): Promise<number> => {
      let pageNew = 0;
      for (const activity of activities) {
        const type = activity.sport_type || activity.type;
        if (!ALL_TRACKED_ACTIVITY_TYPES.has(type)) continue;
        const rawPolyline = selectPolyline(activity.map);
        const wkt = decodePolylineToWKT(rawPolyline);
        // Only worth flagging when Strava gave us a polyline and decoding it
        // still failed (malformed data) — a null polyline (manual entry,
        // indoor activity, privacy zone) is normal and not an error.
        if (rawPolyline && !wkt) {
          logSyncEvent(userId, "polyline_decode_failed", {
            strava_activity_id: activity.id,
            name: activity.name,
          });
        }
        const result = await pool.query<{ id: string }>(
          `INSERT INTO activities (
             user_id, strava_activity_id, name, activity_type,
             distance, moving_time, start_date, polyline, geometry
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
             ST_GeomFromText($9, 4326))
           ON CONFLICT (strava_activity_id) DO NOTHING
           RETURNING id`,
          [
            userId, activity.id, activity.name, type,
            activity.distance, activity.moving_time, activity.start_date,
            rawPolyline, wkt,
          ]
        );
        if ((result.rowCount ?? 0) > 0) { pageNew++; newDbIds.push(result.rows[0].id); }
      }
      return pageNew;
    };

    const fetchPage = async (params: Record<string, string | number>) => {
      const url = new URL("https://www.strava.com/api/v3/athlete/activities");
      url.searchParams.set("per_page", String(PER_PAGE));
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 429) return "rate_limited" as const;
      if (!res.ok) throw new Error(`Strava API error ${res.status}: ${await res.text()}`);
      return res.json() as Promise<StravaActivity[]>;
    };

    const heartbeat = () =>
      pool.query("UPDATE users SET sync_progress_at = NOW() WHERE id = $1", [userId]).catch(() => {});

    const boundsRow = await pool.query<{ after_unix: string; before_unix: string; count: string }>(
      `SELECT EXTRACT(EPOCH FROM MAX(start_date))::bigint AS after_unix,
              EXTRACT(EPOCH FROM MIN(start_date))::bigint AS before_unix,
              COUNT(*)::text AS count
       FROM activities WHERE user_id = $1`,
      [userId]
    );
    const existingCount = parseInt(boundsRow.rows[0]?.count ?? "0");
    const afterUnix: number | null = boundsRow.rows[0]?.after_unix ? parseInt(boundsRow.rows[0].after_unix) : null;
    const beforeUnix: number | null = boundsRow.rows[0]?.before_unix ? parseInt(boundsRow.rows[0].before_unix) : null;

    await pool.query(
      "UPDATE users SET sync_status = 'syncing', sync_progress_at = NOW() WHERE id = $1",
      [userId]
    );
    logSyncEvent(userId, "sync_chunk_started", { existingCount, resuming: existingCount > 0 });
    onProgress({ fetched: 0, saved: 0, message: existingCount > 0 ? "Checking for new activities…" : "Starting sync…" });

    // ── Forward pass: activities newer than what we have ──────────────────
    // Skipped on a first-ever sync (afterUnix === null): with no "after" bound,
    // Strava returns activities newest-first starting from page 1, so this loop
    // would walk the user's ENTIRE history — duplicating the backward pass below.
    if (afterUnix !== null) {
      for (let page = 1; ; page++) {
        if (aborted()) return logAndReturn({ status: "partial", fetched, saved, newDbIds });
        if (overBudget()) return logAndReturn({ status: "partial", fetched, saved, newDbIds });
        if (page > 1) await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

        const activities = await fetchPage({ page, after: afterUnix });
        if (activities === "rate_limited") {
          await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
          return logAndReturn({ status: "rate_limited", message: "Strava rate limit reached. Please try again in a few minutes." });
        }
        if (activities.length === 0) break;

        fetched += activities.length;
        saved += await savePage(activities);
        await heartbeat();
        onProgress({ fetched, saved, message: `Syncing… ${fetched} fetched, ${saved} saved` });
        if (activities.length < PER_PAGE) break;
      }
    }

    // ── Backward pass: fill any gap older than the oldest activity we have ─
    let cursor = beforeUnix !== null ? beforeUnix - 1 : null;
    if (cursor !== null || existingCount === 0) {
      onProgress({ fetched, saved, message: "Checking for older activities…" });
      while (true) {
        if (aborted()) return logAndReturn({ status: "partial", fetched, saved, newDbIds });
        if (overBudget()) return logAndReturn({ status: "partial", fetched, saved, newDbIds });
        await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

        const params: Record<string, string | number> = {};
        if (cursor !== null) params.before = cursor;
        const activities = await fetchPage(params);
        if (activities === "rate_limited") {
          await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
          return logAndReturn({ status: "rate_limited", message: "Strava rate limit reached. Please try again in a few minutes." });
        }
        if (activities.length === 0) break;

        fetched += activities.length;
        saved += await savePage(activities);
        await heartbeat();
        onProgress({ fetched, saved, message: `Backfilling… ${fetched} fetched, ${saved} saved` });

        const oldest = activities[activities.length - 1].start_date;
        cursor = Math.floor(new Date(oldest).getTime() / 1000) - 1;
        if (activities.length < PER_PAGE) break;
      }
    }

    await pool.query(
      `UPDATE users SET sync_status = 'complete', last_synced_at = NOW() WHERE id = $1`,
      [userId]
    );
    return logAndReturn({ status: "complete", fetched, saved, newDbIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    console.error("[sync-engine] runSyncChunk error:", err);
    await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
    return logAndReturn({ status: "error", message });
  }
}

/**
 * Runs after a sync chunk reaches "complete": scopes trail matching to
 * trails near the newly-saved activities (not the whole trails table — see
 * computeTrailProgress), then writes Strava descriptions for matched
 * activities if the user has opted in. Safe to call multiple times.
 */
export async function finishSync(
  userId: string,
  newDbIds: string[]
): Promise<{ matchedTrails: number; descUpdated: number }> {
  let matchedTrails = 0;
  let descUpdated = 0;

  if (newDbIds.length === 0) return { matchedTrails, descUpdated };

  const { rows: [userPrefs] } = await pool.query<{
    strava_description_updates: boolean;
    description_mode: DescriptionMode;
  }>(
    "SELECT strava_description_updates, description_mode FROM users WHERE id = $1",
    [userId]
  );
  const wantsDescriptionUpdate = userPrefs?.strava_description_updates ?? false;

  // Delta of user_trail_progress.completed_distance across this batch's
  // computeTrailProgress call, per trail — see snapshotTrailProgress's
  // comment for why this reuses that computation instead of a separate
  // (and, confirmed in production, far too expensive) geometric recompute.
  // One map shared across every activity in this batch: if two brand-new
  // activities in the same sync chunk both touch the same trail, this
  // can't tell which one contributed which share of the combined delta,
  // so both end up reporting the batch's whole new-ground total for that
  // trail rather than a precise per-activity split. Rare in practice (most
  // syncs/webhook events involve one activity at a time) and not worth the
  // complexity of per-activity re-matching to fix.
  let newGroundByTrailId = new Map<string, number>();

  try {
    const { rows: nearbyTrails } = await pool.query<{ id: string }>(
      `SELECT DISTINCT t.id
       FROM activities a
       JOIN trails t ON t.simplified_geometry && ST_Expand(a.geometry, ${NEARBY_TRAILS_BBOX_DEGREES})
       WHERE a.id = ANY($1::uuid[]) AND a.geometry IS NOT NULL`,
      [newDbIds]
    );
    const allTrailIds = nearbyTrails.map((r) => r.id);
    const trailIds = allTrailIds.slice(0, MAX_TRAILS_PER_FINISH_SYNC);
    logSyncEvent(userId, "matching_triggered", {
      newActivities: newDbIds.length,
      nearbyTrails: allTrailIds.length,
      processing: trailIds.length,
      deferred: allTrailIds.length - trailIds.length,
    });
    const beforeSnapshot = wantsDescriptionUpdate
      ? await snapshotTrailProgress(userId, trailIds)
      : new Map<string, number>();
    if (trailIds.length > 0) {
      matchedTrails = await computeTrailProgress(userId, trailIds);
    }
    if (wantsDescriptionUpdate) {
      const afterSnapshot = await snapshotTrailProgress(userId, trailIds);
      newGroundByTrailId = new Map(
        trailIds.map((id) => [id, Math.max(0, (afterSnapshot.get(id) ?? 0) - (beforeSnapshot.get(id) ?? 0))])
      );
    }
    logSyncEvent(userId, "matching_complete", { matchedTrails });

    // Anomaly check: this batch of new activities had geometry and sat near
    // at least one trail, but produced zero progress rows — worth a flag to
    // review even though it's not always wrong (e.g. the activity's actual
    // GPS track legitimately never gets within the 50m trail buffer despite
    // the coarser pre-filter finding it nearby).
    if (trailIds.length > 0 && matchedTrails === 0) {
      logSyncEvent(userId, "sync_anomaly", {
        reason: "activities_near_trails_but_zero_matches",
        newActivities: newDbIds.length,
        nearbyTrails: trailIds.length,
      });
    }
  } catch (err) {
    console.error("[sync-engine] finishSync matching error:", err);
    logSyncEvent(userId, "matching_error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (wantsDescriptionUpdate) {
    const mode: DescriptionMode = userPrefs.description_mode ?? "full";
    const { rows: toUpdate } = await pool.query<{ id: string; strava_activity_id: string }>(
      `SELECT id, strava_activity_id::text
       FROM activities
       WHERE id = ANY($1::uuid[])
         AND geometry IS NOT NULL
         AND strava_description_updated = FALSE`,
      [newDbIds]
    );
    for (const act of toUpdate) {
      try {
        const matches = await getActivityTrailMatches(userId, act.id, newGroundByTrailId);
        // new_trail_distance_m is derived from this activity's own (permanent)
        // start_date relative to the user's other activities, so this result
        // can never change later — safe to mark checked whenever there's
        // nothing to write, whether that's no trail overlap at all or (in
        // new_only/new_with_totals) no new ground on any matched trail.
        const relevantMatches = mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > 0);
        if (relevantMatches.length > 0) {
          const updated = await writeTrailDescription(userId, act.id, parseInt(act.strava_activity_id), matches, mode);
          if (updated) descUpdated++;
        } else {
          await pool.query("UPDATE activities SET strava_description_updated = TRUE WHERE id = $1", [act.id]).catch(() => {});
        }
      } catch (err) {
        if (err instanceof ScopeError) {
          console.warn("[sync-engine] Scope error updating description — skipping:", err.message);
          break;
        }
        if (err instanceof StravaRateLimitError) {
          console.warn("[sync-engine] Strava rate limit hit — stopping description updates for this sync:", err.message);
          break;
        }
        console.error("[sync-engine] Description update error:", err);

        // Same bounded-retry give-up as update-descriptions' backlog scan —
        // shares the same counter on the activity row, so an activity that
        // fails here first still stops getting retried once the backlog
        // scan (or a future sync) picks it up.
        const { giveUp } = await recordDescriptionUpdateFailure(userId, act.id).catch(() => ({ giveUp: false }));
        if (giveUp) {
          await pool.query("UPDATE activities SET strava_description_updated = TRUE WHERE id = $1", [act.id]).catch(() => {});
        }
      }
    }
  }

  return { matchedTrails, descUpdated };
}
