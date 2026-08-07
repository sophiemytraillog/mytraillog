/**
 * Manually resumes a stuck sync for one user, driving the exact same
 * forward/backward-pass logic as src/lib/sync-engine.ts's runSyncChunk,
 * looping server-side (no browser/EventSource involved) until Strava
 * reports no more pages in either direction. Then runs trail matching for
 * every trail near any of the user's activities (not just ones inserted in
 * the final chunk — see the root-cause note in the accompanying commit:
 * matching used to only ever see the LAST chunk's newDbIds).
 *
 * Usage:
 *   node --env-file=.env.local scripts/resume-sync.mjs --user <uuid>
 */
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const PER_PAGE = 30;
const PAGE_DELAY_MS = 2000;

const SYNC_ACTIVITY_TYPES = new Set(["Run", "TrailRun", "Walk", "Hike"]);
const CYCLING_ACTIVITY_TYPES = new Set(["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"]);
const ALL_TRACKED_ACTIVITY_TYPES = new Set([...SYNC_ACTIVITY_TYPES, ...CYCLING_ACTIVITY_TYPES]);

function decodePolylineToWKT(encoded) {
  if (!encoded) return null;
  // Standard Google polyline algorithm (matches @mapbox/polyline decode)
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lat / 1e5, lng / 1e5]);
  }
  if (coords.length < 2) return null;
  const pts = coords.map(([la, ln]) => `${ln} ${la}`).join(", ");
  return `LINESTRING(${pts})`;
}

async function getValidAccessToken(userId) {
  const { rows: [u] } = await pool.query(
    "SELECT strava_access_token, strava_refresh_token, strava_token_expires_at FROM users WHERE id = $1",
    [userId]
  );
  if (!u) throw new Error(`User ${userId} not found`);
  if (new Date(u.strava_token_expires_at).getTime() > Date.now() + 5 * 60_000) {
    return u.strava_access_token;
  }
  console.log("  Refreshing Strava token…");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: u.strava_refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const t = await res.json();
  await pool.query(
    "UPDATE users SET strava_access_token=$1, strava_refresh_token=$2, strava_token_expires_at=to_timestamp($3), updated_at=NOW() WHERE id=$4",
    [t.access_token, t.refresh_token, t.expires_at, userId]
  );
  return t.access_token;
}

