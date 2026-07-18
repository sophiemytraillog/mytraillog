import pg from "pg";
const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

// Broad stats
const { rows: [stats] } = await pool.query(`
  SELECT
    COUNT(*) FILTER (WHERE ST_YMin(ST_Envelope(geometry)) < 49.9)  AS south_of_499,
    COUNT(*) FILTER (WHERE ST_YMin(ST_Envelope(geometry)) < 50.5)  AS south_of_505,
    COUNT(*) FILTER (WHERE ST_XMax(ST_Envelope(geometry)) > 1.8)   AS east_of_18,
    COUNT(*) FILTER (WHERE ST_XMax(ST_Envelope(geometry)) > 2.0)   AS east_of_20,
    COUNT(*) FILTER (WHERE ST_X(ST_Centroid(geometry)) > 2.0)      AS centroid_east_of_20,
    COUNT(*) FILTER (WHERE ST_Y(ST_Centroid(geometry)) < 50.0)     AS centroid_south_of_50,
    COUNT(*) AS total
  FROM trails
`);
console.log("Counts by criterion:");
console.log("  south of lat 49.9:", stats.south_of_499);
console.log("  south of lat 50.5:", stats.south_of_505);
console.log("  east of lon  1.8 :", stats.east_of_18);
console.log("  east of lon  2.0 :", stats.east_of_20);
console.log("  centroid east of 2.0:", stats.centroid_east_of_20);
console.log("  centroid south of 50:", stats.centroid_south_of_50);
console.log("  total trails:", stats.total);

// Show a sample of trails with low latitudes or high longitudes
console.log("\nTrails with centroid south of lat 51.0 or east of lon 1.5:");
const { rows } = await pool.query(`
  SELECT
    name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy,
    round(ST_XMin(ST_Envelope(geometry))::numeric, 3) AS lon_min,
    round(ST_XMax(ST_Envelope(geometry))::numeric, 3) AS lon_max,
    round(ST_YMin(ST_Envelope(geometry))::numeric, 3) AS lat_min,
    round(ST_YMax(ST_Envelope(geometry))::numeric, 3) AS lat_max
  FROM trails
  WHERE
    ST_Y(ST_Centroid(geometry)) < 51.0
    OR ST_X(ST_Centroid(geometry)) > 1.5
  ORDER BY cy, cx
  LIMIT 40
`);

for (const r of rows) {
  console.log(`  [${r.cx}, ${r.cy}]  bbox lon ${r.lon_min}→${r.lon_max}  lat ${r.lat_min}→${r.lat_max}  | ${r.name} (${r.region})`);
}

await pool.end();
