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
