/**
 * Downloads official National Trail GPX files and imports them into the DB,
 * replacing the hand-coded seed waypoints with full detailed routes
 * (1 000 – 1 500 points per trail).
 *
 * Sources
 *  - 8 trails: official nationaltrail.co.uk AWS S3 bucket (Open Government Licence)
 *  - 2 trails: OpenStreetMap via Overpass API (ODbL)
 *    - South West Coast Path  (relation 2376086)
 *    - West Highland Way      (relation 16287)
 *
 * Usage:
 *   node --env-file=.env.local scripts/import-gpx.mjs
 */

import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

// ── Trail sources ─────────────────────────────────────────────────────────────

const GPX_SOURCES = [
  {
    slug: "south-downs-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/South_Downs_Way_Elev.gpx",
  },
  {
    slug: "north-downs-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/2025/04/North_Downs_Way_Elev.gpx",
  },
  {
    slug: "thames-path",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Thames-Path-elevation-1Nov24.gpx",
  },
  {
    slug: "cotswold-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Cotswold-Way-2019.gpx",
  },
  {
    slug: "the-ridgeway",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/The_Ridgeway.gpx",
  },
  {
    slug: "pennine-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Pennine-Way-elev-1.gpx",
  },
  {
    slug: "hadrians-wall-path",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Hadrians_Wall_Path-1.gpx",
  },
  {
    slug: "coast-to-coast",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/2026/03/Coast_to_Coast_Elev.gpx",
  },
  {
    slug: "cleveland-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Cleveland_Way_Elev.gpx",
  },
  {
    slug: "glyndwrs-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/GlyndwrWay_25K_web_line_polyline042022-elevation.gpx",
  },
  {
    slug: "peddars-way-norfolk-coast",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Peddars_Way_and_Norfolk_Coast_Path_Elev.gpx",
  },
  {
    slug: "yorkshire-wolds-way",
    url: "https://nationaltrails.s3.eu-west-2.amazonaws.com/uploads/Yorkshire_Wolds_Way_Elev.gpx",
  },
];

const OSM_SOURCES = [
  { slug: "south-west-coast-path",    relation: 2376086 },
  { slug: "west-highland-way",        relation: 16287   },
  { slug: "offas-dyke-path",          relation: 9649    },
  { slug: "pennine-bridleway",        relation: 50288   },
  { slug: "great-glen-way",           relation: 126572  },
  { slug: "pembrokeshire-coast-path", relation: 77964   },
  { slug: "southern-upland-way",      relation: 50325   },
  { slug: "speyside-way",             relation: 1026251 },
];

// ── GPX parsing ───────────────────────────────────────────────────────────────

function parseGpxPoints(text) {
  const parsePts = (src, tag) => {
    const regex = new RegExp(`<${tag}\\s([^>]+)>`, "g");
    const pts = [];
    let m;
    while ((m = regex.exec(src)) !== null) {
      const lat = parseFloat(m[1].match(/lat="([^"]+)"/)?.[1]);
      const lon = parseFloat(m[1].match(/lon="([^"]+)"/)?.[1]);
      if (!isNaN(lat) && !isNaN(lon)) pts.push([lon, lat]);
    }
    // Drop consecutive duplicates (some GPX files triplicate each point)
    return pts.filter(
      (p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]
    );
  };

  // Parse each <trkseg> separately — never flatten across segments, because
  // some GPX files include disconnected branch/alternate segments after the
  // main route which create huge artificial straight-line jumps.
  const MAX_JOIN_GAP = 0.05; // ~5 km in degrees — bridges small official trail gaps
  const segTexts = [...text.matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/g)].map(
    (m) => m[1]
  );
  const segments = segTexts
    .map((s) => parsePts(s, "trkpt"))
    .filter((s) => s.length >= 2);

  // Greedily join consecutive segments only when their endpoints are adjacent.
  let result = segments.length > 0 ? [...segments[0]] : [];
  for (let i = 1; i < segments.length; i++) {
    const end = result[result.length - 1];
    const start = segments[i][0];
    const d = Math.hypot(start[0] - end[0], start[1] - end[1]);
    if (d <= MAX_JOIN_GAP) result.push(...segments[i]);
  }

  // Fall back to <rtept> route points if the file has no track segments.
  if (result.length < 2) result = parsePts(text, "rtept");
  return result;
}

async function fetchGpxPoints(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const pts = parseGpxPoints(text);
  if (pts.length < 2) throw new Error(`Only ${pts.length} points parsed`);
  return pts;
}

// ── Overpass / OSM helpers ────────────────────────────────────────────────────

