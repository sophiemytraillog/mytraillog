import { pool } from "@/lib/db";
import { CYCLING_ACTIVITY_TYPES } from "@/lib/strava";

const BUFFER_METRES = 50;
// ST_SimplifyPreserveTopology(geom, 0.001) can move points by up to ~111 m.
// Use a wider pre-filter so activities near the real trail aren't excluded by
// the simplified geometry cutting across headlands or tight coastal bends.
const SIMPLIFY_MARGIN = 200;

const MATCH_SQL = `
  WITH
  -- Union all activity buffers into one polygon so overlapping runs don't double-count.
  -- Uses simplified trail for the spatial filter only (performance) — NOT for geometry output.
  -- Pre-filter uses BUFFER_METRES + SIMPLIFY_MARGIN to account for simplification distortion;
  -- the actual 50 m buffer (ST_Buffer below) determines what counts as "on the trail".
  combined_buffer AS (
    SELECT
      ST_Union(ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry) AS geom,
      COUNT(DISTINCT a.id)  AS activity_count,
      MIN(a.start_date)     AS first_date,
      MAX(a.start_date)     AS last_date
    FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
          FROM trails WHERE id = $2) t_simplified
    JOIN activities a
      ON  a.user_id = $1
      AND a.geometry IS NOT NULL
      -- All activity types are stored regardless of the include_cycling
      -- preference; it's applied here, at match time, instead.
      AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
  ),
  -- Intersect the merged buffer with the FULL detailed trail geometry so that
  -- stored completed sections follow the exact GPX path, not a simplified approximation.
  coverage AS (
    SELECT
      t.id             AS trail_id,
      t.total_distance,
      ST_CollectionExtract(
        ST_Intersection(t.geometry, cb.geom),
        2
      )                AS covered_geom,
      cb.activity_count,
      cb.first_date,
      cb.last_date
    FROM (SELECT id, total_distance, geometry
          FROM trails WHERE id = $2) t
    CROSS JOIN combined_buffer cb
    WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
  )
  INSERT INTO user_trail_progress (
    user_id, trail_id,
    completed_distance, completion_percentage,
    completed_geometry,
    activity_count, first_activity_date, last_activity_date
  )
  SELECT
    $1, trail_id,
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0
         ELSE ST_Length(covered_geom::geography) END,
    LEAST(
      CASE WHEN total_distance > 0
           THEN ST_Length(covered_geom::geography) / total_distance * 100
           ELSE 0 END,
      100
    ),
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
         ELSE ST_SetSRID(ST_Multi(covered_geom), 4326)::geometry(MultiLineString,4326) END,
    activity_count, first_date, last_date
  FROM coverage
  WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
  ON CONFLICT (user_id, trail_id) DO UPDATE SET
    completed_distance    = EXCLUDED.completed_distance,
    completion_percentage = EXCLUDED.completion_percentage,
    completed_geometry    = EXCLUDED.completed_geometry,
    activity_count        = EXCLUDED.activity_count,
    first_activity_date   = EXCLUDED.first_activity_date,
    last_activity_date    = EXCLUDED.last_activity_date,
    updated_at            = NOW()
  RETURNING trail_id`;

// Populates the description-update candidate cache (see schema.sql) for a
// trail that just got a coverage row. Same simplified-geometry pre-filter as
// combined_buffer above — a coarse candidate list is fine here because
// getActivityTrailMatches re-verifies the exact overlap at write time.
const ACTIVITY_MATCH_SQL = `
  INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
  SELECT DISTINCT a.id, $2::uuid, $1::uuid
  FROM activities a
  CROSS JOIN (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
              FROM trails WHERE id = $2::uuid) t_simplified
  WHERE a.user_id = $1::uuid
    AND a.geometry IS NOT NULL
    AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
    AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
  ON CONFLICT (activity_id, trail_id) DO NOTHING`;

/**
 * Cheap indexed lookup of user_trail_progress.completed_distance for a set
 * of trails — no geometry involved. Callers take one snapshot right before
 * computeTrailProgress and another right after; the delta is exactly "how
 * much new ground got added by whatever activities computeTrailProgress
 * just merged in", which trail-descriptions.ts's getActivityTrailMatches
 * uses as an exact new_trail_distance_m instead of recomputing it via a
 * separate (and, confirmed in production, far too expensive) geometric
 * union — see the comment there for what that cost.
 */
