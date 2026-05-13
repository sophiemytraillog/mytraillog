/**
 * Import the Cornwall Coast to Coast (Mineral Tramways) trail.
 * 1. Tries Overpass API first.
 * 2. Falls back to manual waypoints if OSM has no usable geometry.
 * 3. Runs the matching engine for all users against the new trail.
 *
 * Run with:  node --env-file=.env.local scripts/import-cornwall-c2c.mjs
 */

import pg from "pg";
const { Pool } = pg;

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Cornwall bbox (south, west, north, east) — broad enough to catch the full route
const CORNWALL_BBOX = "50.15,-5.40,50.40,-5.00";

const OVERPASS_QUERY = `
[out:json][timeout:60];
(
  relation["type"="route"]["name"~"Mineral Tramways|Coast to Coast|Bissoe",i](${CORNWALL_BBOX});
  relation["type"="route"]["route"~"hiking|foot|bicycle"]["name"~"Mineral Tramways|Coast to Coast|Bissoe",i](${CORNWALL_BBOX});
);
out body geom;
`.trim();

// Manual waypoints (Portreath → Devoran) — used only if OSM fails
const MANUAL_COORDS = [
  [-5.2879, 50.2679], // Portreath (start)
  [-5.2640, 50.2550], // Cambrose
  [-5.2340, 50.2481], // Wheal Rose
  [-5.2111, 50.2353], // Scorrier
  [-5.1986, 50.2345], // Wheal Busy
  [-5.1740, 50.2339], // Twelveheads
  [-5.1589, 50.2248], // Bissoe
  [-5.1333, 50.2064], // Devoran (end)
];

const TRAIL_NAME = "Mineral Tramways Coast to Coast Trail";
const TRAIL_SLUG = "mineral-tramways-coast-to-coast-trail";
const TRAIL_REGION = "South West England";
const TRAIL_CATEGORY = "long_distance_path";

const BUFFER_METRES = 50;

function buildMultiLineStringGeoJSON(relation) {
  const lines = [];
  for (const member of relation.members ?? []) {
    if (member.type !== "way") continue;
    if (!member.geometry || member.geometry.length < 2) continue;
    lines.push(member.geometry.map(({ lat, lon }) => [lon, lat]));
  }
  if (lines.length === 0) return null;
  return JSON.stringify({ type: "MultiLineString", coordinates: lines });
}

function manualLineStringGeoJSON() {
  return JSON.stringify({ type: "LineString", coordinates: MANUAL_COORDS });
}

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

