/**
 * Re-runs the trail matching engine for all users (or a single user).
 *
 * Usage:
 *   node --env-file=.env.local scripts/rematch.mjs
 *   node --env-file=.env.local scripts/rematch.mjs --user <uuid>
 */

import pg from "pg";
const { Pool } = pg;

// Port 6543 = Supabase session mode. Stable for long-running scripts — backend
// stays pinned so SET statement_timeout persists and TCP drops are rare.
// PGHOST/PGDATABASE/PGUSER/PGPASSWORD are read from env; port is overridden here.
const pool = new Pool({
  port: 6543,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 60_000,
});

const BUFFER_METRES = 50;
// ST_SimplifyPreserveTopology(geom, 0.001) can move points by up to ~111 m.
// Widen the pre-filter to avoid excluding activities that are near the real trail
// but far from the simplified version (e.g. coastal paths with tight headland bends).
const SIMPLIFY_MARGIN = 200;

const MATCH_SQL = `
  WITH
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
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
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
  RETURNING trail_id`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isConnectionError(err) {
  return (
    err.code === "ENOTFOUND" ||
    err.code === "ECONNRESET" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ETIMEDOUT" ||
    (typeof err.message === "string" && err.message.includes("terminated"))
  );
}

async function matchTrail(userId, trailId) {
  const client = await pool.connect();
  client.removeAllListeners("error");
  client.on("error", () => {}); // handled via try/catch; suppress unhandled-event crash
  try {
    // SET at session level — persists for the client's lifetime in session-mode pooling.
    await client.query("SET statement_timeout = '180000'"); // 3 min
    const { rowCount } = await client.query(MATCH_SQL, [userId, trailId]);
    return rowCount ?? 0;
  } finally {
    client.release();
  }
}

const userArg = process.argv.find(a => a.startsWith('--user='))?.slice(7)
  ?? (process.argv.indexOf('--user') !== -1 ? process.argv[process.argv.indexOf('--user') + 1] : null);

const { rows: users } = await pool.query(
  userArg
    ? "SELECT id, first_name, last_name FROM users WHERE id = $1"
    : "SELECT id, first_name, last_name FROM users ORDER BY created_at",
  userArg ? [userArg] : []
);

if (userArg && users.length === 0) {
  console.error(`No user found with id: ${userArg}`);
  await pool.end();
  process.exit(1);
}

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

    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const n = await matchTrail(user.id, trail.id);
        console.log(n ? "matched" : "no coverage");
        if (n) updated++;
        done = true;
      } catch (err) {
        if (isConnectionError(err) && attempt < 3) {
          const wait = attempt * 5_000;
          process.stdout.write(`\n  ↩ connection error (attempt ${attempt}), retrying in ${wait / 1000}s… `);
          await sleep(wait);
        } else {
          console.error(`timeout/error: ${err.message}`);
          done = true;
        }
      }
    }
  }

  console.log(`\n  ${updated} trail(s) with coverage found.`);

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