export async function snapshotTrailProgress(
  userId: string,
  trailIds: string[]
): Promise<Map<string, number>> {
  if (trailIds.length === 0) return new Map();
  const { rows } = await pool.query<{ trail_id: string; completed_distance: number }>(
    `SELECT trail_id, completed_distance FROM user_trail_progress
     WHERE user_id = $1 AND trail_id = ANY($2::uuid[])`,
    [userId, trailIds]
  );
  return new Map(rows.map((r) => [r.trail_id, r.completed_distance]));
}

/**
 * Isolates ONE activity's true unique contribution to a trail's coverage —
 * used by trail-descriptions.ts's getActivityTrailMatches when no
 * before/after snapshot is available (the deferred description-writing
 * path: the automatic chain, the daily drain, the cron sweep, the manual
 * "Update historical activity descriptions" button — anywhere matching
 * already finished at some EARLIER point, not in the same call as the
 * write). That fallback used to just report the activity's whole raw
 * overlap with the trail as "new ground" — correct only the first time a
 * route is ever run, wrong every time after. Root-caused via Dave Chase's
 * second report, 2026-08-21: "Giving it some welly" was written through
 * the new automatic chain and reported 907.8m new on South Downs Way; his
 * other 506 activities near that trail already covered the exact same
 * stretch, so the true new-ground contribution was 0m.
 *
 * Deliberately NOT a full re-run of MATCH_SQL's combined-buffer approach
 * with this activity excluded then re-included (would be redoing the same
 * multi-minute-for-a-busy-account computation getActivityTrailMatches was
 * built to avoid in the first place) — this computes only ONE side
 * (coverage from every OTHER activity near this trail) and subtracts it
 * from the trail's already-known, already-cheap-to-read current
 * completed_distance, rather than recomputing the "with this activity"
 * side too. Still a real geometric union over however many other
 * activities are nearby, so it's wrapped in the same statement_timeout
 * safety net computeTrailProgress uses for expensive trails — a timeout or
 * any other failure here returns 0 (safe: undercounts a genuinely-new
 * stretch rather than repeating the original bug of overcounting old
 * ground) instead of throwing and losing the whole description write.
 */
