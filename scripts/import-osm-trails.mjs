/**
 * Import long-distance UK walking, cycling, and multi-use routes from OpenStreetMap.
 *
 * Queries for route relations tagged:
 *   type=route, route=hiking|foot|horse|bicycle, with a named trail name
 *
 * Generic numbered cycle network routes (NCN Route 2, Regional Cycle Route 20, etc.)
 * are excluded — only named trails like "Cuckoo Trail", "Tarka Trail" are kept.
 *
 * Each route is inserted with source="osm" and category="long_distance_path".
 * Existing National Trails (category="national_trail") are never overwritten.
 *
 * Run with:  npm run db:import-osm
 */

import pg from "pg";
import { fileURLToPath } from "url";
import { dirname } from "path";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

// ── Config ────────────────────────────────────────────────────────────────────

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Great Britain + Northern Ireland bounding box (south, west, north, east)
const UK_BBOX = "49.9,-8.2,60.9,2.0";

// Discard routes shorter than this — filters out short link/connector routes
const MIN_LENGTH_M = 15_000;

// ── Overpass query ────────────────────────────────────────────────────────────
// out body geom returns each relation with its member ways' coordinates inline,
// avoiding a second recursive query to resolve way nodes.
//
// Broadened from the original (hiking/foot + nwn/rwn only) to catch named
// multi-use trails (route=bicycle|horse) that have no nwn/rwn network tag,
// e.g. Cuckoo Trail (route=bicycle, no network tag) and Cornwall C2C (rcn).
// Generic numbered cycle network routes are filtered out in isProperTrailName().

const OVERPASS_QUERY = `
[out:json][timeout:300];
(
  relation["type"="route"]["route"~"^(hiking|foot|horse)$"]["name"](${UK_BBOX});
  relation["type"="route"]["route"="bicycle"]["name"](${UK_BBOX});
);
out body geom;
`.trim();

// ── Name filter ───────────────────────────────────────────────────────────────
// Exclude generic cycle-network route names — we want named trails only.
// Matches names that are generic cycle-network identifiers.
// Two patterns:
//   STARTS_WITH: name begins with a generic prefix (NCN N..., National Cycle Route N..., etc.)
//                — rejects even when extra text follows the number, e.g. "NCN 1 Boston to Lincoln"
//   EXACT:       name is entirely a generic token with no meaningful suffix
//                — rejects "cycle route 5", "route 7", "UK:National Cycle Network"
const GENERIC_STARTS_WITH_RE = /^(ncn\s+\d|national\s+cycle\s+(network|route)\s+\d|national\s+cycle\s+network(\s*$|[^a-z])|regional\s+cycle\s+(route|network|way)|local\s+cycle\s+(route|network|way)|sustrans\s+\d|uk:national\s+cycle)/i;
const GENERIC_EXACT_RE = /^(cycle\s+route\s*\d*|route\s*\d+|lcn(\s+\d+)?|rcn(\s+\d+)?)\s*$/i;