async function fetchOsmWays(relationId) {
  // Fetches all member ways of an OSM hiking relation, with full node geometry.
  // Both SWCP and WHW are "superroutes" (relations of relations), so we recurse
  // one level: expand the top relation + its member relations, then get all ways.
  // Uses POST — required for large relations; GET gets a 406 without User-Agent.
  const query = `[out:json][timeout:120];relation(${relationId});(._; rel(r););way(r);out geom;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "MyTrailLog/1.0 (trail-geometry-import)",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();

  const linestrings = [];
  for (const el of data.elements) {
    if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      const pts = el.geometry.map((n) => `${n.lon} ${n.lat}`).join(", ");
      linestrings.push(`(${pts})`);
    }
  }
  if (linestrings.length === 0) throw new Error("No ways returned from Overpass");
  return linestrings; // array of WKT coordinate strings, one per way
}

// ── Database update ───────────────────────────────────────────────────────────

async function ensureColumnType() {
  // Relax the LineString-only constraint so we can store MultiLineString if
  // ST_LineMerge can't fully connect a trail's OSM ways (rare gaps).
  await pool.query(`
    ALTER TABLE trails
    ALTER COLUMN geometry TYPE geometry(Geometry, 4326)
      USING geometry::geometry(Geometry, 4326)
  `);
}

async function updateTrailFromPoints(slug, points) {
  const wkt = `LINESTRING(${points.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`;
  return updateTrailGeometry(slug, wkt);
}

async function updateTrailFromOsmWays(slug, linestrings) {
  // Build a MULTILINESTRING from all ways, then let PostGIS merge connected
  // segments into the longest possible continuous LineString.
  const multi = `MULTILINESTRING(${linestrings.join(", ")})`;
  // ST_LineMerge stitches touching segments; result may still be a
  // MultiLineString if there are gaps (e.g. ferry crossings on SWCP).
  const wkt = `ST_LineMerge(ST_GeomFromText('${multi.replace(/'/g, "''")}', 4326))`;
  return updateTrailGeometryExpr(slug, wkt);
}

async function updateTrailGeometry(slug, wkt) {
  // Only updates geometry — total_distance stays as the declared official distance.
  const { rows } = await pool.query(
    `UPDATE trails
     SET geometry = ST_GeomFromText($2, 4326)
     WHERE slug = $1
     RETURNING name,
               ST_NPoints(geometry)                                AS npoints,
               round(ST_Length(geometry::geography) / 1609.344)::int AS geom_miles,
               round(total_distance / 1609.344)::int               AS declared_miles,
               ST_GeometryType(geometry)                          AS geomtype`,
    [slug, wkt]
  );
  if (rows.length === 0) throw new Error(`Trail slug "${slug}" not found in DB`);
  return rows[0];
}

async function updateTrailGeometryExpr(slug, geomExpr) {
  // Used for OSM trails where the geometry is already an SQL expression.
  // Only updates geometry — total_distance stays as the declared official distance.
  const { rows } = await pool.query(
    `UPDATE trails
     SET geometry = ${geomExpr}
     WHERE slug = $1
     RETURNING name,
               ST_NPoints(geometry)                                AS npoints,
               round(ST_Length(geometry::geography) / 1609.344)::int AS geom_miles,
               round(total_distance / 1609.344)::int               AS declared_miles,
               ST_GeometryType(geometry)                          AS geomtype`,
    [slug]
  );
  if (rows.length === 0) throw new Error(`Trail slug "${slug}" not found in DB`);
  return rows[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("Relaxing geometry column type constraint…");
await ensureColumnType();
console.log("Done.\n");

console.log("=== GPX trails (nationaltrail.co.uk) ===");
for (const { slug, url } of GPX_SOURCES) {
  process.stdout.write(`  ${slug}… `);
  try {
    const points = await fetchGpxPoints(url);
    const row = await updateTrailFromPoints(slug, points);
    console.log(`✓ ${row.name}: ${row.npoints} pts, geom ~${row.geom_miles} mi, declared ${row.declared_miles} mi (${row.geomtype})`);
  } catch (err) {
    console.error(`✗ FAILED: ${err.message}`);
  }
}

console.log("\n=== OSM trails (Overpass API) ===");
for (const { slug, relation } of OSM_SOURCES) {
  process.stdout.write(`  ${slug} (relation ${relation})… `);
  try {
    const ways = await fetchOsmWays(relation);
    process.stdout.write(`${ways.length} ways… `);
    const row = await updateTrailFromOsmWays(slug, ways);
    console.log(`✓ ${row.name}: ${row.npoints} pts, geom ~${row.geom_miles} mi, declared ${row.declared_miles} mi (${row.geomtype})`);
  } catch (err) {
    console.error(`✗ FAILED: ${err.message}`);
  }
}

await pool.end();
console.log("\nDone. Run db:rematch to update trail progress with the new geometries.");
