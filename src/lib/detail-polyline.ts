import type { Pool } from "pg";
import { pool } from "@/lib/db";
import { getValidAccessToken, decodePolylineToWKT } from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

/**
 * Backfills the full-resolution GPS track for activities long enough that
 * Strava's summary_polyline (all a normal sync ever gets — see
 * sync-engine.ts's savePage) is too coarse to trail-match accurately.
 *
 * Root-caused 2026-09-30 investigating Luke Davis's Hadrian's Wall Path:
 * his one matched activity was a 170km/34hr walk (an 84-mile thru-hike
 * logged as a single continuous Strava entry) whose summary_polyline had
 * only 156 points — about one per kilometre, against the trail's own
 * 2,328-point reference geometry (~one per 59m). Strava encodes
 * summary_polyline with a fixed point budget regardless of distance, so the
 * longer/more winding the route, the coarser it gets — straight-line
 * chords between such sparse points cut across nearly every bend in a real
 * trail, and computeTrailProgress's 50m match buffer (match-trails.ts)
 * genuinely doesn't reach those cut corners even when the hiker's actual
 * route never left the trail. Confirmed directly: recomputing the
 * intersection against the CURRENT (summary-derived) geometry reproduced
 * the exact 74.02% completion the dashboard showed — the matching logic
 * itself wasn't wrong, the input geometry was just too coarse.
 *
 * The fix: `GET /activities/{id}` (the per-activity detail endpoint, never
 * called during a normal list-endpoint sync) returns a full-resolution
 * `map.polyline` instead of `map.summary_polyline`. This module fetches
 * that, swaps it in, and recomputes progress for whichever trails are near
 * the activity — for anything over LONG_ACTIVITY_DISTANCE_M
 * (strava.ts, 50km).
 */

const MAX_DETAIL_POLYLINE_ATTEMPTS = 3;