function isProperTrailName(name) {
  if (!name || name.trim().length < 4) return false;
  const n = name.trim();
  return !GENERIC_STARTS_WITH_RE.test(n) && !GENERIC_EXACT_RE.test(n);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferRegion(tags) {
  const hay = [tags.name, tags.operator, tags.note, tags.description, tags["addr:country"]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (hay.includes("scotland") || hay.includes("highland") || hay.includes("cairngorm") ||
      hay.includes("gb-sct") || hay.includes("speyside"))
    return "Scotland";
  if (hay.includes("wales") || hay.includes("cymru") || hay.includes("cambrian") ||
      hay.includes("gb-wls") || hay.includes("offa"))
    return "Wales";
  if (hay.includes("northern ireland") || hay.includes("antrim") || hay.includes("ulster") ||
      hay.includes("gb-nir"))
    return "Northern Ireland";
  return "England";
}

/**
 * Collect every way member's coordinates into a GeoJSON MultiLineString.
 * Returns null if no usable geometry is found.
 */
function buildMultiLineStringGeoJSON(relation) {
  const lines = [];

  for (const member of relation.members ?? []) {
    if (member.type !== "way") continue;
    if (!member.geometry || member.geometry.length < 2) continue;
    // Overpass gives {lat, lon}; GeoJSON wants [lon, lat]
    lines.push(member.geometry.map(({ lat, lon }) => [lon, lat]));
  }

  if (lines.length === 0) return null;

  return JSON.stringify({ type: "MultiLineString", coordinates: lines });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

async function main() {
  // ── 1. Fetch from Overpass ─────────────────────────────────────────────────
  console.log("Querying Overpass API (this can take 30–90 seconds for UK coverage)…");
  console.log("  Query: nwn + rwn hiking/foot routes within UK bounding box\n");

  const resp = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": "MyTrailLog/1.0 (trail progress tracker; sophie@raisethebarfm.co.uk)",
    },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Overpass API returned HTTP ${resp.status}:\n${body.slice(0, 400)}`);
  }

  const { elements } = await resp.json();
  const relations = elements.filter(e => e.type === "relation");
  console.log(`Overpass returned ${relations.length} route relation(s).\n`);

  // ── 2. Connect to DB ───────────────────────────────────────────────────────
  console.log(`Connecting to ${process.env.PGHOST}/${process.env.PGDATABASE}…`);
  const client = await pool.connect();
  console.log("Connected.\n");

  try {
    // ── 3. Schema migrations ────────────────────────────────────────────────
    console.log("Applying schema migrations…");

    // Add source + category columns (idempotent)
    await client.query(`
      ALTER TABLE trails
        ADD COLUMN IF NOT EXISTS source   TEXT,
        ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'national_trail';
    `);

    // Backfill any existing rows that pre-date the column
    await client.query(`
      UPDATE trails
      SET category = 'national_trail'
      WHERE source IS NULL AND category = 'national_trail';
    `);

    // Widen the geometry column so it accepts MultiLineString from OSM.
    // ST_LineMerge returns LineString when all segments connect, MultiLineString
    // when there are gaps (ferry crossings, missing ways, etc.).
    try {
      await client.query(`
        ALTER TABLE trails
          ALTER COLUMN geometry TYPE GEOMETRY USING geometry;
      `);
      console.log("  geometry column widened to accept any geometry subtype.");
    } catch {
      console.log("  geometry column already flexible — no change needed.");
    }

    console.log("Migrations done.\n");

    // ── 4. Import loop ─────────────────────────────────────────────────────
    console.log("Importing routes…");
    console.log(`  (skipping routes shorter than ${MIN_LENGTH_M / 1000} km)\n`);

    let inserted = 0;
    let skipped_no_name = 0;
    let skipped_no_geom = 0;
    let skipped_too_short = 0;
    let skipped_exists = 0;
    let errors = 0;

    for (const relation of relations) {
      const tags = relation.tags ?? {};
      const name = tags.name ?? tags["name:en"];

      if (!name) { skipped_no_name++; continue; }
      if (!isProperTrailName(name)) { skipped_no_name++; continue; }

      const geojson = buildMultiLineStringGeoJSON(relation);
      if (!geojson) { skipped_no_geom++; continue; }

      const slug = slugify(name);
      const region = inferRegion(tags);

      try {
        // Use a CTE so we compute the merged geometry once and reuse it for
        // both the length check and the INSERT value.
        // ON CONFLICT DO NOTHING protects existing national_trail rows and makes
        // the script safe to re-run.
        const result = await client.query(
          `WITH geom AS (
             SELECT ST_LineMerge(ST_GeomFromGeoJSON($1)) AS g
           )
           INSERT INTO trails (name, slug, region, total_distance, geometry, source, category)
           SELECT $2, $3, $4,
                  ROUND(ST_Length(g::geography)::numeric),
                  g,
                  'osm',
                  'long_distance_path'
           FROM geom
           WHERE ST_Length(g::geography) >= $5
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
          [geojson, name, slug, region, MIN_LENGTH_M]
        );

        if ((result.rowCount ?? 0) > 0) {
          inserted++;
          console.log(`  ✓  ${name}`);
        } else {
          // Distinguish: filtered by length vs slug conflict
          const { rows } = await client.query(
            `SELECT 1 FROM trails WHERE slug = $1`, [slug]
          );
          if (rows.length > 0) {
            skipped_exists++;
          } else {
            skipped_too_short++;
          }
        }
      } catch (err) {
        console.error(`  ✗  ${name}: ${err.message}`);
        errors++;
      }
    }

    // ── 5. Summary ────────────────────────────────────────────────────────
    console.log("\n────────────────────────────────────────────────");
    console.log("Import complete.\n");
    console.log(`  Inserted:                      ${inserted}`);
    console.log(`  Skipped — too short (<${MIN_LENGTH_M / 1000} km): ${skipped_too_short}`);
    console.log(`  Skipped — already in DB:       ${skipped_exists}`);
    console.log(`  Skipped — no name tag:         ${skipped_no_name}`);
    console.log(`  Skipped — no geometry:         ${skipped_no_geom}`);
    console.log(`  Errors:                        ${errors}`);

    const { rows: totals } = await client.query(`
      SELECT category, COUNT(*) AS count
      FROM trails
      GROUP BY category
      ORDER BY count DESC
    `);

    console.log("\nTrails table by category:");
    for (const row of totals) {
      console.log(`  ${row.category.padEnd(22)} ${row.count}`);
    }

    const { rows: [{ total }] } = await client.query(
      `SELECT COUNT(*) AS total FROM trails`
    );
    console.log(`\n  Total trails in DB:            ${total}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("\nFatal error:", err.message ?? err);
  process.exit(1);
});
