/**
 * Find trails whose geometry extends outside the UK bounding box.
 * UK bounds: lon -8.2 to 2.0, lat 49.9 to 60.9
 * Anything with points further east (>2.0) or south (<49.9) is suspicious.
 */
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PGHOST,
  port:     process.env.PGPORT     ? parseInt(process.env.PGPORT) : 5432,
  database: process.env.PGDATABASE,
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(`
  SELECT
    id,
    name,
    region,
    round(total_distance / 1000) AS total_km,
    ST_XMin(ST_Envelope(geometry)) AS lon_min,
    ST_XMax(ST_Envelope(geometry)) AS lon_max,
    ST_YMin(ST_Envelope(geometry)) AS lat_min,
    ST_YMax(ST_Envelope(geometry)) AS lat_max
  FROM trails
  WHERE
    ST_XMin(ST_Envelope(geometry)) < -8.2
    OR ST_XMax(ST_Envelope(geometry)) > 2.0
    OR ST_YMin(ST_Envelope(geometry)) < 49.9
    OR ST_YMax(ST_Envelope(geometry)) > 60.9
  ORDER BY name
`);

if (rows.length === 0) {
  console.log("No trails found outside UK bounds.");
} else {
  console.log(`${rows.length} trail(s) with geometry outside UK bounding box:\n`);
  for (const r of rows) {
    console.log(`  ${r.name} (${r.region}) — ${r.total_km}km`);
    console.log(`    lon: ${parseFloat(r.lon_min).toFixed(3)} → ${parseFloat(r.lon_max).toFixed(3)}`);
    console.log(`    lat: ${parseFloat(r.lat_min).toFixed(3)} → ${parseFloat(r.lat_max).toFixed(3)}`);
    console.log(`    id: ${r.id}`);
  }
}

await pool.end();
