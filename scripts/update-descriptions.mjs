// Updates Strava descriptions for recent activities that have trail matches
// but haven't been updated yet.
// Usage: node --env-file=.env.local scripts/update-descriptions.mjs

import pg from "pg";
const { Pool } = pg;

const BUFFER_METRES = 50;
const LIMIT = 20;
const DELAY_MS = 1000;

const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432"),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

async function getValidAccessToken(userId) {
  const { rows } = await pool.query(
    `SELECT strava_access_token, strava_refresh_token, strava_token_expires_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) throw new Error(`User ${userId} not found`);
  const { strava_access_token, strava_refresh_token, strava_token_expires_at } = rows[0];

  if (new Date(strava_token_expires_at).getTime() > Date.now() + 5 * 60_000) {
    return strava_access_token;
  }

  console.log("Token expiring, refreshing…");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: strava_refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const tokens = await res.json();
  await pool.query(
    `UPDATE users SET strava_access_token = $1, strava_refresh_token = $2,
     strava_token_expires_at = to_timestamp($3), updated_at = NOW() WHERE id = $4`,
    [tokens.access_token, tokens.refresh_token, tokens.expires_at, userId]
  );
  console.log("Token refreshed.");
  return tokens.access_token;
}

async function getActivityTrailMatches(userId, activityDbId) {
  const { rows } = await pool.query(
    `SELECT t.name,
            utp.completed_distance,
            utp.completion_percentage,
            t.total_distance,
            COALESCE(
              ST_Length(
                ST_Intersection(
                  a.geometry,
                  ST_Buffer(t.geometry::geography, $3)::geometry
                )::geography
              ),
              0
            ) AS activity_trail_distance_m
     FROM activities a
     JOIN trails t ON ST_DWithin(a.geometry::geography, t.geometry::geography, $3)
     JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
     WHERE a.id = $1 AND a.user_id = $2
       AND a.geometry IS NOT NULL
       AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
    [activityDbId, userId, BUFFER_METRES]
  );
  return rows;
}

function getAppHost() {
  try { return new URL(process.env.APP_URL || "https://mytraillog.vercel.app").host; } catch { return "mytraillog.vercel.app"; }
}

function buildTrailBlock(matches) {
  const lines = matches.map((m) => {
    const actKm = (m.activity_trail_distance_m / 1000).toFixed(1);
    const completedKm = (m.completed_distance / 1000).toFixed(1);
    const totalKm = (m.total_distance / 1000).toFixed(1);
    const pct = Math.round(m.completion_percentage);
    return `🥾 ${m.name}: ${actKm}km (${pct}% · ${completedKm}km / ${totalKm}km)`;
  });
  return `\n\n${lines.join("\n")}\n${getAppHost()}`;
}

async function writeTrailDescription(activityDbId, stravaActivityId, matches, token) {
  const getRes = await fetch(
    `https://www.strava.com/api/v3/activities/${stravaActivityId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!getRes.ok) throw new Error(`GET activity failed: HTTP ${getRes.status}`);
  const activity = await getRes.json();
  const currentDesc = activity.description ?? "";

  const baseDesc = currentDesc
    .replace(/\n\n🥾 My Trail Log[\s\S]*$/, "")
    .replace(/\n\n(?:[^\n]+: \d+\.\d+km[^\n]*\n)+mytraillog\.\S+[^\n]*$/, "")
    .trimEnd();
  const newDesc = baseDesc + buildTrailBlock(matches);

  if (newDesc === currentDesc.trimEnd()) {
    return false;
  }

  const putRes = await fetch(
    `https://www.strava.com/api/v3/activities/${stravaActivityId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: newDesc }),
    }
  );
  if (!putRes.ok) throw new Error(`PUT activity failed: HTTP ${putRes.status}`);

  await pool.query(
    `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
    [activityDbId]
  );
  return true;
}

async function main() {
  const { rows: users } = await pool.query(
    `SELECT id, first_name FROM users LIMIT 1`
  );
  if (!users.length) { console.log("No users found."); return; }
  const user = users[0];
  console.log(`User: ${user.first_name} (${user.id})\n`);

  const { rows: activities } = await pool.query(
    `SELECT id, strava_activity_id::text, name, start_date
     FROM activities
     WHERE user_id = $1
       AND geometry IS NOT NULL
       AND strava_description_updated = FALSE
     ORDER BY start_date DESC
     LIMIT $2`,
    [user.id, LIMIT]
  );

  if (!activities.length) {
    console.log("No unupdated activities found.");
    return;
  }
  console.log(`Found ${activities.length} unupdated activities (most recent ${LIMIT}):\n`);

  const token = await getValidAccessToken(user.id);
  let updated = 0;
  let skipped = 0;

  for (const act of activities) {
    const date = new Date(act.start_date).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
    process.stdout.write(`[${date}] ${act.name} … `);

    const matches = await getActivityTrailMatches(user.id, act.id);
    if (!matches.length) {
      console.log("no trail match, skipping");
      skipped++;
      continue;
    }

    console.log(`matched: ${matches.map((m) => m.name).join(", ")}`);
    const wasUpdated = await writeTrailDescription(
      act.id, parseInt(act.strava_activity_id), matches, token
    );
    if (wasUpdated) {
      console.log(`  → updated ✓`);
      updated++;
    } else {
      console.log(`  → already up to date`);
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone — ${updated} updated, ${skipped} skipped (no trail match).`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => pool.end());
