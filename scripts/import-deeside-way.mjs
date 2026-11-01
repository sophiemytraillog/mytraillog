/**
 * Replace the "Deeside Way" route with a GPX track (Memory-Map export).
 * Source file: deesideway.gpx — 322 trkpt, single track/segment, Aberdeen
 * (Duthie Park) -> Ballater along the old Deeside railway line, ~70km.
 *
 * The catalog already had a "Deeside Way" (slug deeside-way) from an OSM
 * import, but it was incomplete — 44km, only ~30km of it along the real
 * route (nothing at the Aberdeen end, plus ~14km west of Ballater beyond the
 * official route) — and mislabelled region 'England'. It's the same trail,
 * so this updates that row in place (same id and slug, so links keep
 * working) rather than adding a duplicate. Checked before running: no user
 * had progress, activity matches, manual segments or child sections on it.
 *
 * Matching isn't done here: the trail's geometry changed, so existing
 * trail_match_checks rows are stale — re-run the app's computeTrailProgress
 * for this trail for every user afterwards.
 *
 * Run with:  node --env-file=.env.local scripts/import-deeside-way.mjs
 */
import { readFileSync } from "fs";
import pg from "pg";
const { Pool } = pg;

const GPX_PATH = "deesideway.gpx";
const TRAIL_NAME = "Deeside Way";
const TRAIL_SLUG = "deeside-way";
const TRAIL_CATEGORY = "long_distance_path";
const TRAIL_SOURCE = "gpx";
const TRAIL_REGION = "Scotland";

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
  const coords = parseTrkpts(readFileSync(GPX_PATH, "utf8"));
  console.log(`Parsed ${coords.length} track points.`);
  if (coords.length < 2) throw new Error("Not enough track points to build a LineString");
  const geojson = JSON.stringify({ type: "LineString", coordinates: coords });

  const client = await pool.connect();
  client.on("error", (e) => console.error("[client err]", e.message));
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      "SELECT id, name, ST_YMin(geometry) AS min_lat FROM trails WHERE slug = $1 FOR UPDATE",
      [TRAIL_SLUG]
    );

    let rows;
    if (existing.length > 0) {
      // Sanity check: only replace if the existing row really is the
      // Aberdeenshire route (north of 56°N), not some other "Deeside".
      if (existing[0].min_lat < 56) {
        throw new Error(`Existing "${existing[0].name}" (slug ${TRAIL_SLUG}) isn't in Aberdeenshire — aborting.`);
      }
      ({ rows } = await client.query(
        `UPDATE trails t
         SET name = $1, region = $2, category = $3, source = $4,
             geometry = g.geom,
             total_distance = ROUND(ST_Length(g.geom::geography)::numeric),
             start_point = ST_StartPoint(g.geom),
             end_point = ST_EndPoint(g.geom)
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($5), 4326) AS geom) g
         WHERE t.slug = $6
         RETURNING t.id, t.total_distance, ST_AsText(t.start_point) AS start_pt, ST_AsText(t.end_point) AS end_pt,
                   t.simplified_geometry IS NOT NULL AS has_simplified`,
        [TRAIL_NAME, TRAIL_REGION, TRAIL_CATEGORY, TRAIL_SOURCE, geojson, TRAIL_SLUG]
      ));
      console.log(`Replaced route of existing "${TRAIL_NAME}" (id ${rows[0].id}).`);
    } else {
      ({ rows } = await client.query(
        `INSERT INTO trails (name, slug, region, category, source, total_distance, geometry, start_point, end_point)
         SELECT $1, $2, $3, $4, $5, ROUND(ST_Length(geom::geography)::numeric), geom, ST_StartPoint(geom), ST_EndPoint(geom)
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($6), 4326) AS geom) g
         RETURNING id, total_distance, ST_AsText(start_point) AS start_pt, ST_AsText(end_point) AS end_pt,
                   simplified_geometry IS NOT NULL AS has_simplified`,
        [TRAIL_NAME, TRAIL_SLUG, TRAIL_REGION, TRAIL_CATEGORY, TRAIL_SOURCE, geojson]
      ));
      console.log(`Inserted "${TRAIL_NAME}" (id ${rows[0].id}).`);
    }
    await client.query("COMMIT");

    const t = rows[0];
    console.log(`  ${(t.total_distance / 1000).toFixed(1)} km, start ${t.start_pt}, end ${t.end_pt}, simplified_geometry set: ${t.has_simplified}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
