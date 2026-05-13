// One-off: update description for a single activity to test the new format.
import { Pool } from "pg";

const pool = new Pool({
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  user: "postgres.aslnarlpfriidizzcbep",
  password: "%EG:y5a82ujzR6:",
  ssl: { rejectUnauthorized: false },
});

const ACTIVITY_DB_ID     = "346b2c64-cfa9-4079-98e1-038d7284bec6";
const STRAVA_ACTIVITY_ID = "18408894757";
const USER_ID            = "2f0be392-d997-4225-8da4-1ce434d05f89";
const APP_URL            = "http://localhost:3000/dashboard";
const MARKER             = "🥾 My Trail Log";

async function getToken() {
  const { rows } = await pool.query(
    `SELECT strava_access_token, strava_refresh_token, strava_token_expires_at
     FROM users WHERE id = $1`,
    [USER_ID]
  );
  const { strava_access_token, strava_refresh_token, strava_token_expires_at } = rows[0];
  if (new Date(strava_token_expires_at).getTime() > Date.now() + 5 * 60_000) {
    return strava_access_token;
  }
  console.log("Token expiring, refreshing…");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "233333",
      client_secret: "a0333f9d773ce06fa198b5004823b281172327d9",
      grant_type: "refresh_token",
      refresh_token: strava_refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const tokens = await res.json();
  await pool.query(
    `UPDATE users SET strava_access_token=$1, strava_refresh_token=$2,
     strava_token_expires_at=to_timestamp($3), updated_at=NOW() WHERE id=$4`,
    [tokens.access_token, tokens.refresh_token, tokens.expires_at, USER_ID]
  );
  return tokens.access_token;
}

async function getTrailMatches() {
  const { rows } = await pool.query(
    `SELECT t.name, utp.completed_distance, utp.completion_percentage
     FROM activities a
     JOIN trails t ON ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
     JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
     WHERE a.id = $1 AND a.user_id = $2 AND a.geometry IS NOT NULL AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
    [ACTIVITY_DB_ID, USER_ID]
  );
  return rows;
}

function buildBlock(matches) {
  const lines = matches.map(m => {
    const km = (m.completed_distance / 1000).toFixed(1);
    const pct = Math.round(m.completion_percentage);
    return `${m.name} — ${km}km completed (${pct}% total)`;
  });
  return `\n\n${MARKER}\n${lines.join("\n")}\n${APP_URL}`;
}

async function main() {
  const token = await getToken();
  const matches = await getTrailMatches();
  console.log("Trail matches:", matches);

  if (matches.length === 0) {
    console.log("No trail matches — nothing to write.");
    await pool.end();
    return;
  }

  let getRes = await fetch(`https://www.strava.com/api/v3/activities/${STRAVA_ACTIVITY_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (getRes.status === 429) {
    console.log("429 headers:", Object.fromEntries(getRes.headers.entries()));
    const reset = parseInt(getRes.headers.get("X-RateLimit-Reset") ?? "0");
    const wait = reset > 0 ? reset * 1000 - Date.now() : 60_000;
    const delay = Math.max(wait, 5000);
    console.log(`Rate limited — waiting ${Math.round(delay / 1000)}s…`);
    await new Promise(r => setTimeout(r, delay));
    getRes = await fetch(`https://www.strava.com/api/v3/activities/${STRAVA_ACTIVITY_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!getRes.ok) throw new Error(`GET failed: ${getRes.status}`);
  const activity = await getRes.json();
  const currentDesc = activity.description ?? "";
  console.log("\nCurrent description:\n---\n" + currentDesc + "\n---");

  const baseDesc = currentDesc.replace(/\n\n🥾 My Trail Log[\s\S]*$/, "").trimEnd();
  const newDesc  = baseDesc + buildBlock(matches);
  console.log("\nNew description:\n---\n" + newDesc + "\n---");

  const putRes = await fetch(`https://www.strava.com/api/v3/activities/${STRAVA_ACTIVITY_ID}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ description: newDesc }),
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`PUT failed: ${putRes.status}: ${body}`);
  }
  console.log("\nStrava updated OK.");
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
