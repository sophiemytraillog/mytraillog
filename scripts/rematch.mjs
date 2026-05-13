/**
 * Re-runs the trail matching engine for all users.
 * Run this after updating trail geometries (e.g. after db:import-gpx).
 *
 * Usage:
 *   node --env-file=.env.local scripts/rematch.mjs
 */

import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const BUFFER_METRES = 50;

const { rows: users } = await pool.query(
  "SELECT id, first_name, last_name FROM users ORDER BY created_at"
);

if (users.length === 0) {
  console.log("No users found.");
  await pool.end();
  process.exit(0);
}

for (const user of users) {
  console.log(`\nMatching for ${user.first_name} ${user.last_name} (${user.id})…`);

  const { rows: trails } = await pool.query(
    "SELECT id, slug, name FROM trails ORDER BY name"
  );

  let updated = 0;

  for (const trail of trails) {
    process.stdout.write(`  ${trail.name}… `);

    // Use a dedicated client so we can set statement_timeout per-query without
    // affecting the whole pool, and process one trail at a time to stay fast.
    const client = await pool.connect();
    client.setMaxListeners(20);
    client.on("error", (err) => {
      console.error(`  Connection error on ${trail.name}:`, err.message);
    });
    try {
      await client.query("SET statement_timeout = '180000'"); // 3 min per trail

      const { rowCount } = await client.query(
        `WITH
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
         RETURNING trail_id`,
        [user.id, trail.id]
      );
      console.log(rowCount ? "matched" : "no coverage");
      if (rowCount) updated++;
    } catch (err) {
      console.error(`timeout/error: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`  ${updated} trail(s) with coverage found.`);

  // Summary table
  const { rows: summary } = await pool.query(
    `SELECT t.name,
            round(utp.completion_percentage)::int AS pct,
            round(utp.completed_distance / 1609.344)::int AS done_miles,
            round(t.total_distance / 1609.344)::int AS total_miles
     FROM user_trail_progress utp
     JOIN trails t ON t.id = utp.trail_id
     WHERE utp.user_id = $1 AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
    [user.id]
  );

  if (summary.length > 0) {
    const w = [32, 5, 12, 12];
    console.log(
      "\n  " + "Trail".padEnd(w[0]) + "%".padStart(w[1]) +
      "Done (mi)".padStart(w[2]) + "Total (mi)".padStart(w[3])
    );
    console.log("  " + "-".repeat(w.reduce((a, b) => a + b)));
    for (const r of summary) {
      console.log(
        "  " + r.name.padEnd(w[0]) +
        String(r.pct).padStart(w[1]) +
        String(r.done_miles).padStart(w[2]) +
        String(r.total_miles).padStart(w[3])
      );
    }
  } else {
    console.log("  No trail coverage found.");
  }
}

await pool.end();
