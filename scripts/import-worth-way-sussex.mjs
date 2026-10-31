/**
 * Import "Worth Way (Sussex)" from a GPX track (Memory-Map export).
 * Source file: worthway.gpx — 26 trkpt, single track/segment, Three Bridges
 * (Crawley) -> East Grinstead along the old railway line. Straightforward
 * LineString, same shape as scripts/import-westmorland-furness-way.mjs.
 *
 * Note: the source track is sparse (one gap is ~1.9km straight), so where the
 * real path curves away from those straight lines, matching can undercount.
 *
 * The catalog already had an unrelated "Worth Way" (slug worth-way) in West
 * Yorkshire, near Keighley. That one is renamed "Worth Way (West Yorkshire)"
 * so the two are distinguishable; its slug is unchanged so links still work.
 *
 * Matching for existing users is NOT done here — the drain picks the new
 * trail up automatically (every user drops to one unchecked trail), or run
 * the app's computeTrailProgress for it directly to do it straight away.
 *
 * Run with:  node --env-file=.env.local scripts/import-worth-way-sussex.mjs
 */
import { readFileSync } from "fs";
import pg from "pg";
const { Pool } = pg;

const GPX_PATH = "worthway.gpx";
const TRAIL_NAME = "Worth Way (Sussex)";
const TRAIL_SLUG = "worth-way-sussex";
const TRAIL_CATEGORY = "long_distance_path";
const TRAIL_SOURCE = "gpx";
const TRAIL_REGION = "South East England";

const YORKSHIRE_SLUG = "worth-way";
const YORKSHIRE_NAME = "Worth Way (West Yorkshire)";

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
    const { rows: existing } = await client.query("SELECT id FROM trails WHERE slug = $1", [TRAIL_SLUG]);
    if (existing.length > 0) {
      throw new Error(`Trail with slug "${TRAIL_SLUG}" already exists (id ${existing[0].id}) — aborting to avoid overwriting.`);
    }

    await client.query("BEGIN");

    // Disambiguate the existing West Yorkshire trail — only if it's still
    // the unrelated one (sanity-check its location: north of 53°N).
    const { rows: renamed } = await client.query(
      `UPDATE trails SET name = $1
       WHERE slug = $2 AND name = 'Worth Way' AND ST_YMin(geometry) > 53
       RETURNING id, name`,
      [YORKSHIRE_NAME, YORKSHIRE_SLUG]
    );
    console.log(renamed.length ? `Renamed existing trail -> "${renamed[0].name}"` : "Existing West Yorkshire trail not renamed (not found or already renamed).");

    const { rows } = await client.query(
      `INSERT INTO trails (name, slug, region, category, source, total_distance, geometry, start_point, end_point)
       SELECT $1, $2, $3, $4, $5,
              ROUND(ST_Length(geom::geography)::numeric),
              geom,
              ST_StartPoint(geom),
              ST_EndPoint(geom)
       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($6), 4326) AS geom) g
       RETURNING id, total_distance,
         ST_AsText(start_point) AS start_pt, ST_AsText(end_point) AS end_pt,
         simplified_geometry IS NOT NULL AS has_simplified`,
      [TRAIL_NAME, TRAIL_SLUG, TRAIL_REGION, TRAIL_CATEGORY, TRAIL_SOURCE, geojson]
    );
    await client.query("COMMIT");

    const t = rows[0];
    console.log(`Inserted "${TRAIL_NAME}" — id ${t.id}`);
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
