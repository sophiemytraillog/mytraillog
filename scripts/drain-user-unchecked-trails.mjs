/**
 * Directly drains a single user's NEVER-CHECKED trail backlog — bypasses
 * matchNextBatch's normal candidate pool, which mixes never-checked trails
 * with already-matched-but-now-stale ones (see STALE_CHECK_BBOX_DEGREES in
 * match-trails.ts) and orders purely by (national_trail DESC, name ASC).
 * For an account that just had a huge activity backfill (Luke Davis: 720 ->
 * 6,727 activities), most of that account's previously-checked trails go
 * stale at once, and their MATCH_SQL computation is expensive (a real
 * geometry union/intersection against thousands of activities) — that pool
 * dominates matchNextBatch's batches almost completely (confirmed: ~1
 * trail/call, 60-90s each), so the never-checked backlog this script exists
 * to clear never gets reached through the normal endpoint in any reasonable
 * time. Most never-checked trails are the OPPOSITE case — the user has
 * never been anywhere near them, so MATCH_SQL's own activity JOIN rejects
 * fast with zero rows before ever reaching the expensive ST_Union step —
 * this script targets exactly that backlog, in isolation, so it can run
 * through hundreds of trails quickly instead of getting stuck behind a
 * handful of expensive re-checks.
 *
 * Duplicates MATCH_SQL/ACTIVITY_MATCH_SQL from src/lib/match-trails.ts,
 * same as fix-stale-matches.mjs and match-new-trail.mjs — plain node
 * scripts here can't resolve the "@/lib/..." path alias Next.js provides.
 *
 * Usage:
 *   node --env-file=.env.local scripts/drain-user-unchecked-trails.mjs <user-id>
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 15_000,
});

// pg emits 'error' on the Pool itself (not on whichever client happens to be
// mid-query) when an IDLE pooled connection drops — without a listener here
// that's an unhandled EventEmitter 'error' event, fatal to the whole process
// regardless of any try/catch elsewhere in this script. Same fix as
// rematch.mjs; confirmed crashing this exact script on its first run,
// mid-way through the very first trail, with no trail-level error logged at
// all — the process died before computeOne's own catch block ever got a
// chance to run.
pool.on("error", (err) => {
  console.error("[pool] Idle pool client error:", err.message);
});

const CYCLING_TYPES = ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"];

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: node scripts/drain-user-unchecked-trails.mjs <user-id>");
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

async function computeOne(trailId, includeCycling) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30000'"); // never-checked trails should be fast; a slow one here is unusual
    const result = await client.query(MATCH_SQL, [userId, trailId, includeCycling, CYCLING_TYPES]);
    await client.query("COMMIT");
    const wasMatched = (result.rowCount ?? 0) > 0;

    if (wasMatched) {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '60000'");
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
    console.error(`  ERROR trail ${trailId}:`, err.message);
    return { ok: false };
  } finally {
    client.release();
  }
}

const { rows: userRows } = await pool.query(
  "SELECT include_cycling, first_name, last_name FROM users WHERE id = $1",
  [userId]
);
if (userRows.length === 0) {
  console.error(`No user found with id ${userId}`);
  process.exit(1);
}
const { include_cycling: includeCycling, first_name, last_name } = userRows[0];

// RANDOM(), not alphabetical — a handful of genuinely expensive trails
// (confirmed: several "Co..."-prefixed names took 20-30s+ each for this
// account) sit at a fixed position in alphabetical order. Since a trail
// that times out never gets a trail_match_checks row (writing a false
// "no match" on a genuine timeout risks silently hiding a real one — see
// computeOne's catch block), every fresh restart of this script re-fetches
// the same unchecked list and re-attempts those same expensive trails
// FIRST, before ever reaching fresh ground later in the alphabet.
// Randomizing means a restart after a stall makes progress on a different
// slice of the backlog instead of repeatedly re-hitting the same cluster.
const { rows: unchecked } = await pool.query(
  `SELECT t.id, t.name
   FROM trails t
   LEFT JOIN trail_match_checks c ON c.trail_id = t.id AND c.user_id = $1
   WHERE c.trail_id IS NULL
   ORDER BY (t.category = 'national_trail') DESC, RANDOM()`,
  [userId]
);

console.log(`Draining ${unchecked.length} never-checked trail(s) for ${first_name} ${last_name}...\n`);

let matched = 0, noCoverage = 0, failed = 0;
const startedAt = Date.now();
for (let i = 0; i < unchecked.length; i++) {
  const trail = unchecked[i];
  const trailStartedAt = Date.now();
  const { ok, wasMatched } = await computeOne(trail.id, includeCycling);
  const trailMs = Date.now() - trailStartedAt;
  if (trailMs > 5_000) {
    console.log(`  [slow] ${trail.name}: ${trailMs}ms`);
  }
  if (ok) {
    if (wasMatched) { matched++; console.log(`✓ [${i + 1}/${unchecked.length}] ${trail.name}: MATCHED`); }
    else noCoverage++;
  } else {
    failed++;
  }
  if ((i + 1) % 50 === 0) {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ... ${i + 1}/${unchecked.length} done (${matched} matched, ${noCoverage} no coverage, ${failed} failed) — ${elapsedS}s elapsed`);
  }
}

console.log(`\nDone. ${matched} matched, ${noCoverage} no coverage, ${failed} failed, out of ${unchecked.length} never-checked trail(s).`);
await pool.end();
