/**
 * Backfills full-resolution GPS polylines for activities whose
 * summary_polyline (all a normal sync ever gets) is too coarse for
 * accurate trail matching — see src/lib/detail-polyline.ts's doc comment
 * for the confirmed root cause (Luke Davis's Hadrian's Wall Path: a
 * 170km/34hr walk with only 156 summary_polyline points against the
 * trail's own 2,328-point reference geometry).
 *
 * Standalone, not importing src/lib (same convention as resume-sync.mjs —
 * a plain node script, no bundler/path-alias resolution available), so the
 * Strava-fetch, decode, and trail-recompute logic below deliberately
 * mirrors — not shares — the real implementation in
 * src/lib/detail-polyline.ts and match-trails.ts.
 *
 * Usage:
 *   node --env-file=.env.local scripts/backfill-detail-polylines.mjs [--user <uuid>] [--limit N]
 *
 * Without --user, processes every user with any needs_detail_polyline=TRUE
 * activity, one user at a time. --limit caps how many activities are
 * processed per user in this run (default: all of that user's backlog).
 */
import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ ssl: { rejectUnauthorized: false } });

pool.on("error", (err) => {
  console.error("[pool] Idle pool client error:", err.message);
});

const CALL_DELAY_MS = 300;
const NEARBY_TRAILS_BBOX_DEGREES = 0.003;
const BUFFER_METRES = 50;
const SIMPLIFY_MARGIN = 200;
const MATCH_BBOX_MARGIN_DEGREES = 0.003;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodePolylineToWKT(encoded) {
  if (!encoded) return null;
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
  return { wkt: `LINESTRING(${pts})`, numPoints: coords.length };
}

async function getValidAccessToken(userId, forceRefresh = false) {
  const { rows: [u] } = await pool.query(
    "SELECT strava_access_token, strava_refresh_token, strava_token_expires_at FROM users WHERE id = $1",
    [userId]
  );
  if (!u) throw new Error(`User ${userId} not found`);
  if (!forceRefresh && new Date(u.strava_token_expires_at).getTime() > Date.now() + 5 * 60_000) {
    return u.strava_access_token;
  }
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

async function fetchDetailPolyline(userId, stravaActivityId) {
  let token = await getValidAccessToken(userId);
  let res = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    token = await getValidAccessToken(userId, true);
    res = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "900");
    return { outcome: "rate_limited", retryAfterSeconds: retryAfter };
  }
  if (res.status === 401 || res.status === 403) return { outcome: "scope_error" };
  if (res.status === 404 || res.status === 410) return { outcome: "not_found" };
  if (!res.ok) return { outcome: "error", message: `HTTP ${res.status}: ${await res.text()}` };

  const body = await res.json();
  const rawPolyline = body.map?.polyline || body.map?.summary_polyline || null;
  const decoded = decodePolylineToWKT(rawPolyline);
  if (!decoded) return { outcome: "no_geometry" };
  return { outcome: "success", wkt: decoded.wkt, numPoints: decoded.numPoints, rawPolyline, rawDistance: body.distance };
}

// Real intersection recompute for one trail — same MATCH_SQL/ACTIVITY_MATCH_SQL
// shape as resume-sync.mjs / src/lib/match-trails.ts.
async function recomputeTrail(userId, trailId, includeCycling, cyclingTypes) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '180000'");
    const result = await client.query(
      `WITH
       combined_buffer AS (
         SELECT ST_Union(ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry) AS geom,
                COUNT(DISTINCT a.id) AS activity_count, MIN(a.start_date) AS first_date, MAX(a.start_date) AS last_date
         FROM (SELECT simplified_geometry AS geometry FROM trails WHERE id = $2) t_simplified
         JOIN activities a ON a.user_id = $1 AND a.geometry IS NOT NULL
           AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
           AND a.geometry && ST_Expand(t_simplified.geometry, ${MATCH_BBOX_MARGIN_DEGREES})
           AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
       ),
       coverage AS (
         SELECT t.id AS trail_id, t.total_distance,
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
       SELECT $1, trail_id,
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
       RETURNING trail_id, completion_percentage`,
      [userId, trailId, includeCycling, cyclingTypes]
    );
    await client.query("COMMIT");

    const wasMatched = (result.rowCount ?? 0) > 0;
    if (wasMatched) {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '180000'");
      await client.query(
        `INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
         SELECT DISTINCT a.id, $2::uuid, $1::uuid
         FROM activities a
         CROSS JOIN (SELECT simplified_geometry AS geometry FROM trails WHERE id = $2::uuid) t_simplified
         WHERE a.user_id = $1::uuid AND a.geometry IS NOT NULL
           AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
           AND a.geometry && ST_Expand(t_simplified.geometry, ${MATCH_BBOX_MARGIN_DEGREES})
           AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
         ON CONFLICT (activity_id, trail_id) DO NOTHING`,
        [userId, trailId, includeCycling, cyclingTypes]
      );
      await client.query(
        "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
        [userId, trailId]
      );
      await client.query("COMMIT");
    }

    await pool.query(
      `INSERT INTO trail_match_checks (user_id, trail_id, matched) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, trail_id) DO UPDATE SET matched = EXCLUDED.matched, checked_at = NOW()`,
      [userId, trailId, wasMatched]
    );

    return result.rows[0]?.completion_percentage ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`    recompute error on trail ${trailId}:`, err.message);
    return null;
  } finally {
    client.release();
  }
}

