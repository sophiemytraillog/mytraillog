/**
 * Lists your 10 most recent activities that matched a trail, then updates
 * the Strava description for whichever ones you select.
 *
 * Run: node --env-file=.env.local scripts/update-selected.mjs
 */
import pg from "pg";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const USER_ID = "2f0be392-d997-4225-8da4-1ce434d05f89";
const APP_URL = "https://mytraillog.co.uk/dashboard";
const BUFFER_M = 50;

// ── Strava auth ────────────────────────────────────────────────────────────

async function getToken() {
  const { rows } = await pool.query(
    `SELECT strava_access_token, strava_refresh_token, strava_token_expires_at
     FROM users WHERE id = $1`,
    [USER_ID]
  );
  const row = rows[0];
  if (new Date(row.strava_token_expires_at).getTime() > Date.now() + 300_000) {
    return row.strava_access_token;
  }
  process.stdout.write("Refreshing Strava token… ");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: row.strava_refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const t = await res.json();
  await pool.query(
    `UPDATE users
     SET strava_access_token=$1, strava_refresh_token=$2,
         strava_token_expires_at=to_timestamp($3), updated_at=NOW()
     WHERE id=$4`,
    [t.access_token, t.refresh_token, t.expires_at, USER_ID]
  );
  console.log("done");
  return t.access_token;
}

// ── Database queries ───────────────────────────────────────────────────────

async function fetchActivities() {
  const { rows } = await pool.query(
    `SELECT a.id,
            a.strava_activity_id,
            a.name,
            to_char(a.start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
     FROM activities a
     WHERE a.user_id = $1
       AND a.geometry IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM trails t
         JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
         WHERE ST_DWithin(a.geometry::geography, t.geometry::geography, $2)
           AND utp.completion_percentage > 0
       )
     ORDER BY a.start_date DESC
     LIMIT 10`,
    [USER_ID, BUFFER_M]
  );
  return rows;
}

async function fetchTrailNames(activityId) {
  const { rows } = await pool.query(
    `SELECT t.name
     FROM activities a
     JOIN trails t ON ST_DWithin(a.geometry::geography, t.geometry::geography, $3)
     JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
     WHERE a.id = $1
       AND a.user_id = $2
       AND a.geometry IS NOT NULL
       AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
    [activityId, USER_ID, BUFFER_M]
  );
  return rows.map(r => r.name);
}

// Per-activity trail distance: length of intersection between the activity
// track and a 50 m buffer around the trail geometry.
async function fetchMatchesWithDistance(activityId) {
  const { rows } = await pool.query(
    `SELECT t.name,
            t.total_distance,
            utp.completed_distance,
            utp.completion_percentage,
            COALESCE(
              ST_Length(
                ST_Intersection(
                  a.geometry,
                  ST_Buffer(t.geometry::geography, $3)::geometry
                )::geography
              ),
              0
            ) AS activity_distance_m
     FROM activities a
     JOIN trails t ON ST_DWithin(a.geometry::geography, t.geometry::geography, $3)
     JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = a.user_id
     WHERE a.id = $1
       AND a.user_id = $2
       AND a.geometry IS NOT NULL
       AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
    [activityId, USER_ID, BUFFER_M]
  );
  return rows;
}

// ── Description builder ────────────────────────────────────────────────────

function buildBlock(matches) {
  const trailLines = matches.map(m => {
    const actKm  = (m.activity_distance_m / 1000).toFixed(1);
    const pct    = Math.round(m.completion_percentage);
    const doneKm = (m.completed_distance  / 1000).toFixed(1);
    const totKm  = (m.total_distance      / 1000).toFixed(0);
    return `🥾 ${m.name}: ${actKm}km (${pct}% complete · ${doneKm}/${totKm}km)`;
  });
  return `\n\n${trailLines.join("\n")}\n📍 My Trail Log: ${APP_URL}`;
}

// Strip both old format (🥾 My Trail Log\n…) and new format (🥾 Trail: …\n📍…)
function stripBlock(desc) {
  return desc.replace(/\n\n🥾[\s\S]*$/, "").trimEnd();
}

// ── Update one activity ────────────────────────────────────────────────────

async function updateActivity(activity, token) {
  const matches = await fetchMatchesWithDistance(activity.id);
  if (matches.length === 0) {
    console.log("  No trail matches found — skipping.");
    return false;
  }

  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activity.strava_activity_id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`GET activity → HTTP ${res.status}`);
  const current = (await res.json()).description ?? "";

  const newDesc = stripBlock(current) + buildBlock(matches);
  if (newDesc === current.trimEnd()) {
    console.log("  Already up to date.");
    return false;
  }

  // Show the block that will be appended
  buildBlock(matches).trim().split("\n").forEach(l => console.log("    " + l));

  const put = await fetch(
    `https://www.strava.com/api/v3/activities/${activity.strava_activity_id}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: newDesc }),
    }
  );
  if (!put.ok) {
    const body = await put.text();
    throw new Error(`PUT → HTTP ${put.status}: ${body.slice(0, 200)}`);
  }

  await pool.query(
    `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
    [activity.id]
  );
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching recent trail-matched activities…\n");
  const activities = await fetchActivities();

  if (activities.length === 0) {
    console.log("No trail-matched activities found.");
    await pool.end();
    return;
  }

  const rows = await Promise.all(
    activities.map(async (a, i) => ({
      ...a,
      n: i + 1,
      trails: await fetchTrailNames(a.id),
    }))
  );

  const nameW = Math.min(Math.max(...rows.map(r => r.name.length), 20), 38);
  console.log(` ${"#".padEnd(2)}  ${"Activity".padEnd(nameW)}  Date        Trail(s)`);
  console.log("─".repeat(nameW + 56));
  for (const r of rows) {
    const nm = r.name.length > nameW ? r.name.slice(0, nameW - 1) + "…" : r.name;
    console.log(` ${String(r.n).padStart(2)}  ${nm.padEnd(nameW)}  ${r.date}  ${r.trails.join(", ")}`);
  }
  console.log();

  // Accept selection as CLI arg (e.g. -- all  or  -- 1,3,5) or prompt interactively
  const cliArg = process.argv[2]?.trim();
  let answer;
  if (cliArg) {
    answer = cliArg;
    console.log(`Selection: ${answer}\n`);
  } else {
    const rl = createInterface({ input, output });
    answer = (await rl.question(
      "Update which? (e.g. 1,3,5  ·  all  ·  q to quit): "
    )).trim();
    rl.close();
  }

  if (!answer || answer.toLowerCase() === "q") {
    console.log("Aborted.");
    await pool.end();
    return;
  }

  let selected;
  if (answer.toLowerCase() === "all") {
    selected = rows;
  } else {
    const nums = [...new Set(
      answer.split(/[,\s]+/)
        .map(Number)
        .filter(n => Number.isInteger(n) && n >= 1 && n <= rows.length)
    )];
    selected = nums.map(n => rows[n - 1]);
  }

  if (selected.length === 0) {
    console.log("No valid selections.");
    await pool.end();
    return;
  }

  const token = await getToken();
  let updated = 0;

  for (const activity of selected) {
    console.log(`\n[${activity.n}] ${activity.name} (${activity.date})`);
    try {
      if (await updateActivity(activity, token)) updated++;
    } catch (err) {
      console.error("  ✗", err.message);
    }
  }

  console.log(`\nDone — ${updated} of ${selected.length} updated.`);
  await pool.end();
}

main().catch(err => { console.error(err); pool.end(); process.exit(1); });
