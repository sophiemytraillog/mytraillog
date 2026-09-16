/**
 * Import "Roof of England Walk" from a GPX track export (OS Maps / gpx.studio).
 * Source file: Roof-of-England-Walk_Full-Route_FINAL.gpx (6,148 trkpt, single
 * track/segment, no rte or usable trk splits — straightforward LineString).
 *
 * Run with:  node --env-file=.env.local scripts/import-roof-of-england.mjs
 */
import { readFileSync } from "fs";
import pg from "pg";
const { Pool } = pg;

const GPX_PATH = "Roof-of-England-Walk_Full-Route_FINAL.gpx";
const TRAIL_NAME = "Roof of England Walk";
const TRAIL_SLUG = "roof-of-england-walk";
const TRAIL_CATEGORY = "long_distance_path";
const TRAIL_SOURCE = "gpx";
// Region is a best-effort determination from the track's actual coordinates —
// flagged to the user for confirmation per their request, not silently assumed.
const TRAIL_REGION = "Northern England";

const BUFFER_METRES = 50;
const SIMPLIFY_MARGIN = 200;

function parseTrkpts(gpxText) {
  const coords = [];
  const re = /<trkpt\s+lat="(-?\d+\.?\d*)"\s+lon="(-?\d+\.?\d*)"/g;
  let m;
  while ((m = re.exec(gpxText)) !== null) {
    coords.push([parseFloat(m[2]), parseFloat(m[1])]); // [lon, lat] for GeoJSON
  }
  return coords;
}

const pool = new Pool({ ssl: { rejectUnauthorized: false } });
pool.on("error", (e) => console.error("[pool err]", e.message));

async function main() {
  console.log(`Reading ${GPX_PATH}...`);
  const gpxText = readFileSync(GPX_PATH, "utf8");
  const coords = parseTrkpts(gpxText);
  console.log(`Parsed ${coords.length} track points.`);
  if (coords.length < 2) throw new Error("Not enough track points to build a LineString");

  const geojson = JSON.stringify({ type: "LineString", coordinates: coords });

  const client = await pool.connect();
  client.on("error", (e) => console.error("[client err]", e.message));
  try {
    const { rows: existing } = await client.query("SELECT id FROM trails WHERE slug = $1", [TRAIL_SLUG]);
    if (existing.length > 0) {
      throw new Error(`Trail with slug "${TRAIL_SLUG}" already exists (id ${existing[0].id}) — aborting to avoid overwriting.`);
    }

    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO trails (name, slug, region, category, source, total_distance, geometry, start_point, end_point)
       SELECT $1, $2, $3, $4, $5,
              ROUND(ST_Length(geom::geography)::numeric),
              geom,
              ST_StartPoint(geom),
              ST_EndPoint(geom)
       FROM (SELECT ST_GeomFromGeoJSON($6) AS geom) g
       RETURNING id, total_distance,
         ST_AsText(start_point) AS start_pt, ST_AsText(end_point) AS end_pt,
         ST_XMin(geometry) AS min_lon, ST_XMax(geometry) AS max_lon,
         ST_YMin(geometry) AS min_lat, ST_YMax(geometry) AS max_lat`,
      [TRAIL_NAME, TRAIL_SLUG, TRAIL_REGION, TRAIL_CATEGORY, TRAIL_SOURCE, geojson]
    );
    const trail = rows[0];
    await client.query("COMMIT");

    console.log(`\nInserted "${TRAIL_NAME}" (id ${trail.id})`);
    console.log(`  Distance: ${(trail.total_distance / 1000).toFixed(2)} km`);
    console.log(`  Start: ${trail.start_pt}`);
    console.log(`  End:   ${trail.end_pt}`);
    console.log(`  Bounding box: lon [${trail.min_lon}, ${trail.max_lon}], lat [${trail.min_lat}, ${trail.max_lat}]`);
    console.log(`  Region (proposed, needs confirmation): ${TRAIL_REGION}`);

    return trail.id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then((id) => { console.log(`\nDone. Trail id: ${id}`); pool.end(); })
  .catch((err) => { console.error("Fatal:", err.message); pool.end(); process.exit(1); });