async function processActivity(userId, activity, includeCycling, cyclingTypes) {
  console.log(`  ${activity.name} (${(activity.distance / 1000).toFixed(1)}km, strava id ${activity.strava_activity_id})`);
  const result = await fetchDetailPolyline(userId, activity.strava_activity_id);

  if (result.outcome === "rate_limited") {
    console.log(`    rate limited — retry after ${result.retryAfterSeconds}s. Stopping this run.`);
    return "rate_limited";
  }
  if (result.outcome === "scope_error") {
    await pool.query("UPDATE users SET needs_reauth = TRUE WHERE id = $1", [userId]);
    console.log("    scope error — flagged needs_reauth, leaving queued for after reconnect");
    return "scope_error";
  }
  if (result.outcome === "error") {
    const { rows } = await pool.query(
      "UPDATE activities SET detail_polyline_attempts = detail_polyline_attempts + 1 WHERE id = $1 RETURNING detail_polyline_attempts",
      [activity.id]
    );
    console.log(`    error: ${result.message} (attempt ${rows[0]?.detail_polyline_attempts})`);
    if ((rows[0]?.detail_polyline_attempts ?? 0) >= 3) {
      await pool.query(
        "UPDATE activities SET needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW() WHERE id = $1",
        [activity.id]
      );
      console.log("    giving up after 3 attempts");
    }
    return "error";
  }
  if (result.outcome === "not_found" || result.outcome === "no_geometry") {
    await pool.query(
      "UPDATE activities SET needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW() WHERE id = $1",
      [activity.id]
    );
    console.log(`    ${result.outcome} — checkpointed, nothing more to fetch`);
    return result.outcome;
  }

  // success
  console.log(`    fetched full-resolution polyline: ${result.numPoints} points (was ${activity.old_num_points ?? "?"})`);
  await pool.query(
    `UPDATE activities SET polyline = $2, geometry = ST_GeomFromText($3, 4326),
       needs_detail_polyline = FALSE, detail_polyline_fetched_at = NOW()
     WHERE id = $1`,
    [activity.id, result.rawPolyline, result.wkt]
  );

  const { rows: nearbyTrails } = await pool.query(
    `SELECT t.id, t.name FROM activities a
     JOIN trails t ON t.simplified_geometry && ST_Expand(a.geometry, ${NEARBY_TRAILS_BBOX_DEGREES})
     WHERE a.id = $1 AND a.geometry IS NOT NULL`,
    [activity.id]
  );
  console.log(`    recomputing ${nearbyTrails.length} nearby trail(s)…`);
  for (const trail of nearbyTrails) {
    const pct = await recomputeTrail(userId, trail.id, includeCycling, cyclingTypes);
    if (pct !== null) console.log(`      ${trail.name}: ${pct.toFixed(1)}%`);
  }

  return "success";
}

async function processUser(userId, limit) {
  const { rows: [user] } = await pool.query("SELECT first_name, last_name, include_cycling FROM users WHERE id = $1", [userId]);
  if (!user) { console.error("No such user."); return; }
  const cyclingTypes = ["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"];

  console.log(`\n=== ${user.first_name} ${user.last_name ?? ""} (${userId}) ===`);

  const { rows: activities } = await pool.query(
    `SELECT id, strava_activity_id::text, name, distance FROM activities
     WHERE user_id = $1 AND needs_detail_polyline = TRUE
     ORDER BY distance DESC
     ${limit ? "LIMIT $2" : ""}`,
    limit ? [userId, limit] : [userId]
  );
  console.log(`${activities.length} activit${activities.length === 1 ? "y" : "ies"} queued`);

  let succeeded = 0;
  for (let i = 0; i < activities.length; i++) {
    if (i > 0) await sleep(CALL_DELAY_MS);
    const outcome = await processActivity(userId, activities[i], user.include_cycling, cyclingTypes);
    if (outcome === "rate_limited") break;
    if (outcome === "success") succeeded++;
  }
  console.log(`Done: ${succeeded}/${activities.length} succeeded for ${user.first_name}.`);
}

const userArg = process.argv.includes("--user") ? process.argv[process.argv.indexOf("--user") + 1] : null;
const limitArg = process.argv.includes("--limit") ? parseInt(process.argv[process.argv.indexOf("--limit") + 1]) : null;

(async () => {
  if (userArg) {
    await processUser(userArg, limitArg);
  } else {
    const { rows: users } = await pool.query(
      `SELECT DISTINCT user_id FROM activities WHERE needs_detail_polyline = TRUE`
    );
    console.log(`${users.length} user(s) with queued activities.`);
    for (const { user_id } of users) {
      await processUser(user_id, limitArg);
    }
  }
  await pool.end();
})().catch(async (e) => {
  console.error("FATAL:", e.message);
  await pool.end();
  process.exit(1);
});
