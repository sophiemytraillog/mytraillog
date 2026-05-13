import { pool } from "@/lib/db";

const BUFFER_METRES = 50;

const MATCH_SQL = `
  WITH
  -- Union all activity buffers into one polygon so overlapping runs don't double-count.
  -- Uses simplified trail for the spatial filter only (performance) — NOT for geometry output.
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
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES})
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

export async function computeTrailProgress(userId: string, trailIds?: string[]): Promise<number> {
  const { rows: trails } = trailIds && trailIds.length > 0
    ? await pool.query<{ id: string }>(
        "SELECT id FROM trails WHERE id = ANY($1::uuid[]) ORDER BY name",
        [trailIds]
      )
    : await pool.query<{ id: string }>("SELECT id FROM trails ORDER BY name");

  let matched = 0;

  for (const trail of trails) {
    const client = await pool.connect();
    client.setMaxListeners(20);
    // Prevent an unexpected TCP drop from crashing the process
    client.on("error", (err) => {
      console.error(`[match-trails] Client error on trail ${trail.id}:`, err.message);
    });
    try {
      await client.query("SET LOCAL statement_timeout = '180000'"); // 3 min
      const result = await client.query<{ trail_id: string }>(MATCH_SQL, [
        userId,
        trail.id,
      ]);
      if ((result.rowCount ?? 0) > 0) matched++;
    } catch (err) {
      console.error(`[match-trails] Trail ${trail.id} failed:`, err);
    } finally {
      client.release();
    }
  }

  return matched;
}
