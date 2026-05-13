/**
 * Import The Cuckoo Trail (East Sussex, Heathfield → Polegate).
 * Uses OSM relation 13139563 (route=bicycle) for geometry — the same trail
 * also has a horse relation (16341216) but the bicycle one has fuller coverage.
 * Falls back to manual waypoints if OSM geometry is unavailable.
 *
 * Run with:  node --env-file=.env.local scripts/import-cuckoo-trail.mjs
 */

import pg from "pg";
const { Pool } = pg;

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Fetch the specific OSM relation by ID (no bounding box needed)
const OVERPASS_QUERY = `[out:json][timeout:30];relation(13139563);out body geom;`;

// Manual fallback waypoints: Heathfield → Horam → Hellingly → Hailsham → Polegate
const MANUAL_COORDS = [
  [0.2495, 50.9556], // Heathfield (start)
  [0.2375, 50.9280], // Waldron / Horam area
  [0.2370, 50.9050], // Horam
  [0.2365, 50.8870], // Hellingly
  [0.2540, 50.8680], // Hailsham
  [0.2490, 50.8450], // south of Hailsham
  [0.2421, 50.8214], // Polegate (end)
];

const TRAIL_NAME   = "The Cuckoo Trail";
const TRAIL_SLUG   = "the-cuckoo-trail";
const TRAIL_REGION = "South East England";
const TRAIL_CATEGORY = "long_distance_path";
const BUFFER_METRES = 50;

function buildMultiLineStringGeoJSON(relation) {
  const lines = [];
  for (const member of relation.members ?? []) {
    if (member.type !== "way") continue;
    if (!member.geometry || member.geometry.length < 2) continue;
    lines.push(member.geometry.map(({ lat, lon }) => [lon, lat]));
  }
  return lines.length ? JSON.stringify({ type: "MultiLineString", coordinates: lines }) : null;
}

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

