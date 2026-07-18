import pg from "pg";
const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

// 1. Anything with centroid east of lon 0.5 (potential France/Belgium/Netherlands)
console.log("=== Centroid east of lon 0.5 ===");
const { rows: eastRows } = await pool.query(`
  SELECT name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy,
    round(ST_XMax(ST_Envelope(geometry))::numeric, 3) AS lon_max,
    round(ST_YMin(ST_Envelope(geometry))::numeric, 3) AS lat_min,
    round(ST_YMax(ST_Envelope(geometry))::numeric, 3) AS lat_max
  FROM trails
  WHERE ST_X(ST_Centroid(geometry)) > 0.5
  ORDER BY cy
`);
if (eastRows.length === 0) console.log("  None.");
for (const r of eastRows) {
  console.log(`  [${r.cx}, ${r.cy}] bbox lat ${r.lat_min}→${r.lat_max} lon→${r.lon_max} | ${r.name}`);
}

// 2. Trails with geometry spanning a very large bounding box (crossing the Channel)
console.log("\n=== Trails with bbox width > 2 degrees lon (potential Channel-crossers) ===");
const { rows: wideRows } = await pool.query(`
  SELECT name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy,
    round((ST_XMax(ST_Envelope(geometry)) - ST_XMin(ST_Envelope(geometry)))::numeric, 2) AS lon_span,
    round(ST_XMin(ST_Envelope(geometry))::numeric, 3) AS lon_min,
    round(ST_XMax(ST_Envelope(geometry))::numeric, 3) AS lon_max
  FROM trails
  WHERE (ST_XMax(ST_Envelope(geometry)) - ST_XMin(ST_Envelope(geometry))) > 2.0
  ORDER BY lon_span DESC
  LIMIT 20
`);
if (wideRows.length === 0) console.log("  None.");
for (const r of wideRows) {
  console.log(`  span=${r.lon_span}° [${r.lon_min}→${r.lon_max}] centroid [${r.cx},${r.cy}] | ${r.name}`);
}

// 3. Ireland — centroid west of -5.5 and south of 55.5 (catches ROI + possibly NI)
console.log("\n=== Trails with centroid in Ireland region (lon < -5.5, lat 51-56) ===");
const { rows: irRows } = await pool.query(`
  SELECT name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE
    ST_X(ST_Centroid(geometry)) < -5.5
    AND ST_Y(ST_Centroid(geometry)) BETWEEN 51.0 AND 56.0
    AND ST_X(ST_Centroid(geometry)) < -6.5
  ORDER BY cy, cx
  LIMIT 60
`);
if (irRows.length === 0) console.log("  None.");
for (const r of irRows) {
  console.log(`  [${r.cx}, ${r.cy}] ${r.name} (${r.region})`);
}

// 4. Full Ireland picture — anything west of -6.5
console.log("\n=== Anything with centroid west of lon -6.5 ===");
const { rows: farWestRows } = await pool.query(`
  SELECT name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE ST_X(ST_Centroid(geometry)) < -6.5
  ORDER BY cy
  LIMIT 40
`);
if (farWestRows.length === 0) console.log("  None.");
for (const r of farWestRows) {
  console.log(`  [${r.cx}, ${r.cy}] ${r.name} (${r.region})`);
}

await pool.end();
