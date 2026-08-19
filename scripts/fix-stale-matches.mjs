/**
 * Recomputes every (user, trail) pair that scripts/audit-stale-matches.mjs
 * would report as stale — see that script and the comment above
 * matchNextBatch in src/lib/match-trails.ts for why trail_match_checks can
 * go stale in the first place. Safe to re-run any time; each pair is
 * independently idempotent (same ON CONFLICT upsert computeTrailProgress
 * uses), so running this with nothing stale left is a fast no-op.
 *
 * Duplicates MATCH_SQL/ACTIVITY_MATCH_SQL from src/lib/match-trails.ts
 * rather than importing it, same as resume-sync.mjs and for the same
 * reason: this runs as a plain node script outside Next.js's module
 * resolution, so the "@/lib/..." path alias isn't available here.
 *
 * Usage:
 *   node --env-file=.env.local scripts/fix-stale-matches.mjs
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const CYCLING_TYPES = ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"];

const MATCH_SQL = `
  WITH combined_buffer AS (
    SELECT ST_Union(ST_Buffer(a.geometry::geography, 50)::geometry) AS geom,
           COUNT(DISTINCT a.id) AS activity_count,
           MIN(a.start_date) AS first_date, MAX(a.start_date) AS last_date
    FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry FROM trails WHERE id = $2) t_simplified
    JOIN activities a
      ON a.user_id = $1 AND a.geometry IS NOT NULL
      AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, 250)
  ),
  coverage AS (
    SELECT t.id AS trail_id, t.total_distance,
           ST_CollectionExtract(ST_Intersection(t.geometry, cb.geom), 2) AS covered_geom,
           cb.activity_count, cb.first_date, cb.last_date
    FROM (SELECT id, total_distance, geometry FROM trails WHERE id = $2) t
    CROSS JOIN combined_buffer cb
    WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
  )
  INSERT INTO user_trail_progress (
    user_id, trail_id, completed_distance, completion_percentage,
    completed_geometry, activity_count, first_activity_date, last_activity_date
  )
  SELECT $1, trail_id,
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0 ELSE ST_Length(covered_geom::geography) END,
    LEAST(CASE WHEN total_distance > 0 THEN ST_Length(covered_geom::geography) / total_distance * 100 ELSE 0 END, 100),
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL ELSE ST_SetSRID(ST_Multi(covered_geom), 4326)::geometry(MultiLineString,4326) END,
    activity_count, first_date, last_date
  FROM coverage
  WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
  ON CONFLICT (user_id, trail_id) DO UPDATE SET
    completed_distance = EXCLUDED.completed_distance,
    completion_percentage = EXCLUDED.completion_percentage,
    completed_geometry = EXCLUDED.completed_geometry,
    activity_count = EXCLUDED.activity_count,
    first_activity_date = EXCLUDED.first_activity_date,
    last_activity_date = EXCLUDED.last_activity_date,
    updated_at = NOW()
  RETURNING trail_id`;

const ACTIVITY_MATCH_SQL = `
  INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
  SELECT DISTINCT a.id, $2::uuid, $1::uuid
  FROM activities a
  CROSS JOIN (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry FROM trails WHERE id = $2::uuid) t_simplified
  WHERE a.user_id = $1::uuid AND a.geometry IS NOT NULL
    AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
    AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, 250)
  ON CONFLICT (activity_id, trail_id) DO NOTHING`;

async function computeOne(userId, trailId, includeCycling) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '180000'");
    const result = await client.query(MATCH_SQL, [userId, trailId, includeCycling, CYCLING_TYPES]);
    await client.query("COMMIT");
    const wasMatched = (result.rowCount ?? 0) > 0;

    if (wasMatched) {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '180000'");
      await client.query(ACTIVITY_MATCH_SQL, [userId, trailId, includeCycling, CYCLING_TYPES]);
      await client.query(
        "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
        [userId, trailId]
      );
      await client.query("COMMIT");
    }

    // trigger_sync_trail_match_checks (schema.sql) handles matched=true
    // automatically via the user_trail_progress write above. A genuine
    // no-match verdict has no row-write to hang a trigger off, so it's
    // still recorded explicitly here, same as computeTrailProgress does.
    await pool.query(
      `INSERT INTO trail_match_checks (user_id, trail_id, matched) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, trail_id) DO UPDATE SET matched = EXCLUDED.matched, checked_at = NOW()`,
      [userId, trailId, wasMatched]
    );

    return { ok: true, wasMatched };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`  ERROR ${userId}/${trailId}:`, err.message);
    return { ok: false };
  } finally {
    client.release();
  }
}

const { rows: stale } = await pool.query(
  `SELECT DISTINCT c.user_id, c.trail_id, u.first_name, u.last_name, t.name AS trail_name, u.include_cycling
   FROM trail_match_checks c
   JOIN users u ON u.id = c.user_id
   JOIN trails t ON t.id = c.trail_id
   WHERE EXISTS (
     SELECT 1 FROM activities a
     WHERE a.user_id = c.user_id AND a.geometry IS NOT NULL
       AND a.created_at > c.checked_at
       AND t.simplified_geometry && ST_Expand(a.geometry, 0.003)
   )
   ORDER BY u.first_name, t.name`
);

console.log(`Recomputing ${stale.length} stale (user, trail) pair(s)...\n`);

let fixed = 0, nowMatched = 0, stillNoMatch = 0, failed = 0;
for (const row of stale) {
  const { ok, wasMatched } = await computeOne(row.user_id, row.trail_id, row.include_cycling);
  if (ok) {
    fixed++;
    if (wasMatched) nowMatched++;
    else stillNoMatch++;
    console.log(`✓ ${row.first_name} ${row.last_name} — ${row.trail_name}: ${wasMatched ? "MATCHED" : "no coverage"}`);
  } else {
    failed++;
  }
}

console.log(`\nDone. ${fixed}/${stale.length} recomputed (${nowMatched} matched, ${stillNoMatch} genuinely no coverage), ${failed} failed.`);
await pool.end();
