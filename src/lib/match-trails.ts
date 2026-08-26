import type { Pool } from "pg";
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

// Two activities' 50 m buffers can only geometrically overlap if their raw
// paths pass within 100 m (50+50) of each other — 150 m adds margin for
// curvature/simplification slack without pulling in anything that couldn't
// possibly share coverage with the target activity.
const LOCAL_VICINITY_METRES = 150;

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
 * Computes coverage from every OTHER activity NEAR THIS ONE (not near the
 * trail as a whole) and subtracts it from this activity's own trail
 * overlap directly. Root cause this replaces (2026-08-22): the previous
 * version unioned every other activity within range of the ENTIRE trail —
 * correct, but on a long trail (South West Coast Path, 1,014 km) a
 * busy account's full activity history near that trail (Sophie Davis: 22)
 * all had to be re-unioned for every single description write, however far
 * from THIS activity they actually were. That union routinely exceeded
 * both the 20s statement_timeout below and, cascading from there, the
 * Vercel request's own 60s ceiling — confirmed in production logs timing
 * out inside this function for Sophie's "Morning Run".
 *
 * Restricting "other activities" to LOCAL_VICINITY_METRES of THIS activity
 * (rather than of the trail) is mathematically equivalent, not an
 * approximation: this activity's own 50 m buffer can't extend past that
 * radius, so any activity further away literally cannot share coverage
 * with it regardless of how large or small the account's total activity
 * count is. The candidate set this filters against scales with how many
 * OTHER activities happen to run right past this one spot — not with the
 * trail's length or the account's total history — so this stays fast
 * whether an account has 20 activities or 20,000.
 *
 * NEARBY_OTHERS_LIMIT caps that candidate set further, for the case the
 * radius restriction alone doesn't cover: a user who repeats the exact
 * same popular route often enough that hundreds of their OWN activities
 * cluster within LOCAL_VICINITY_METRES of any one of them. Root-caused
 * 2026-08-26: Paul Crowe's "Happy Heartiversary to me" sits at a spot with
 * 792 of his own other activities within 150 m — ST_Union over that many
 * buffered geometries took 56s+ for one candidate trail alone, blowing
 * past this function's own 20s statement_timeout badly enough (Postgres's
 * cancel handshake itself isn't instant) to still exceed the whole
 * request's 60s ceiling before the write ever got a chance to checkpoint,
 * so every future drain hop re-picked the same doomed activity and never
 * made progress on anyone's backlog. If even a handful of a user's own
 * nearby-duplicate activities already cover a stretch, that's sufficient
 * signal — the 793rd near-identical loop isn't adding new information,
 * just cost. Ordering by recency (not distance — an extra ST_Distance sort
 * over hundreds of rows would reintroduce the same cost this is avoiding)
 * before capping is an arbitrary but reasonable tie-break: any bounded
 * subset of a large duplicate cluster is about as informative as any
 * other.
 *
 * Wrapped in the same statement_timeout safety net as before — a timeout
 * or any other failure here returns 0 (safe: undercounts a genuinely-new
 * stretch rather than repeating the original bug of overcounting old
 * ground) instead of throwing and losing the whole description write.
 */
