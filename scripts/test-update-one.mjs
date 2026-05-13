/**
 * Test: find one activity that matched Hadrian's Wall Path, read its current
 * Strava description, append trail info, and update it. Shows full API responses.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-update-one.mjs
 */
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

// ── 1. Get the only user ─────────────────────────────────────────────────────
const { rows: [user] } = await pool.query(
  `SELECT id, first_name, strava_access_token, strava_refresh_token,
          strava_token_expires_at
   FROM users LIMIT 1`
);
console.log(`\nUser: ${user.first_name} (${user.id})`);

// ── 2. Refresh token if needed ───────────────────────────────────────────────
let token = user.strava_access_token;
if (new Date(user.strava_token_expires_at).getTime() < Date.now() + 5 * 60_000) {
  console.log("Token expiring — refreshing…");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: user.strava_refresh_token,
    }),
  });
  const tokens = await res.json();
  if (!res.ok) { console.error("Token refresh failed:", tokens); process.exit(1); }
  token = tokens.access_token;
  console.log("Token refreshed OK");
}

// ── 3. Find an activity that matched Hadrian's Wall Path ─────────────────────
const { rows: [match] } = await pool.query(
  `SELECT a.id, a.strava_activity_id, a.name,
          utp.completion_percentage, utp.completed_distance
   FROM activities a
   JOIN trails t ON t.slug = 'hadrians-wall-path'
   JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
   WHERE a.user_id = $1
     AND a.geometry IS NOT NULL
     AND ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
   ORDER BY a.start_date DESC
   LIMIT 1`,
  [user.id]
);

if (!match) {
  console.error("No activity found near Hadrian's Wall Path.");
  await pool.end();
  process.exit(1);
}

console.log(`\nActivity: "${match.name}" (Strava ID ${match.strava_activity_id})`);
console.log(`Trail progress: ${Math.round(match.completion_percentage)}% (${(match.completed_distance / 1000).toFixed(1)} km)`);

// ── 4. GET current description from Strava ───────────────────────────────────
console.log(`\nGET https://www.strava.com/api/v3/activities/${match.strava_activity_id}`);
const getRes = await fetch(
  `https://www.strava.com/api/v3/activities/${match.strava_activity_id}`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const getBody = await getRes.json();
console.log(`Response: HTTP ${getRes.status}`);
console.log(`Current description: ${JSON.stringify(getBody.description ?? "")}`);

if (!getRes.ok) {
  console.error("GET failed — aborting.");
  await pool.end();
  process.exit(1);
}

// ── 5. Build new description ─────────────────────────────────────────────────
const MARKER = "🥾 My Trail Log:";
const baseDesc = (getBody.description ?? "").replace(/\n\n🥾 My Trail Log:[\s\S]*$/, "").trimEnd();
const km = (match.completed_distance / 1000).toFixed(1);
const pct = Math.round(match.completion_percentage);
const trailBlock = `\n\n${MARKER} Hadrian's Wall Path — ${km}km completed (${pct}% total)`;
const newDesc = baseDesc + trailBlock;

console.log(`\nNew description: ${JSON.stringify(newDesc)}`);

if (newDesc === (getBody.description ?? "").trimEnd()) {
  console.log("\nDescription already up to date — no PUT needed.");
  await pool.end();
  process.exit(0);
}

// ── 6. PUT updated description to Strava ────────────────────────────────────
console.log(`\nPUT https://www.strava.com/api/v3/activities/${match.strava_activity_id}`);
const putRes = await fetch(
  `https://www.strava.com/api/v3/activities/${match.strava_activity_id}`,
  {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description: newDesc }),
  }
);
const putBody = await putRes.json();
console.log(`Response: HTTP ${putRes.status}`);
console.log(`Returned description: ${JSON.stringify(putBody.description ?? putBody.message ?? putBody)}`);

await pool.end();
