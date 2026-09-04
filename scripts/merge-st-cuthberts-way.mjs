/**
 * St Cuthbert's Way was only in the DB as two separate OSM route relations —
 * "Saint Cuthbert's Way (Melrose to Kirk Yetholm)" and "Saint Cuthbert's Way
 * (Kirk Yetholm to Lindisfarne)" — mirroring how OSM itself models the trail
 * (relation 4515009 "Saint Cuthbert's Way" is a route_master grouping exactly
 * those two sub-relations, with no single way-level geometry of its own).
 * There's no third, unrelated "St Cuthbert's Three Church Trail" involved here
 * — that's a different pilgrimage route and is left untouched.
 *
 * This creates one complete "St Cuthbert's Way" trail row (ST_LineMerge of
 * the two sections — they share an exact endpoint at Kirk Yetholm, so this
 * produces a single continuous LineString, not a MultiLineString) and
 * demotes the two existing section rows to children via parent_trail_id,
 * the same pattern migrate-parent-trails.mjs already established for SWCP,
 * Pennine Way, West Highland Way, etc. Existing user_trail_progress rows on
 * the sections are left alone (only 2 users, ~2.2km total, on the Kirk
 * Yetholm–Lindisfarne section at the time this was written) — the new
 * parent gets its own progress computed fresh by the matching sweep.
 *
 * Idempotent: safe to re-run. Run with:
 *   node --env-file=.env.local scripts/merge-st-cuthberts-way.mjs
 */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

const SECTION_SLUGS = [
  "saint-cuthberts-way-melrose-to-kirk-yetholm",
  "saint-cuthberts-way-kirk-yetholm-to-lindisfarne",
];
const PARENT_NAME = "St Cuthbert's Way";
const PARENT_SLUG = "st-cuthberts-way";
const REGION = "Scotland/England Border";

async function main() {
  const client = await pool.connect();
  try {
    const { rows: sections } = await client.query(
      `SELECT id, name, slug, total_distance FROM trails WHERE slug = ANY($1::text[]) ORDER BY slug`,
      [SECTION_SLUGS]
    );
    if (sections.length !== SECTION_SLUGS.length) {
      throw new Error(
        `Expected ${SECTION_SLUGS.length} section trails, found ${sections.length}: ${sections.map(s => s.slug).join(", ")}`
      );
    }
    console.log("Sections found:");
    for (const s of sections) {
      console.log(`  - ${s.name} (${(s.total_distance / 1000).toFixed(2)} km)`);
    }

    const { rows: existingParent } = await client.query(
      `SELECT id FROM trails WHERE slug = $1`,
      [PARENT_SLUG]
    );

    let parentId;
    if (existingParent.length > 0) {
      parentId = existingParent[0].id;
      console.log(`\nParent trail already exists (${parentId}) — skipping insert.`);
    } else {
      const sectionIds = sections.map(s => s.id);
      const { rows: inserted } = await client.query(
        `WITH merged AS (
           SELECT ST_LineMerge(ST_Collect(geometry)) AS geom
           FROM trails
           WHERE id = ANY($1::uuid[])
         )
         INSERT INTO trails (name, slug, region, total_distance, geometry, source, category)
         SELECT $2, $3, $4, ROUND(ST_Length(geom::geography)::numeric), geom, 'osm', 'long_distance_path'
         FROM merged
         RETURNING id, total_distance, ST_GeometryType(geometry) AS geom_type`,
        [sectionIds, PARENT_NAME, PARENT_SLUG, REGION]
      );
      parentId = inserted[0].id;
      console.log(
        `\nCreated "${PARENT_NAME}" (${parentId}): ` +
        `${(inserted[0].total_distance / 1000).toFixed(2)} km, geometry = ${inserted[0].geom_type}`
      );
    }

    const { rowCount } = await client.query(
      `UPDATE trails SET parent_trail_id = $1
       WHERE slug = ANY($2::text[]) AND parent_trail_id IS NULL`,
      [parentId, SECTION_SLUGS]
    );
    console.log(`Linked ${rowCount} section(s) to the parent via parent_trail_id.`);

    const { rows: verify } = await client.query(
      `SELECT t.name, t.total_distance, ST_GeometryType(t.geometry) AS geom_type,
              (SELECT COUNT(*) FROM trails c WHERE c.parent_trail_id = t.id) AS child_count
       FROM trails t WHERE t.id = $1`,
      [parentId]
    );
    console.log("\nVerification:");
    console.log(`  ${verify[0].name}: ${(verify[0].total_distance / 1000).toFixed(2)} km ` +
      `(${(verify[0].total_distance / 1609.344).toFixed(1)} mi), ${verify[0].geom_type}, ` +
      `${verify[0].child_count} child section(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
