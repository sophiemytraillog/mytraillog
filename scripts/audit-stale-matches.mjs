/**
 * Reports every (user, trail) pair where trail_match_checks predates an
 * activity that's now spatially near that trail — i.e. every pair
 * matchNextBatch's staleness clause (see match-trails.ts) would pick up
 * and recompute. Read-only; use fix-stale-matches.mjs to actually correct
 * what this finds.
 *
 * Background: trail_match_checks is a permanent-looking checkpoint, but a
 * "matched=false" verdict is only ever true relative to the activities
 * that existed at check time. Sync and matching sweeps run concurrently by
 * design (the dashboard starts sweeping deferred trails immediately, not
 * waiting for an in-flight sync), so a trail can legitimately get checked
 * against an incomplete activity set, come back with no match, and then
 * never get revisited even after the real match arrives moments later.
 * Root-caused via Chris Rance's South Downs Way, 2026-08-19 — see the
 * comment above matchNextBatch in match-trails.ts for the full story.
 *
 * Usage:
 *   node --env-file=.env.local scripts/audit-stale-matches.mjs
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const { rows } = await pool.query(
  `SELECT c.user_id, u.first_name, u.last_name, c.trail_id, t.name AS trail_name,
          c.matched, c.checked_at, COUNT(a.id) AS newer_nearby_activities
   FROM trail_match_checks c
   JOIN users u ON u.id = c.user_id
   JOIN trails t ON t.id = c.trail_id
   JOIN activities a
     ON a.user_id = c.user_id
     AND a.geometry IS NOT NULL
     AND a.created_at > c.checked_at
     AND t.simplified_geometry && ST_Expand(a.geometry, 0.003)
   GROUP BY c.user_id, u.first_name, u.last_name, c.trail_id, t.name, c.matched, c.checked_at
   ORDER BY u.first_name, u.last_name, t.name`
);

console.log(`Stale (user, trail) pairs: ${rows.length}\n`);

const byUser = new Map();
for (const r of rows) {
  const key = `${r.first_name} ${r.last_name} (${r.user_id})`;
  byUser.set(key, (byUser.get(key) ?? 0) + 1);
}
for (const [user, count] of byUser) console.log(`  ${user}: ${count} stale trail(s)`);

if (rows.length > 0) {
  console.log("\nDetail:");
  for (const r of rows) {
    console.log(
      `  ${r.first_name} ${r.last_name} — ${r.trail_name} — ` +
        `matched=${r.matched} checked_at=${r.checked_at.toISOString()} ` +
        `newer_nearby_activities=${r.newer_nearby_activities}`
    );
  }
  console.log("\nRun scripts/fix-stale-matches.mjs to recompute these now.");
}

await pool.end();