async function main() {
  // ── 1. Try Overpass ───────────────────────────────────────────────────────
  console.log("Querying Overpass API for Cornwall Coast to Coast / Mineral Tramways…");
  let geojson = null;
  let sourceName = TRAIL_NAME;
  let sourceTag = "osm";

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "MyTrailLog/1.0 (trail progress tracker; sophie@raisethebarfm.co.uk)",
      },
      body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const { elements } = await resp.json();
    const relations = elements.filter(e => e.type === "relation");
    console.log(`  Overpass returned ${relations.length} matching relation(s).`);

    for (const rel of relations) {
      const name = rel.tags?.name ?? "(unnamed)";
      console.log(`  Found: "${name}" (OSM id ${rel.id})`);
      const g = buildMultiLineStringGeoJSON(rel);
      if (g) {
        geojson = g;
        sourceName = name;
        console.log(`  Using geometry from OSM relation ${rel.id}.`);
        break;
      }
      console.log(`  → No usable geometry, trying next…`);
    }

    if (!geojson) console.log("  No usable OSM geometry found — falling back to manual waypoints.");
  } catch (err) {
    console.warn(`  Overpass query failed (${err.message}) — falling back to manual waypoints.`);
  }

  if (!geojson) {
    geojson = manualLineStringGeoJSON();
    sourceTag = "manual";
    console.log("  Using manual waypoints: Portreath → Cambrose → Wheal Rose → Scorrier → Wheal Busy → Twelveheads → Bissoe → Devoran");
  }

  // ── 2. Insert trail ───────────────────────────────────────────────────────
  console.log(`\nConnecting to ${process.env.PGHOST}/${process.env.PGDATABASE}…`);
  const client = await pool.connect();
  console.log("Connected.\n");

  let trailId;
  try {
    // Check if slug already exists
    const { rows: existing } = await client.query(
      "SELECT id, name FROM trails WHERE slug = $1", [TRAIL_SLUG]
    );

    if (existing.length > 0) {
      console.log(`Trail "${existing[0].name}" already exists (id ${existing[0].id}). Updating geometry…`);
      const { rows } = await client.query(
        `UPDATE trails
         SET name = $1, region = $2, category = $3, source = $4,
             geometry = ST_LineMerge(ST_GeomFromGeoJSON($5)),
             total_distance = ROUND(ST_Length(ST_LineMerge(ST_GeomFromGeoJSON($5))::geography)::numeric),
             updated_at = NOW()
         WHERE slug = $6
         RETURNING id, name, total_distance`,
        [TRAIL_NAME, TRAIL_REGION, TRAIL_CATEGORY, sourceTag, geojson, TRAIL_SLUG]
      );
      trailId = rows[0].id;
      console.log(`  Updated: "${rows[0].name}" — ${(rows[0].total_distance / 1000).toFixed(1)} km`);
    } else {
      const { rows } = await client.query(
        `INSERT INTO trails (name, slug, region, total_distance, geometry, source, category)
         SELECT $1, $2, $3,
                ROUND(ST_Length(ST_LineMerge(ST_GeomFromGeoJSON($5))::geography)::numeric),
                ST_LineMerge(ST_GeomFromGeoJSON($5)),
                $4,
                $6
         RETURNING id, name, total_distance`,
        [TRAIL_NAME, TRAIL_SLUG, TRAIL_REGION, sourceTag, geojson, TRAIL_CATEGORY]
      );
      trailId = rows[0].id;
      console.log(`  Inserted: "${rows[0].name}" — ${(rows[0].total_distance / 1000).toFixed(1)} km (id ${trailId})`);
    }
  } finally {
    client.release();
  }

  // ── 3. Run matching for all users against this trail only ─────────────────
  console.log("\nRunning matching engine against all activities…");

  const { rows: users } = await pool.query(
    "SELECT id, first_name, last_name, include_cycling FROM users ORDER BY created_at"
  );

  if (users.length === 0) {
    console.log("No users found.");
  }

  for (const user of users) {
    console.log(`\nMatching for ${user.first_name} ${user.last_name} (cycling: ${user.include_cycling})…`);

    const matchClient = await pool.connect();
    try {
      await matchClient.query("SET statement_timeout = '180000'");

      // Build activity type filter matching what the app uses
      const activityFilter = user.include_cycling
        ? `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun','Ride','GravelRide','MountainBikeRide')`
        : `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun')`;

      const { rowCount, rows: matchRows } = await matchClient.query(
        `WITH
         combined_buffer AS (
           SELECT
             ST_Union(ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry) AS geom,
             COUNT(DISTINCT a.id)  AS activity_count,
             MIN(a.start_date)     AS first_date,
             MAX(a.start_date)     AS last_date
           FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
                 FROM trails WHERE id = $2) t_simplified
           JOIN activities a
             ON  a.user_id = $1
             AND a.geometry IS NOT NULL
             AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES})
             ${activityFilter}
         ),
         coverage AS (
           SELECT
             t.id             AS trail_id,
             t.total_distance,
             ST_CollectionExtract(
               ST_Intersection(t.geometry, cb.geom),
               2
             )                AS covered_geom,
             cb.activity_count,
             cb.first_date,
             cb.last_date
           FROM (SELECT id, total_distance, geometry FROM trails WHERE id = $2) t
           CROSS JOIN combined_buffer cb
           WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
         )
         INSERT INTO user_trail_progress (
           user_id, trail_id,
           completed_distance, completion_percentage,
           completed_geometry,
           activity_count, first_activity_date, last_activity_date
         )
         SELECT
           $1, trail_id,
           CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0
                ELSE ST_Length(covered_geom::geography) END,
           LEAST(
             CASE WHEN total_distance > 0
                  THEN ST_Length(covered_geom::geography) / total_distance * 100
                  ELSE 0 END,
             100
           ),
           CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
                ELSE ST_SetSRID(ST_Multi(covered_geom), 4326)::geometry(MultiLineString,4326) END,
           activity_count, first_date, last_date
         FROM coverage
         WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
         ON CONFLICT (user_id, trail_id) DO UPDATE SET
           completed_distance    = EXCLUDED.completed_distance,
           completion_percentage = EXCLUDED.completion_percentage,
           completed_geometry    = EXCLUDED.completed_geometry,
           activity_count        = EXCLUDED.activity_count,
           first_activity_date   = EXCLUDED.first_activity_date,
           last_activity_date    = EXCLUDED.last_activity_date,
           updated_at            = NOW()
         RETURNING
           completed_distance,
           completion_percentage,
           activity_count`,
        [user.id, trailId]
      );

      if (rowCount && rowCount > 0) {
        const r = matchRows[0];
        const pct = Math.round(r.completion_percentage);
        const km = (r.completed_distance / 1000).toFixed(1);
        const miles = (r.completed_distance / 1609.344).toFixed(1);
        console.log(`  ✓ Match found!`);
        console.log(`    Coverage:   ${pct}%`);
        console.log(`    Distance:   ${km} km (${miles} mi)`);
        console.log(`    Activities: ${r.activity_count}`);
      } else {
        console.log("  No coverage found.");
      }
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    } finally {
      matchClient.release();
    }
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch(err => {
  console.error("\nFatal:", err.message ?? err);
  process.exit(1);
});
