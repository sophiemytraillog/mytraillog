import pg from "pg";
const pool = new pg.Pool({
  host: process.env.PGHOST, port: process.env.PGPORT,
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

const DB_ACTIVITY_ID   = "c2b0028a-077a-437a-a211-03b2c8eec317";
const STRAVA_ACTIVITY_ID = 18631337949;
const BUFFER_METRES    = 50;

// Get + refresh token if needed
const { rows: users } = await pool.query(
  `SELECT id, strava_access_token, strava_refresh_token, strava_token_expires_at FROM users LIMIT 1`
);
const user = users[0];
let token = user.strava_access_token;
if (new Date(user.strava_token_expires_at).getTime() < Date.now() + 5 * 60_000) {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: user.strava_refresh_token,
    }),
  });
  const tokens = await r.json();
  token = tokens.access_token;
  await pool.query(
    `UPDATE users SET strava_access_token=$1, strava_refresh_token=$2, strava_token_expires_at=to_timestamp($3) WHERE id=$4`,
    [tokens.access_token, tokens.refresh_token, tokens.expires_at, user.id]
  );
}

// Get trail matches
const { rows: matches } = await pool.query(`
  SELECT t.name, utp.completed_distance, utp.completion_percentage, t.total_distance,
         COALESCE(ST_Length(ST_Intersection(a.geometry, ST_Buffer(t.geometry::geography, $3)::geometry)::geography), 0) AS activity_trail_distance_m
  FROM activities a
  JOIN trails t ON ST_DWithin(a.geometry::geography, t.geometry::geography, $3)
  JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
  WHERE a.id = $1 AND a.user_id = $2 AND a.geometry IS NOT NULL AND utp.completion_percentage > 0
  ORDER BY utp.completion_percentage DESC
`, [DB_ACTIVITY_ID, user.id, BUFFER_METRES]);

if (!matches.length) { console.log("No trail matches found."); await pool.end(); process.exit(0); }

console.log("Trail matches:");
for (const m of matches) {
  console.log(`  ${m.name}: ${(m.activity_trail_distance_m/1000).toFixed(1)}km on trail, ${Math.round(m.completion_percentage)}% overall`);
}

// Build trail block
const lines = matches.map(m => {
  const actKm = (m.activity_trail_distance_m / 1000).toFixed(1);
  const completedKm = (m.completed_distance / 1000).toFixed(1);
  const totalKm = (m.total_distance / 1000).toFixed(1);
  const pct = Math.round(m.completion_percentage);
  return `🥾 ${m.name}: ${actKm}km (${pct}% · ${completedKm}km / ${totalKm}km)`;
});
const appHost = (() => { try { return new URL(process.env.APP_URL || "https://mytraillog.vercel.app").host; } catch { return "mytraillog.vercel.app"; } })();
const trailBlock = `\n\n${lines.join("\n")}\n${appHost}`;

// Fetch current Strava description
const getRes = await fetch(`https://www.strava.com/api/v3/activities/${STRAVA_ACTIVITY_ID}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const activity = await getRes.json();
const currentDesc = activity.description ?? "";
console.log("\nCurrent Strava description:", JSON.stringify(currentDesc));

// Strip any old trail block and append fresh one
const baseDesc = currentDesc
  .replace(/\n\n🥾 My Trail Log[\s\S]*$/, "")
  .replace(/\n\n(?:[^\n]+: \d+\.\d+km[^\n]*\n)+mytraillog\.\S+[^\n]*$/, "")
  .trimEnd();
const newDesc = baseDesc + trailBlock;
console.log("\nNew description:", JSON.stringify(newDesc));

// Write to Strava
const putRes = await fetch(`https://www.strava.com/api/v3/activities/${STRAVA_ACTIVITY_ID}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ description: newDesc }),
});
if (!putRes.ok) {
  const body = await putRes.text();
  console.error("PUT failed:", putRes.status, body);
} else {
  await pool.query(`UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`, [DB_ACTIVITY_ID]);
  console.log("\n✓ Strava description updated.");
}

await pool.end();