const NEARBY_OTHERS_LIMIT = 30;
export async function computeNewGroundExcludingActivity(
  userId: string,
  activityId: string,
  trailId: string,
  dbPool: Pool = pool
): Promise<number> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    // Aligned with trail-descriptions.ts's ACTIVITY_NEW_GROUND_BUDGET_MS
    // (2026-08-26): that caller now abandons its wait on this call after
    // 15s regardless, via a race — this query keeps running server-side
    // past that point either way, so a shorter cap here just means the
    // abandoned query itself gets cleaned up sooner instead of lingering.
    await client.query("SET LOCAL statement_timeout = '15000'");
    const { rows: [row] } = await client.query<{ new_ground_m: number }>(
      `WITH this_activity AS (
         SELECT geometry FROM activities WHERE id = $3 AND user_id = $1
       ),
       this_coverage AS (
         SELECT ST_CollectionExtract(
           ST_Intersection(t.geometry, ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry),
           2
         ) AS geom
         FROM this_activity a
         CROSS JOIN (SELECT geometry FROM trails WHERE id = $2) t
       ),
       -- Only activities close enough to THIS one to possibly share
       -- coverage with it — not every activity near the trail. Capped at
       -- NEARBY_OTHERS_LIMIT (see doc comment above) so a spot this user
       -- revisits constantly doesn't union hundreds of near-duplicates.
       nearby_others_capped AS (
         SELECT o.geometry
         FROM activities o, this_activity a
         WHERE o.user_id = $1
           AND o.id != $3
           AND o.geometry IS NOT NULL
           AND ST_DWithin(o.geometry::geography, a.geometry::geography, ${LOCAL_VICINITY_METRES})
         ORDER BY o.start_date DESC
         LIMIT ${NEARBY_OTHERS_LIMIT}
       ),
       nearby_others AS (
         SELECT ST_Union(ST_Buffer(geometry::geography, ${BUFFER_METRES})::geometry) AS geom
         FROM nearby_others_capped
       )
       SELECT COALESCE(
         ST_Length(
           ST_Difference(
             tc.geom,
             COALESCE(no.geom, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))
           )::geography
         ),
         0
       ) AS new_ground_m
       FROM this_coverage tc
       CROSS JOIN nearby_others no`,
      [userId, trailId, activityId]
    );
    await client.query("COMMIT");
    return Math.max(0, row?.new_ground_m ?? 0);
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

export async function computeTrailProgress(
  userId: string,
  trailIds?: string[],
  dbPool: Pool = pool
): Promise<number> {
  const { rows: [userPrefs] } = await dbPool.query<{ include_cycling: boolean }>(
    "SELECT include_cycling FROM users WHERE id = $1",
    [userId]
  );
  const includeCycling = userPrefs?.include_cycling ?? false;
  const cyclingTypes = Array.from(CYCLING_ACTIVITY_TYPES);

  const { rows: trails } = trailIds && trailIds.length > 0
    ? await dbPool.query<{ id: string }>(
        "SELECT id FROM trails WHERE id = ANY($1::uuid[]) ORDER BY name",
        [trailIds]
      )
    : await dbPool.query<{ id: string }>("SELECT id FROM trails ORDER BY name");

  let matched = 0;

  for (const trail of trails) {
    const client = await dbPool.connect();
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
      await dbPool.query(
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
async function attemptTrailWithRetry(
  userId: string,
  trailId: string,
  dbPool: Pool
): Promise<{ ok: boolean; matched: boolean }> {
  for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
    await computeTrailProgress(userId, [trailId], dbPool);
    const { rows } = await dbPool.query<{ matched: boolean }>(
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
  // True if any trail in this batch failed every attempt — a signal to the
  // caller (specifically the drain hop) that the connection pool may be
  // under pressure and it's worth backing off before dispatching the next
  // hop, rather than immediately hammering again.
  hadFailures: boolean;
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
  timeBudgetMs?: number,
  dbPool: Pool = pool
): Promise<MatchBatchResult> {
  const startedAt = Date.now();

  const { rows: candidates } = await dbPool.query<{ id: string }>(
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
    const { ok, matched } = await attemptTrailWithRetry(userId, trail.id, dbPool);
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
  let stillFailingAfterRetry = 0;
  for (const trailId of stillFailing) {
    if (timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trailId, dbPool);
    if (ok) {
      checkedThisBatch++;
      if (matched) matchedThisBatch++;
    } else {
      stillFailingAfterRetry++;
    }
  }

  const { rows: [totals] } = await dbPool.query<{ total: string; checked: string }>(
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
    hadFailures: stillFailingAfterRetry > 0,
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