// One full pass (forward AND backward), no time budget — this is a
// one-shot server-side script, not a Vercel function, so it can run to
// completion in one go instead of chunking.
async function runFullSync(userId) {
  const accessToken = await getValidAccessToken(userId);
  let fetched = 0, saved = 0;
  const newDbIds = [];

  const savePage = async (activities) => {
    let pageNew = 0;
    for (const activity of activities) {
      const type = activity.sport_type || activity.type;
      if (!ALL_TRACKED_ACTIVITY_TYPES.has(type)) continue;
      const wkt = decodePolylineToWKT(activity.map?.summary_polyline);
      const result = await pool.query(
        `INSERT INTO activities (
           user_id, strava_activity_id, name, activity_type,
           distance, moving_time, start_date, polyline, geometry
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
           ST_GeomFromText($9, 4326))
         ON CONFLICT (strava_activity_id) DO NOTHING
         RETURNING id`,
        [userId, activity.id, activity.name, type, activity.distance,
         activity.moving_time, activity.start_date, activity.map?.summary_polyline ?? null, wkt]
      );
      if ((result.rowCount ?? 0) > 0) { pageNew++; newDbIds.push(result.rows[0].id); }
    }
    return pageNew;
  };

  const fetchPage = async (params) => {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("per_page", String(PER_PAGE));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "900");
      throw new Error(`Strava rate limited — retry after ${retryAfter}s`);
    }
    if (!res.ok) throw new Error(`Strava API error ${res.status}: ${await res.text()}`);
    return res.json();
  };

  await pool.query("UPDATE users SET sync_status = 'syncing', sync_progress_at = NOW() WHERE id = $1", [userId]);

  const boundsRow = await pool.query(
    `SELECT EXTRACT(EPOCH FROM MAX(start_date))::bigint AS after_unix,
            EXTRACT(EPOCH FROM MIN(start_date))::bigint AS before_unix,
            COUNT(*)::text AS count
     FROM activities WHERE user_id = $1`,
    [userId]
  );
  const existingCount = parseInt(boundsRow.rows[0]?.count ?? "0");
  const afterUnix = boundsRow.rows[0]?.after_unix ? parseInt(boundsRow.rows[0].after_unix) : null;
  const beforeUnix = boundsRow.rows[0]?.before_unix ? parseInt(boundsRow.rows[0].before_unix) : null;

  if (afterUnix !== null) {
    console.log("  Forward pass (newer activities)…");
    for (let page = 1; ; page++) {
      if (page > 1) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      const activities = await fetchPage({ page, after: afterUnix });
      if (activities.length === 0) break;
      fetched += activities.length;
      saved += await savePage(activities);
      console.log(`    page ${page}: ${activities.length} fetched, running total ${saved} saved`);
      if (activities.length < PER_PAGE) break;
    }
  }

  let cursor = beforeUnix !== null ? beforeUnix - 1 : null;
  if (cursor !== null || existingCount === 0) {
    console.log("  Backward pass (older activities)…");
    while (true) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      const params = {};
      if (cursor !== null) params.before = cursor;
      const activities = await fetchPage(params);
      if (activities.length === 0) break;
      fetched += activities.length;
      saved += await savePage(activities);
      console.log(`    before=${cursor}: ${activities.length} fetched, running total ${saved} saved`);
      const oldest = activities[activities.length - 1].start_date;
      cursor = Math.floor(new Date(oldest).getTime() / 1000) - 1;
      if (activities.length < PER_PAGE) break;
    }
  }

  await pool.query(
    "UPDATE users SET sync_status = 'complete', last_synced_at = NOW() WHERE id = $1",
    [userId]
  );

  return { fetched, saved, newDbIds };
}

const MATCH_SQL = `
  WITH
  combined_buffer AS (
    SELECT
      ST_Union(ST_Buffer(a.geometry::geography, 50)::geometry) AS geom,
      COUNT(DISTINCT a.id)  AS activity_count,
      MIN(a.start_date)     AS first_date,
      MAX(a.start_date)     AS last_date
    FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
          FROM trails WHERE id = $2) t_simplified
    JOIN activities a
      ON  a.user_id = $1
      AND a.geometry IS NOT NULL
      AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, 250)
  ),
  coverage AS (
    SELECT
      t.id AS trail_id, t.total_distance,
      ST_CollectionExtract(ST_Intersection(t.geometry, cb.geom), 2) AS covered_geom,
      cb.activity_count, cb.first_date, cb.last_date
    FROM (SELECT id, total_distance, geometry FROM trails WHERE id = $2) t
    CROSS JOIN combined_buffer cb
    WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
  )
  INSERT INTO user_trail_progress (
    user_id, trail_id, completed_distance, completion_percentage,
    completed_geometry, activity_count, first_activity_date, last_activity_date
  )
  SELECT
    $1, trail_id,
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0 ELSE ST_Length(covered_geom::geography) END,
    LEAST(CASE WHEN total_distance > 0 THEN ST_Length(covered_geom::geography) / total_distance * 100 ELSE 0 END, 100),
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
         ELSE ST_SetSRID(ST_Multi(covered_geom), 4326)::geometry(MultiLineString,4326) END,
    activity_count, first_date, last_date
  FROM coverage
  WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
  ON CONFLICT (user_id, trail_id) DO UPDATE SET
    completed_distance = EXCLUDED.completed_distance,
    completion_percentage = EXCLUDED.completion_percentage,
    completed_geometry = EXCLUDED.completed_geometry,
    activity_count = EXCLUDED.activity_count,
    first_activity_date = EXCLUDED.first_activity_date,
    last_activity_date = EXCLUDED.last_activity_date,
    updated_at = NOW()
  RETURNING trail_id`;

