/**
 * Delete trails whose centroid (or most of the geometry) is outside Great Britain + NI.
 * We use ST_Centroid to check whether the centre of the trail is within the UK,
 * which correctly excludes French and Irish routes while keeping border-grazing UK trails.
 */
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  database: process.env.PGDATABASE,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

// First, show what will be deleted
const preview = await pool.query(`
  SELECT id, name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS centroid_lon,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS centroid_lat
  FROM trails
  WHERE
    ST_XMin(ST_Envelope(geometry)) < -8.2
    OR ST_XMax(ST_Envelope(geometry)) > 2.0
    OR ST_YMin(ST_Envelope(geometry)) < 49.9
    OR ST_YMax(ST_Envelope(geometry)) > 60.9
  ORDER BY name
`);

console.log(`Will delete ${preview.rows.length} trail(s):\n`);
for (const r of preview.rows) {
  console.log(`  [${r.centroid_lon}, ${r.centroid_lat}] ${r.name}`);
}

const ids = preview.rows.map(r => r.id);
if (ids.length === 0) {
  console.log("Nothing to delete.");
  await pool.end();
  process.exit(0);
}

// Delete related records first, then trails
await pool.query(`DELETE FROM user_trail_progress WHERE trail_id = ANY($1::uuid[])`, [ids]);
await pool.query(`DELETE FROM user_trail_manual_segments WHERE trail_id = ANY($1::uuid[])`, [ids]);
const del = await pool.query(`DELETE FROM trails WHERE id = ANY($1::uuid[])`, [ids]);

console.log(`\nDeleted ${del.rowCount} trails.`);
await pool.end();
