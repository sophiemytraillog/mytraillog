import pg from "pg";
const { Pool } = pg;

const pool = new Pool({ ssl: { rejectUnauthorized: false } });

const { rows } = await pool.query(`
  SELECT
    name,
    region,
    round(total_distance / 1609.344)::int          AS declared_miles,
    ST_NPoints(geometry)                            AS waypoints,
    round(ST_Length(geometry::geography) / 1609.344)::int AS geom_miles
  FROM trails
  ORDER BY name
`);

const w = [30, 26, 6, 4, 8];
console.log(
  "Trail".padEnd(w[0]),
  "Region".padEnd(w[1]),
  "Miles".padStart(w[2]),
  "Pts".padStart(w[3]),
  "GeomMi".padStart(w[4])
);
console.log("-".repeat(w.reduce((a, b) => a + b + 1)));
for (const t of rows) {
  console.log(
    t.name.padEnd(w[0]),
    t.region.padEnd(w[1]),
    String(t.declared_miles).padStart(w[2]),
    String(t.waypoints).padStart(w[3]),
    String(t.geom_miles).padStart(w[4])
  );
}

await pool.end();
