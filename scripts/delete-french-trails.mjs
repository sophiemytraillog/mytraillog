/**
 * Delete trails whose centroid is in France.
 * Rule: centroid lon > 0.5 AND centroid lat < 50.5
 * No UK land exists at that lon/lat combination — the southernmost UK coast
 * east of lon 0.5 is Kent, which sits above lat 51.
 */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(`
  SELECT
    id, name, region,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE
    ST_X(ST_Centroid(geometry)) > 0.5
    AND ST_Y(ST_Centroid(geometry)) < 50.5
  ORDER BY cy, cx
`);

if (rows.length === 0) {
  console.log("No French trails found.");
  await pool.end();
  process.exit(0);
}

console.log(`Found ${rows.length} trail(s) to delete:\n`);
for (const r of rows) {
  console.log(`  [${r.cx}, ${r.cy}] ${r.name}`);
}

const ids = rows.map(r => r.id);

const progressRes = await pool.query(
  `DELETE FROM user_trail_progress WHERE trail_id = ANY($1::uuid[])`, [ids]
);
const segRes = await pool.query(
  `DELETE FROM user_trail_manual_segments WHERE trail_id = ANY($1::uuid[])`, [ids]
);
await pool.query(`DELETE FROM trails WHERE id = ANY($1::uuid[])`, [ids]);

const { rows: [remaining] } = await pool.query(`SELECT COUNT(*) AS count FROM trails`);

console.log(`\nDeleted:  ${rows.length} trail(s)`);
console.log(`          ${progressRes.rowCount ?? 0} user_trail_progress record(s)`);
console.log(`          ${segRes.rowCount ?? 0} user_trail_manual_segments record(s)`);
console.log(`Remaining: ${remaining.count} trail(s)`);

await pool.end();