const ACTIVITY_MATCH_SQL = `
  INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
  SELECT DISTINCT a.id, $2::uuid, $1::uuid
  FROM activities a
  CROSS JOIN (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
              FROM trails WHERE id = $2::uuid) t_simplified
  WHERE a.user_id = $1::uuid
    AND a.geometry IS NOT NULL
    AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
    AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, 250)
  ON CONFLICT (activity_id, trail_id) DO NOTHING`;

async function matchAllTrailsForUser(userId) {
  const { rows: [prefs] } = await pool.query("SELECT include_cycling FROM users WHERE id = $1", [userId]);
  const includeCycling = prefs?.include_cycling ?? false;
  const cyclingTypes = Array.from(CYCLING_ACTIVITY_TYPES);

  const { rows: trails } = await pool.query("SELECT id, name FROM trails ORDER BY name");
  let matched = 0;
  for (const trail of trails) {
    const client = await pool.connect();
    // Without this, a transient connection drop (which does happen over a
    // long-running loop touching ~1180 trails) fires an unhandled 'error'
    // event on the pg Client and crashes the whole process — pool.connect()
    // reuses client objects, so a stale listener from theoretically wrong;
    // still, always attach fresh so nothing is ever unhandled.
    client.removeAllListeners("error");
    client.on("error", (err) => {
      console.error(`    connection error on ${trail.name}:`, err.message);
    });
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '180000'");
      const result = await client.query(MATCH_SQL, [userId, trail.id, includeCycling, cyclingTypes]);
      await client.query("COMMIT");
      if ((result.rowCount ?? 0) > 0) {
        matched++;
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '180000'");
        await client.query(ACTIVITY_MATCH_SQL, [userId, trail.id, includeCycling, cyclingTypes]);
        await client.query(
          "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
          [userId, trail.id]
        );
        await client.query("COMMIT");
        console.log(`    matched: ${trail.name}`);
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`    error on ${trail.name}:`, err.message);
    } finally {
      client.release();
    }
  }
  return matched;
}

const userArg = process.argv.includes("--user")
  ? process.argv[process.argv.indexOf("--user") + 1]
  : null;
const matchOnly = process.argv.includes("--match-only");
if (!userArg) {
  console.error("Usage: node --env-file=.env.local scripts/resume-sync.mjs --user <uuid> [--match-only]");
  process.exit(1);
}

(async () => {
  const { rows: [user] } = await pool.query("SELECT first_name, last_name FROM users WHERE id = $1", [userArg]);
  if (!user) { console.error("No such user."); await pool.end(); process.exit(1); }
  console.log(`${matchOnly ? "Matching only" : "Resuming sync"} for ${user.first_name} ${user.last_name} (${userArg})\n`);

  if (!matchOnly) {
    let totalFetched = 0, totalSaved = 0;
    for (let round = 1; ; round++) {
      console.log(`--- Round ${round} ---`);
      const { fetched, saved } = await runFullSync(userArg);
      totalFetched += fetched;
      totalSaved += saved;
      console.log(`  Round ${round} done: ${fetched} fetched, ${saved} saved this round.\n`);
      if (fetched === 0) break; // nothing left in either direction
    }
    console.log(`Sync complete. Total: ${totalFetched} fetched, ${totalSaved} saved.\n`);
  }

  console.log("Running trail matching for ALL trails (covers every activity, not just the last chunk)…");
  const matched = await matchAllTrailsForUser(userArg);
  console.log(`\nDone. ${matched} trail(s) matched.`);

  const final = await pool.query(
    "SELECT sync_status, last_synced_at FROM users WHERE id = $1",
    [userArg]
  );
  const progress = await pool.query("SELECT COUNT(*) FROM user_trail_progress WHERE user_id = $1", [userArg]);
  console.log("\nFinal state:", final.rows[0], "| trail progress rows:", progress.rows[0].count);

  await pool.end();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
