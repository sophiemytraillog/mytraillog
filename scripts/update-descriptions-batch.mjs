/**
 * Batch-update Strava activity descriptions with trail progress info.
 * Only processes activities that have a trail match and haven't been updated yet.
 * Marks each activity with strava_description_updated = true on success.
 *
 * Usage:
 *   node --env-file=.env.local scripts/update-descriptions-batch.mjs
 */
import pg from "pg";
const { Pool } = pg;

const BUFFER_METRES = 50;
const BATCH_SIZE = 50;
const API_DELAY_MS = 2_000;
const MARKER = "🥾 My Trail Log:";

const pool = new Pool({ ssl: { rejectUnauthorized: false } });
pool.on("error", (err) => console.warn("Pool background error:", err.message));

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchStrava(url, options) {
  const res = await fetch(url, options);
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "900");
    console.log(`  429 rate limited — waiting ${retryAfter}s before retry…`);
    await sleep(retryAfter * 1000);
    return fetch(url, options);
  }
  return res;
}

function buildTrailBlock(matches) {
  const lines = matches.map((m) => {
    const km = (m.completed_distance / 1000).toFixed(1);
    const pct = Math.round(m.completion_percentage);
    return `${MARKER} ${m.name} — ${km}km completed (${pct}% total)`;
  });
  return `\n\n${lines.join("\n")}`;
}

// ── 1. Add column if missing ─────────────────────────────────────────────────

await pool.query(
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS strava_description_updated BOOLEAN NOT NULL DEFAULT FALSE`
);
console.log("Column strava_description_updated ensured.\n");

// ── 2. Get user + valid access token ────────────────────────────────────────

const { rows: [user] } = await pool.query(
  `SELECT id, first_name, strava_access_token, strava_refresh_token, strava_token_expires_at
   FROM users LIMIT 1`
);
console.log(`User: ${user.first_name} (${user.id})`);

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
  await pool.query(
    `UPDATE users SET strava_access_token = $1, strava_refresh_token = $2,
     strava_token_expires_at = to_timestamp($3), updated_at = NOW() WHERE id = $4`,
    [tokens.access_token, tokens.refresh_token, tokens.expires_at, user.id]
  );
  console.log("Token refreshed OK");
}

// ── 3. Find activities with trail matches, not yet updated ───────────────────

console.log("\nFinding matched activities…");

const { rows: userTrails } = await pool.query(
  `SELECT trail_id FROM user_trail_progress WHERE user_id = $1 AND completion_percentage > 0`,
  [user.id]
);
console.log(`Trails with progress: ${userTrails.length}`);

const matchedIds = new Set();
for (const { trail_id } of userTrails) {
  const client = await pool.connect();
  let queryErr = null;
  try {
    await client.query("SET statement_timeout = '120000'");
    const { rows } = await client.query(
      `SELECT a.id
       FROM activities a
       WHERE a.user_id = $1
         AND a.geometry IS NOT NULL
         AND a.strava_description_updated = FALSE
         AND ST_DWithin(
           a.geometry::geography,
           (SELECT geometry::geography FROM trails WHERE id = $2),
           $3
         )`,
      [user.id, trail_id, BUFFER_METRES]
    );
    for (const { id } of rows) matchedIds.add(id);
  } catch (err) {
    queryErr = err;
    console.warn(`  Spatial query for trail ${trail_id} failed:`, err.message);
  } finally {
    client.release(queryErr != null);
  }
}

if (matchedIds.size === 0) {
  console.log("No unupdated activities found — all done.");
  await pool.end();
  process.exit(0);
}

// Fetch full details, ordered by date
const { rows: activities } = await pool.query(
  `SELECT id, strava_activity_id, name
   FROM activities
   WHERE id = ANY($1::uuid[])
   ORDER BY start_date DESC`,
  [Array.from(matchedIds)]
);
console.log(`Activities to update: ${activities.length}\n`);

// ── 4. Process in batches ────────────────────────────────────────────────────

let totalUpdated = 0;
let totalSkipped = 0;
let totalErrors = 0;

for (let batchStart = 0; batchStart < activities.length; batchStart += BATCH_SIZE) {
  const batch = activities.slice(batchStart, batchStart + BATCH_SIZE);
  const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(activities.length / BATCH_SIZE);
  console.log(`── Batch ${batchNum}/${totalBatches} (activities ${batchStart + 1}–${batchStart + batch.length}) ──`);

  let batchUpdated = 0;
  let batchSkipped = 0;
  let batchErrors = 0;

  for (const act of batch) {
    // Get trail matches for this activity
    const { rows: matches } = await pool.query(
      `SELECT t.name, utp.completed_distance, utp.completion_percentage
       FROM trails t
       JOIN user_trail_progress utp ON utp.trail_id = t.id AND utp.user_id = $1
       WHERE ST_DWithin(
         (SELECT geometry FROM activities WHERE id = $2)::geography,
         t.geometry::geography,
         $3
       )
       AND utp.completion_percentage > 0
       ORDER BY utp.completion_percentage DESC`,
      [user.id, act.id, BUFFER_METRES]
    );

    if (matches.length === 0) {
      console.log(`  SKIP  "${act.name}" — no trail match`);
      batchSkipped++;
      continue;
    }

    // GET current description
    await sleep(API_DELAY_MS);
    const getRes = await fetchStrava(
      `https://www.strava.com/api/v3/activities/${act.strava_activity_id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!getRes.ok) {
      console.log(`  ERROR "${act.name}" — GET HTTP ${getRes.status}`);
      batchErrors++;
      continue;
    }

    const activity = await getRes.json();
    const currentDesc = activity.description ?? "";
    const baseDesc = currentDesc.replace(/\n\n🥾 My Trail Log:[\s\S]*$/, "").trimEnd();
    const newDesc = baseDesc + buildTrailBlock(matches);

    if (newDesc === currentDesc.trimEnd()) {
      console.log(`  OK    "${act.name}" — already up to date`);
      await pool.query(
        `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
        [act.id]
      );
      batchSkipped++;
      continue;
    }

    // PUT updated description
    await sleep(API_DELAY_MS);
    const putRes = await fetchStrava(
      `https://www.strava.com/api/v3/activities/${act.strava_activity_id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ description: newDesc }),
      }
    );

    if (!putRes.ok) {
      const body = await putRes.text();
      console.log(`  ERROR "${act.name}" — PUT HTTP ${putRes.status}: ${body.slice(0, 120)}`);
      batchErrors++;
      continue;
    }

    const trailNames = matches.map((m) => m.name).join(", ");
    console.log(`  UPDATED "${act.name}" — ${trailNames}`);
    await pool.query(
      `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
      [act.id]
    );
    batchUpdated++;
  }

  totalUpdated += batchUpdated;
  totalSkipped += batchSkipped;
  totalErrors += batchErrors;

  console.log(`  Batch ${batchNum} done — updated: ${batchUpdated}, skipped: ${batchSkipped}, errors: ${batchErrors}`);
  console.log(`  Running total — updated: ${totalUpdated}/${activities.length}, errors: ${totalErrors}\n`);
}

// ── 5. Summary ────────────────────────────────────────────────────────────────

console.log("════════════════════════════════════════");
console.log(`Done.`);
console.log(`  Updated : ${totalUpdated}`);
console.log(`  Skipped : ${totalSkipped}`);
console.log(`  Errors  : ${totalErrors}`);
console.log("════════════════════════════════════════");

await pool.end();
