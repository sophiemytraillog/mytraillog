/**
 * Runs the matching engine for one specific trail against every user —
 * for a brand-new trail row (e.g. just merged/imported), which has zero
 * trail_match_checks rows for anyone, so neither matchNextBatch's "needs
 * checking" query nor fix-stale-matches.mjs's staleness re-check would
 * necessarily reach it in a single pass. This scopes directly to the given
 * trail id instead.
 *
 * Duplicates MATCH_SQL/ACTIVITY_MATCH_SQL from src/lib/match-trails.ts
 * rather than importing it, same as fix-stale-matches.mjs and resume-
 * sync.mjs — plain node scripts here can't resolve the "@/lib/..." path
 * alias Next.js provides.
 *
 * Usage:
 *   node --env-file=.env.local scripts/match-new-trail.mjs <trail-id-or-slug>
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const CYCLING_TYPES = ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"];

const trailArg = process.argv[2];
if (!trailArg) {
  console.error("Usage: node scripts/match-new-trail.mjs <trail-id-or-slug>");
  process.exit(1);
}

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

const { rows: trailRows } = await pool.query(
  `SELECT id, name, total_distance FROM trails WHERE id::text = $1 OR slug = $1`,
  [trailArg]
);
if (trailRows.length === 0) {
  console.error(`No trail found matching id/slug "${trailArg}"`);
  await pool.end();
  process.exit(1);
}
const trail = trailRows[0];
console.log(`Matching "${trail.name}" (${(trail.total_distance / 1000).toFixed(2)} km) against all users...\n`);

const { rows: users } = await pool.query(
  `SELECT id, first_name, last_name, include_cycling FROM users ORDER BY first_name, last_name`
);

let matched = 0, noCoverage = 0, failed = 0;
for (const user of users) {
  const { ok, wasMatched } = await computeOne(user.id, trail.id, user.include_cycling);
  const label = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.id;
  if (ok) {
    if (wasMatched) { matched++; console.log(`✓ ${label}: MATCHED`); }
    else { noCoverage++; console.log(`  ${label}: no coverage`); }
  } else {
    failed++;
  }
}

console.log(`\nDone. ${matched} user(s) matched, ${noCoverage} no coverage, ${failed} failed.`);
await pool.end();
