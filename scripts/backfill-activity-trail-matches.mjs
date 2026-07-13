/**
 * One-time backfill: populates activity_trail_matches for user_trail_progress
 * rows that predate that table (activity_matches_computed_at IS NULL).
 *
 * Resumable by construction — progress is persisted in the DB (the
 * activity_matches_computed_at column), not in this process, so it's safe to
 * kill and rerun at any point; it just picks up whatever's still NULL.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-activity-trail-matches.mjs
 *   node --env-file=.env.local scripts/backfill-activity-trail-matches.mjs --user <uuid>
 */

import pg from "pg";
const { Pool } = pg;

// Port 6543 = Supabase session mode — see rematch.mjs for why.
const pool = new Pool({
  port: 6543,
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 60_000,
});

const BUFFER_METRES = 50;
const SIMPLIFY_MARGIN = 200;
const BATCH_SIZE = 20;

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

const CYCLING_ACTIVITY_TYPES = ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"];

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

async function backfillPair(userId, trailId, includeCycling) {
  const client = await pool.connect();
  client.removeAllListeners("error");
  client.on("error", () => {});
  try {
    await client.query("SET statement_timeout = '180000'"); // 3 min — some trails (e.g. South West Coast Path) are huge
    await client.query(ACTIVITY_MATCH_SQL, [userId, trailId, includeCycling, CYCLING_ACTIVITY_TYPES]);
    await client.query(
      "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
      [userId, trailId]
    );
  } finally {
    client.release();
  }
}

const userArg = process.argv.find(a => a.startsWith('--user='))?.slice(7)
  ?? (process.argv.indexOf('--user') !== -1 ? process.argv[process.argv.indexOf('--user') + 1] : null);
const limitArg = process.argv.find(a => a.startsWith('--limit='))?.slice(8);
const maxPairs = limitArg ? parseInt(limitArg) : Infinity;

let totalDone = 0;
let totalAttempted = 0;
for (;;) {
  if (totalAttempted >= maxPairs) break;
  const { rows: pending } = await pool.query(
    `SELECT utp.user_id, utp.trail_id, t.name AS trail_name, u.include_cycling
     FROM user_trail_progress utp
     JOIN trails t ON t.id = utp.trail_id
     JOIN users u ON u.id = utp.user_id
     WHERE utp.activity_matches_computed_at IS NULL
       AND ($1::uuid IS NULL OR utp.user_id = $1::uuid)
     ORDER BY utp.user_id, utp.trail_id
     LIMIT ${BATCH_SIZE}`,
    [userArg]
  );

  if (pending.length === 0) break;

  for (const row of pending) {
    if (totalAttempted >= maxPairs) break;
    totalAttempted++;
    process.stdout.write(`  [${row.user_id.slice(0, 8)}] ${row.trail_name}… `);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        await backfillPair(row.user_id, row.trail_id, row.include_cycling);
        console.log("done");
        done = true;
        totalDone++;
      } catch (err) {
        if (isConnectionError(err) && attempt < 3) {
          const wait = attempt * 5_000;
          process.stdout.write(`connection error, retrying in ${wait / 1000}s… `);
          await sleep(wait);
        } else {
          console.log(`FAILED (giving up): ${err.message}`);
          // Mark as attempted anyway — otherwise this pair keeps re-appearing in
          // every future batch forever (it always matches "IS NULL"), turning a
          // handful of genuinely slow/complex trails into an infinite loop once
          // everything else is done. Candidates for this trail just won't be in
          // the cache; rerun manually for this (user, trail) later if needed.
          await pool.query(
            "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
            [row.user_id, row.trail_id]
          ).catch((e) => console.error("  (also failed to checkpoint):", e.message));
          done = true;
        }
      }
    }
  }
}

console.log(`\nBackfill complete. ${totalDone} (user, trail) pairs processed.`);
await pool.end();