export async function computeNewGroundExcludingActivity(
  userId: string,
  activityId: string,
  trailId: string,
  currentCompletedDistanceM: number
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '20000'");
    const { rows: [row] } = await client.query<{ covered_m: number }>(
      `WITH combined_buffer AS (
         SELECT ST_Union(ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry) AS geom
         FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry FROM trails WHERE id = $2) t_simplified
         JOIN activities a
           ON a.user_id = $1 AND a.id != $3 AND a.geometry IS NOT NULL
           AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
       )
       SELECT COALESCE(
         ST_Length(ST_CollectionExtract(ST_Intersection(t.geometry, cb.geom), 2)::geography),
         0
       ) AS covered_m
       FROM (SELECT geometry FROM trails WHERE id = $2) t
       CROSS JOIN combined_buffer cb`,
      [userId, trailId, activityId]
    );
    await client.query("COMMIT");
    const coveredByOthers = row?.covered_m ?? 0;
    return Math.max(0, currentCompletedDistanceM - coveredByOthers);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[match-trails] computeNewGroundExcludingActivity failed for activity ${activityId}, trail ${trailId}:`,
      err
    );
    return 0;
  } finally {
    client.release();
  }
}

export async function computeTrailProgress(userId: string, trailIds?: string[]): Promise<number> {
  const { rows: [userPrefs] } = await pool.query<{ include_cycling: boolean }>(
    "SELECT include_cycling FROM users WHERE id = $1",
    [userId]
  );
  const includeCycling = userPrefs?.include_cycling ?? false;
  const cyclingTypes = Array.from(CYCLING_ACTIVITY_TYPES);

  const { rows: trails } = trailIds && trailIds.length > 0
    ? await pool.query<{ id: string }>(
        "SELECT id FROM trails WHERE id = ANY($1::uuid[]) ORDER BY name",
        [trailIds]
      )
    : await pool.query<{ id: string }>("SELECT id FROM trails ORDER BY name");

  let matched = 0;

  for (const trail of trails) {
    const client = await pool.connect();
    // Remove any listener left over from a previous iteration (pool reuses client objects).
    client.removeAllListeners("error");
    client.on("error", (err) => {
      console.error(`[match-trails] Client error on trail ${trail.id}:`, err.message);
    });
    try {
      // Wrap in an explicit transaction so SET LOCAL is pinned to the same
      // backend connection through Supabase's transaction-mode pooler.
      // Without BEGIN, SET LOCAL fires on backend A and MATCH_SQL runs on
      // backend B (which still has the global 2-minute cap).
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '180000'"); // 3 min
      const result = await client.query<{ trail_id: string }>(MATCH_SQL, [
        userId,
        trail.id,
        includeCycling,
        cyclingTypes,
      ]);
      await client.query("COMMIT");

      const wasMatched = (result.rowCount ?? 0) > 0;
      if (wasMatched) {
        matched++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL statement_timeout = '180000'"); // 3 min — some trails (e.g. South West Coast Path) are huge
          await client.query(ACTIVITY_MATCH_SQL, [userId, trail.id, includeCycling, cyclingTypes]);
          await client.query(
            "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
            [userId, trail.id]
          );
          await client.query("COMMIT");
        } catch (err) {
          console.error(`[match-trails] activity_trail_matches for trail ${trail.id} failed:`, err);
          await client.query("ROLLBACK").catch(() => {});
        }
      }

      // Record that this pair was actually attempted, regardless of outcome
      // — a legitimate zero-overlap trail never gets a user_trail_progress
      // row (see MATCH_SQL's WHERE covered_geom IS NOT NULL), so without
      // this a full-account sweep can't tell "checked, no match" apart from
      // "never checked" and would needlessly recheck it forever. Best-effort:
      // a failure here shouldn't undo the matching work that just succeeded.
      await pool.query(
        `INSERT INTO trail_match_checks (user_id, trail_id, matched)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, trail_id) DO UPDATE SET matched = EXCLUDED.matched, checked_at = NOW()`,
        [userId, trail.id, wasMatched]
      ).catch((err) => {
        console.error(`[match-trails] Failed to record trail_match_checks for trail ${trail.id}:`, err.message);
      });
    } catch (err) {
      console.error(`[match-trails] Trail ${trail.id} failed:`, err);
      await client.query("ROLLBACK").catch(() => {});
      // Deliberately NOT checkpointed — this trail genuinely wasn't
      // processed, so it should be retried on the next sweep rather than
      // silently treated as done.
    } finally {
      client.release();
    }
  }

  return matched;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const BATCH_MAX_ATTEMPTS = 3;
const BATCH_RETRY_DELAY_MS = 1_500;

// computeTrailProgress already catches every per-trail error internally and
// never throws — it just logs and moves on — so a caller can't tell success
// from failure via try/catch. trail_match_checks is only written on the
// success path above, so its presence after the call IS the success signal:
// retry until it appears, up to BATCH_MAX_ATTEMPTS, with a short backoff for
// transient connection drops to actually clear before retrying.
async function attemptTrailWithRetry(userId: string, trailId: string): Promise<{ ok: boolean; matched: boolean }> {
  for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
    await computeTrailProgress(userId, [trailId]);
    const { rows } = await pool.query<{ matched: boolean }>(
      "SELECT matched FROM trail_match_checks WHERE user_id = $1 AND trail_id = $2",
      [userId, trailId]
    );
    if (rows.length > 0) return { ok: true, matched: rows[0].matched };
    if (attempt < BATCH_MAX_ATTEMPTS) await sleep(BATCH_RETRY_DELAY_MS);
  }
  return { ok: false, matched: false };
}

export interface MatchBatchResult {
  checkedThisBatch: number;
  matchedThisBatch: number;
  totalChecked: number;
  totalTrails: number;
  done: boolean;
}

// Same bbox tolerance as sync-engine.ts's NEARBY_TRAILS_BBOX_DEGREES —
// see that file's comment for why plain geometry `&&` against
// simplified_geometry (not ST_DWithin/::geography) is what actually uses
// the GIST index here.
const STALE_CHECK_BBOX_DEGREES = 0.003;

// Processes up to `limit` trails for one user, National Trails first (the
// ~20 of 1,181 users actually look for). "Needs checking" means either
// never checked, OR checked before an activity that's now spatially near
// it was added — see the STALE clause below for why that second case is
// essential, not an edge case.
//
// Root cause of the recurring "activities clearly overlap this trail but
// completed_distance/completion_percentage sit at zero" reports (David,
// Paul, and now Chris Rance's South Downs Way, 2026-08-19): every one of
// this table's readers — this function, the old duplicated versions in
// admin/rematch and the cron sweep — treated trail_match_checks as a
// permanent, one-time verdict. It isn't. A trail legitimately gets
// matched=false when it's checked before the relevant activity has synced
// yet (confirmed for Chris: all 23 activities that overlap South Downs Way
// were inserted 22-29 minutes AFTER a rematch pass had already checked it
// and moved on) — sync and matching sweeps run concurrently by design (the
// dashboard's own TrailMatchProgress starts sweeping immediately, not
// waiting for an in-flight sync to finish), so this isn't a rare race, it's
// an expected outcome that nothing ever revisited. The STALE clause below
// re-surfaces exactly those trails: NOT "recheck everything whenever
// anything changes" (which would re-run the expensive MATCH_SQL union
// against all ~1,180 trails every single sync, for every user), but "only
// this trail, only if a new activity landed within its own bbox" — the
// same cheap, indexed `&&` pre-filter finishSync already uses to find
// candidates for brand-new activities, just applied to already-checked
// trails too instead of only ever-unchecked ones.
export async function matchNextBatch(
  userId: string,
  limit: number,
  timeBudgetMs?: number
): Promise<MatchBatchResult> {
  const startedAt = Date.now();

  const { rows: candidates } = await pool.query<{ id: string }>(
    `SELECT t.id
     FROM trails t
     LEFT JOIN trail_match_checks c ON c.user_id = $1 AND c.trail_id = t.id
     WHERE c.trail_id IS NULL
        OR EXISTS (
          SELECT 1 FROM activities a
          WHERE a.user_id = $1
            AND a.geometry IS NOT NULL
            AND a.created_at > c.checked_at
            AND t.simplified_geometry && ST_Expand(a.geometry, ${STALE_CHECK_BBOX_DEGREES})
        )
     ORDER BY (t.category = 'national_trail') DESC, t.name ASC
     LIMIT $2`,
    [userId, limit]
  );

  let checkedThisBatch = 0;
  let matchedThisBatch = 0;
  const stillFailing: string[] = [];

  for (const trail of candidates) {
    if (timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trail.id);
    if (ok) {
      checkedThisBatch++;
      if (matched) matchedThisBatch++;
    } else {
      stillFailing.push(trail.id);
    }
  }

  // Same pattern as computeTrailProgress's own caller loops elsewhere: a
  // trail that failed because of a transient blip earlier in this call may
  // well succeed a few seconds later, worth one more try before giving up
  // for this call.
  for (const trailId of stillFailing) {
    if (timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trailId);
    if (ok) {
      checkedThisBatch++;
      if (matched) matchedThisBatch++;
    }
  }

  const { rows: [totals] } = await pool.query<{ total: string; checked: string }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked`,
    [userId]
  );
  const totalTrails = parseInt(totals.total);
  const totalChecked = parseInt(totals.checked);

  return {
    checkedThisBatch,
    matchedThisBatch,
    totalChecked,
    totalTrails,
    done: totalChecked >= totalTrails,
  };
}

export async function getMatchProgress(userId: string): Promise<{ totalChecked: number; totalTrails: number }> {
  const { rows: [totals] } = await pool.query<{ total: string; checked: string }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked`,
    [userId]
  );
  return { totalTrails: parseInt(totals.total), totalChecked: parseInt(totals.checked) };
}