async function fetchWithTimeout(url: string, options: RequestInit, ms = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface StravaActivityDetail {
  map?: { polyline?: string | null; summary_polyline?: string | null } | null;
}

export type DetailPolylineOutcome =
  | "success"
  | "no_geometry" // Strava returned no usable polyline at all (manual entry, privacy zone) — nothing more to fetch.
  | "not_found" // activity deleted on Strava since it was synced
  | "scope_error" // activity:read_all grant gone — needs reconnect, same as description writes
  | "rate_limited" // caller should stop the whole batch, not just this activity
  | "error";

export interface DetailPolylineResult {
  outcome: DetailPolylineOutcome;
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * One Strava API call: GET /activities/{id}, extract the full-resolution
 * polyline. A single retry with a guaranteed-fresh token on 401/403 — same
 * shape as trail-descriptions.ts's fetchStravaWithReauthRetry, just not
 * sharing its implementation directly (that one lives in a module this
 * shouldn't import from — sync-engine.ts already depends on both, and a
 * detail-polyline <-> trail-descriptions circular import isn't worth
 * introducing for one retry loop), so a real revoked grant still only takes
 * two attempts to confirm, not endless retries.
 */
export async function fetchDetailPolyline(
  userId: string,
  stravaActivityId: string
): Promise<DetailPolylineResult & { wkt?: string | null; rawPolyline?: string | null }> {
  const call = async (token: string) =>
    fetchWithTimeout(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  try {
    let token = await getValidAccessToken(userId);
    let res = await call(token);

    if (res.status === 401 || res.status === 403) {
      token = await getValidAccessToken(userId, true);
      res = await call(token);
    }

    if (res.status === 429) {
      const retryAfterSeconds = parseInt(res.headers.get("Retry-After") ?? "900");
      return { outcome: "rate_limited", retryAfterSeconds };
    }
    if (res.status === 401 || res.status === 403) {
      return { outcome: "scope_error", message: `HTTP ${res.status}` };
    }
    if (res.status === 404 || res.status === 410) {
      return { outcome: "not_found" };
    }
    if (!res.ok) {
      return { outcome: "error", message: `HTTP ${res.status}: ${await res.text()}` };
    }

    const body = (await res.json()) as StravaActivityDetail;
    // Full-resolution field first, summary as a last resort — same
    // preference order as strava.ts's own selectPolyline, just with the
    // roles reversed from a normal sync since the whole point of this call
    // is to get the field the list endpoint never provides.
    const rawPolyline = body.map?.polyline || body.map?.summary_polyline || null;
    const wkt = decodePolylineToWKT(rawPolyline);
    if (!wkt) return { outcome: "no_geometry" };
    return { outcome: "success", wkt, rawPolyline };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// Same bbox pre-filter convention used everywhere else in this codebase
// (sync-engine.ts's NEARBY_TRAILS_BBOX_DEGREES, match-trails.ts's
// STALE_CHECK_BBOX_DEGREES) — plain geometry `&&` against
// trails.simplified_geometry uses the GIST index.
const NEARBY_TRAILS_BBOX_DEGREES = 0.003;

/**
 * Applies one activity's detail-polyline fetch: updates its stored
 * geometry on success, checkpoints needs_detail_polyline/attempts either
 * way, and — only on success, since nothing changed otherwise — recomputes
 * user_trail_progress for whichever trails are near it. Safe to call
 * multiple times (checkpointed the same way as everything else in this
 * pipeline).
 */
export async function applyDetailPolyline(
  userId: string,
  activityDbId: string,
  stravaActivityId: string,
  dbPool: Pool = pool
): Promise<DetailPolylineResult & { trailsRecomputed?: number }> {
  const result = await fetchDetailPolyline(userId, stravaActivityId);

  if (result.outcome === "rate_limited") return result;

  if (result.outcome === "scope_error") {
    // Left queued (needs_detail_polyline stays TRUE) — same reasoning as
    // trail-descriptions.ts's needs_reauth flag: this is a revoked grant,
    // not a broken activity, so retrying it endlessly here would be noise;
    // it naturally becomes fetchable again once the user reconnects (which
    // always re-requests the read scope this needs — strava/callback/route.ts).
    await dbPool.query("UPDATE users SET needs_reauth = TRUE WHERE id = $1", [userId]).catch(() => {});
    return result;
  }

  if (result.outcome === "error") {
    const { rows } = await dbPool.query<{ detail_polyline_attempts: number }>(
      `UPDATE activities SET detail_polyline_attempts = detail_polyline_attempts + 1
       WHERE id = $1 RETURNING detail_polyline_attempts`,
      [activityDbId]
    );
    const attempts = rows[0]?.detail_polyline_attempts ?? MAX_DETAIL_POLYLINE_ATTEMPTS;
    if (attempts >= MAX_DETAIL_POLYLINE_ATTEMPTS) {
      // Give up — same bounded-retry give-up pattern as
      // recordDescriptionUpdateFailure, so a permanently-failing activity
      // (e.g. Strava persistently 500ing on GET for it) doesn't sit at the
      // front of this queue forever, blocking every activity behind it.
      await dbPool.query(
        `UPDATE activities SET needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW() WHERE id = $1`,
        [activityDbId]
      );
      logSyncEvent(userId, "detail_polyline_abandoned", { activityId: activityDbId, attempts, message: result.message });
    }
    return result;
  }

  // not_found / no_geometry: nothing left to fetch for this activity —
  // checkpoint it done, no further attempts.
  if (result.outcome === "not_found" || result.outcome === "no_geometry") {
    await dbPool.query(
      `UPDATE activities SET needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW() WHERE id = $1`,
      [activityDbId]
    );
    return result;
  }

  // success
  await dbPool.query(
    `UPDATE activities
     SET polyline = $2, geometry = ST_GeomFromText($3, 4326),
         needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW()
     WHERE id = $1`,
    [activityDbId, result.rawPolyline, result.wkt]
  );

  // The activity's geometry just changed, so any trail progress computed
  // from the OLD (coarse) geometry is stale — recompute exactly the trails
  // near it, same discovery query finishSync uses for a freshly-synced
  // activity (sync-engine.ts), not a full-catalog rematch.
  const { rows: nearbyTrails } = await dbPool.query<{ id: string }>(
    `SELECT t.id FROM activities a
     JOIN trails t ON t.simplified_geometry && ST_Expand(a.geometry, ${NEARBY_TRAILS_BBOX_DEGREES})
     WHERE a.id = $1 AND a.geometry IS NOT NULL`,
    [activityDbId]
  );
  const trailIds = nearbyTrails.map((r) => r.id);
  if (trailIds.length > 0) {
    await computeTrailProgress(userId, trailIds, dbPool);
  }

  return { ...result, trailsRecomputed: trailIds.length };
}

export interface DetailPolylineBatchResult {
  checkedThisBatch: number;
  succeededThisBatch: number;
  remaining: number;
  done: boolean;
  rateLimited: boolean;
}

// Small delay between Strava calls within a batch — this endpoint isn't
// covered by the description drain's own reserveBackfillSlot quota (a
// separate, cheap, low-volume use of the API), but a bare loop with no
// pacing at all is still worth avoiding given how many other things in this
// app already share Strava's per-app rate limit.
const DETAIL_POLYLINE_CALL_DELAY_MS = 300;

/**
 * One bounded batch of a single user's detail-polyline backlog — same
 * "checked/succeeded/remaining/done" shape as match-trails.ts's
 * MatchBatchResult and trail-descriptions.ts's DescriptionBatchResult, for
 * the same reason: every batch primitive in this codebase reports progress
 * the same way so callers (the external drain, an admin action, a
 * one-off script) can all loop on it identically.
 */
export async function processDetailPolylineBatch(
  userId: string,
  limit: number,
  timeBudgetMs: number,
  dbPool: Pool = pool
): Promise<DetailPolylineBatchResult> {
  const startedAt = Date.now();

  // Longest activities first — they're the ones whose summary_polyline is
  // worst-affected (see this module's doc comment), so a batch that only
  // gets partway through a user's backlog still fixes the biggest
  // inaccuracies first.
  const { rows: candidates } = await dbPool.query<{ id: string; strava_activity_id: string }>(
    `SELECT id, strava_activity_id::text FROM activities
     WHERE user_id = $1 AND needs_detail_polyline = TRUE
     ORDER BY distance DESC
     LIMIT $2`,
    [userId, limit]
  );

  let checkedThisBatch = 0;
  let succeededThisBatch = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (Date.now() - startedAt > timeBudgetMs) break;
    if (i > 0) await sleep(DETAIL_POLYLINE_CALL_DELAY_MS);

    const result = await applyDetailPolyline(userId, candidates[i].id, candidates[i].strava_activity_id, dbPool);
    if (result.outcome === "rate_limited") {
      return {
        checkedThisBatch,
        succeededThisBatch,
        remaining: candidates.length - i,
        done: false,
        rateLimited: true,
      };
    }
    checkedThisBatch++;
    if (result.outcome === "success") succeededThisBatch++;
  }

  const { rows: [remainingRow] } = await dbPool.query<{ c: string }>(
    `SELECT COUNT(*) c FROM activities WHERE user_id = $1 AND needs_detail_polyline = TRUE`,
    [userId]
  );
  const remaining = parseInt(remainingRow.c);

  return { checkedThisBatch, succeededThisBatch, remaining, done: remaining === 0, rateLimited: false };
}

// ── External-scheduler drain (mirrors match-chain.ts's
// runExternalMatchDrainBatch / description-chain.ts's runExternalDrainBatch
// — same reasoning: one bounded HTTP call in, one JSON result out, no
// self-dispatch, safe for an external scheduler on a tight interval since
// there's no shared invocation lineage to trip Vercel's loop-detection
// protection). Wired into drain-batch/route.ts as a fourth phase on the
// same already-proven external cadence, rather than inventing a new
// scheduler or a new self-dispatch chain with its own hop-limit/pooler
// failure modes to work around. ─────────────────────────────────────────
const EXTERNAL_DRAIN_BATCH_SIZE = 5;

// Uses the shared `pool`, not a dedicated batch pool — this drain's call
// volume is far lower than the match/description drains (only activities
// over 50km ever enter its queue), so no evidence yet it needs the same
// pooler-contention workaround match-chain.ts and sync-chain.ts needed for
// their much higher-frequency sweeps.
async function pickNextDetailPolylineDrainCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  const { rows } = await pool.query<{ id: string; first_name: string | null }>(
    `SELECT u.id, u.first_name
     FROM users u
     WHERE EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id AND a.needs_detail_polyline = TRUE)
       AND u.subscription_status IN ('trial', 'active')
     ORDER BY COALESCE(
       (SELECT MAX(s.created_at) FROM sync_log s
        WHERE s.user_id = u.id AND s.event = 'detail_polyline_drain'),
       '-infinity'
     ) ASC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export interface ExternalDetailPolylineDrainResult {
  candidateId: string | null;
  checkedThisBatch: number;
  succeededThisBatch: number;
  done: boolean;
  timedOut: boolean;
}

export async function runExternalDetailPolylineDrainBatch(
  timeBudgetMs: number
): Promise<ExternalDetailPolylineDrainResult> {
  const candidate = await pickNextDetailPolylineDrainCandidate();
  if (!candidate) {
    return { candidateId: null, checkedThisBatch: 0, succeededThisBatch: 0, done: true, timedOut: false };
  }

  // Same hard Promise.race hardening as runExternalMatchDrainBatch — this
  // batch's own timeBudgetMs is only checked BETWEEN activities, never
  // during Strava's own response time, so a slow/hanging call could
  // otherwise blow past whatever's left of drain-batch's shared request
  // budget and risk the same orphaned-call FUNCTION_INVOCATION_TIMEOUT
  // regression that pattern was built to prevent.
  const batchPromise = processDetailPolylineBatch(candidate.id, EXTERNAL_DRAIN_BATCH_SIZE, timeBudgetMs)
    .then((result) => ({ timedOut: false as const, result }))
    .catch((err) => ({ timedOut: false as const, error: err as unknown }));

  const outcome = await Promise.race([
    batchPromise,
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), timeBudgetMs)),
  ]);

  logSyncEvent(candidate.id, "detail_polyline_drain", {
    triggeredBy: "external-detail-polyline-drain",
    ...(outcome.timedOut
      ? { outcome: "timed_out" }
      : "error" in outcome
        ? { outcome: "hard_failure", message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }
        : { outcome: "completed", ...outcome.result }),
  });

  if (outcome.timedOut) {
    console.warn(`[external-detail-polyline-drain] Timed out after ${timeBudgetMs}ms for ${candidate.first_name ?? candidate.id}`);
    return { candidateId: candidate.id, checkedThisBatch: 0, succeededThisBatch: 0, done: false, timedOut: true };
  }
  if ("error" in outcome) {
    console.error(`[external-detail-polyline-drain] Batch failed for ${candidate.first_name ?? candidate.id}:`, outcome.error);
    logSyncEvent(ADMIN_USER_ID, "external_detail_polyline_drain_batch", {
      outcome: "hard_failure",
      candidateId: candidate.id,
    });
    return { candidateId: candidate.id, checkedThisBatch: 0, succeededThisBatch: 0, done: false, timedOut: false };
  }

  const { result } = outcome;
  return {
    candidateId: candidate.id,
    checkedThisBatch: result.checkedThisBatch,
    succeededThisBatch: result.succeededThisBatch,
    done: false,
    timedOut: false,
  };
}