async function main() {
  // ── 1. Fetch from OSM ─────────────────────────────────────────────────────
  console.log("Fetching OSM relation 13139563 (The Cuckoo Trail)…");
  let geojson = null;
  let sourceTag = "osm";

  try {
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "MyTrailLog/1.0 (trail progress tracker; sophie@raisethebarfm.co.uk)",
      },
      body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { elements } = await resp.json();
    const rel = elements.find(e => e.type === "relation");
    if (rel) {
      geojson = buildMultiLineStringGeoJSON(rel);
      if (geojson) console.log(`  Got OSM geometry (${rel.members?.filter(m => m.type === "way").length} ways).`);
      else console.log("  Relation found but no usable geometry — falling back.");
    } else {
      console.log("  Relation not returned — falling back.");
    }
  } catch (err) {
    console.warn(`  Overpass error: ${err.message} — falling back to manual waypoints.`);
  }

  if (!geojson) {
    geojson = JSON.stringify({ type: "LineString", coordinates: MANUAL_COORDS });
    sourceTag = "manual";
    console.log("  Using manual waypoints.");
  }

  // ── 2. Insert / update trail ──────────────────────────────────────────────
  console.log(`\nConnecting to ${process.env.PGHOST}/${process.env.PGDATABASE}…`);
  const client = await pool.connect();
  console.log("Connected.\n");

  let trailId;
  try {
    const { rows: existing } = await client.query(
      "SELECT id, name FROM trails WHERE slug = $1", [TRAIL_SLUG]
    );

    if (existing.length > 0) {
      console.log(`"${existing[0].name}" already exists — updating geometry.`);
      const { rows } = await client.query(
        `UPDATE trails
         SET name=$1, region=$2, category=$3, source=$4,
             geometry=ST_LineMerge(ST_GeomFromGeoJSON($5)),
             total_distance=ROUND(ST_Length(ST_LineMerge(ST_GeomFromGeoJSON($5))::geography)::numeric),
             updated_at=NOW()
         WHERE slug=$6
         RETURNING id, total_distance`,
        [TRAIL_NAME, TRAIL_REGION, TRAIL_CATEGORY, sourceTag, geojson, TRAIL_SLUG]
      );
      trailId = rows[0].id;
      console.log(`  Updated — ${(rows[0].total_distance / 1000).toFixed(1)} km`);
    } else {
      const { rows } = await client.query(
        `INSERT INTO trails (name, slug, region, total_distance, geometry, source, category)
         SELECT $1,$2,$3,
                ROUND(ST_Length(ST_LineMerge(ST_GeomFromGeoJSON($5))::geography)::numeric),
                ST_LineMerge(ST_GeomFromGeoJSON($5)),
                $4,$6
         RETURNING id, total_distance`,
        [TRAIL_NAME, TRAIL_SLUG, TRAIL_REGION, sourceTag, geojson, TRAIL_CATEGORY]
      );
      trailId = rows[0].id;
      console.log(`  Inserted "${TRAIL_NAME}" — ${(rows[0].total_distance / 1000).toFixed(1)} km (id ${trailId})`);
    }
  } finally {
    client.release();
  }

  // ── 3. Match against all users' activities ────────────────────────────────
  console.log("\nRunning matching engine…");
  const { rows: users } = await pool.query(
    "SELECT id, first_name, last_name, include_cycling FROM users ORDER BY created_at"
  );

  for (const user of users) {
    const activityFilter = user.include_cycling
      ? `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun','Ride','GravelRide','MountainBikeRide')`
      : `AND a.activity_type IN ('Run','Walk','Hike','TrailRun','VirtualRun')`;

    const matchClient = await pool.connect();
    try {
      await matchClient.query("SET statement_timeout = '180000'");
      const { rowCount, rows: matchRows } = await matchClient.query(
        `WITH
         combined_buffer AS (
           SELECT ST_Union(ST_Buffer(a.geometry::geography,${BUFFER_METRES})::geometry) AS geom,
                  COUNT(DISTINCT a.id) AS activity_count,
                  MIN(a.start_date) AS first_date, MAX(a.start_date) AS last_date
           FROM (SELECT ST_SimplifyPreserveTopology(geometry,0.001) AS geometry FROM trails WHERE id=$2) ts
           JOIN activities a
             ON  a.user_id=$1 AND a.geometry IS NOT NULL
             AND ST_DWithin(a.geometry::geography, ts.geometry::geography, ${BUFFER_METRES})
             ${activityFilter}
         ),
         coverage AS (
           SELECT t.id AS trail_id, t.total_distance,
                  ST_CollectionExtract(ST_Intersection(t.geometry, cb.geom), 2) AS covered_geom,
                  cb.activity_count, cb.first_date, cb.last_date
           FROM (SELECT id, total_distance, geometry FROM trails WHERE id=$2) t
           CROSS JOIN combined_buffer cb
           WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
         )
         INSERT INTO user_trail_progress
           (user_id, trail_id, completed_distance, completion_percentage,
            completed_geometry, activity_count, first_activity_date, last_activity_date)
         SELECT $1, trail_id,
           CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0
                ELSE ST_Length(covered_geom::geography) END,
           LEAST(CASE WHEN total_distance>0
                      THEN ST_Length(covered_geom::geography)/total_distance*100 ELSE 0 END, 100),
           CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
                ELSE ST_SetSRID(ST_Multi(covered_geom),4326)::geometry(MultiLineString,4326) END,
           activity_count, first_date, last_date
         FROM coverage WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
         ON CONFLICT (user_id, trail_id) DO UPDATE SET
           completed_distance=EXCLUDED.completed_distance,
           completion_percentage=EXCLUDED.completion_percentage,
           completed_geometry=EXCLUDED.completed_geometry,
           activity_count=EXCLUDED.activity_count,
           first_activity_date=EXCLUDED.first_activity_date,
           last_activity_date=EXCLUDED.last_activity_date,
           updated_at=NOW()
         RETURNING completed_distance, completion_percentage, activity_count`,
        [user.id, trailId]
      );

      if (rowCount && rowCount > 0) {
        const r = matchRows[0];
        console.log(`  ${user.first_name} ${user.last_name}: ${Math.round(r.completion_percentage)}% — ${(r.completed_distance/1000).toFixed(1)} km across ${r.activity_count} activit${r.activity_count === 1 ? "y" : "ies"}`);
      } else {
        console.log(`  ${user.first_name} ${user.last_name}: no coverage`);
      }
    } catch (err) {
      console.error(`  ${user.first_name}: error — ${err.message}`);
    } finally {
      matchClient.release();
    }
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
