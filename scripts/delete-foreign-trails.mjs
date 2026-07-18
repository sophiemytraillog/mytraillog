/**
 * Remove remaining non-UK trails:
 *
 * FRANCE (Calais/Boulogne/Normandy): centroid lon > 1.2 AND lat < 51.5
 *   – Catches Calais/Boulogne/Cap Gris Nez area trails + channel-crossing Euro routes
 *   – Kent trails all have centroid lon < 1.2 OR lat > 51.5 so are safe
 *
 * IRELAND (Republic): centroid lon < -5.8 AND lat 51–55.5
 *   – Excludes a Northern Ireland keep-zone: lat > 54.5, lon -8.0 to -5.5
 *     (covers Antrim, Down, Armagh, Tyrone, Londonderry)
 *   – Donegal (ROI, lon < -8.0) is caught even above lat 54.5
 */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

// ── France / Calais ────────────────────────────────────────────────────────────
const { rows: frRows } = await pool.query(`
  SELECT id, name,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE
    ST_X(ST_Centroid(geometry)) > 1.2
    AND ST_Y(ST_Centroid(geometry)) < 51.5
  ORDER BY cy
`);

console.log(`=== France/Calais: ${frRows.length} trail(s) ===`);
for (const r of frRows) console.log(`  [${r.cx}, ${r.cy}] ${r.name}`);

// ── Republic of Ireland ────────────────────────────────────────────────────────
const { rows: irRows } = await pool.query(`
  SELECT id, name,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE
    ST_X(ST_Centroid(geometry)) < -5.8
    AND ST_Y(ST_Centroid(geometry)) BETWEEN 51.0 AND 55.5
    AND NOT (
      -- Northern Ireland keep-zone (Antrim, Down, Armagh, Tyrone, Londonderry)
      ST_Y(ST_Centroid(geometry)) > 54.5
      AND ST_X(ST_Centroid(geometry)) BETWEEN -8.0 AND -5.5
    )
  ORDER BY cy
`);

console.log(`\n=== Republic of Ireland: ${irRows.length} trail(s) ===`);
for (const r of irRows) console.log(`  [${r.cx}, ${r.cy}] ${r.name}`);

// ── Delete ─────────────────────────────────────────────────────────────────────
const allIds = [...frRows, ...irRows].map(r => r.id);

if (allIds.length === 0) {
  console.log("\nNothing to delete.");
  await pool.end();
  process.exit(0);
}

const progressRes = await pool.query(
  `DELETE FROM user_trail_progress WHERE trail_id = ANY($1::uuid[])`, [allIds]
);
const segRes = await pool.query(
  `DELETE FROM user_trail_manual_segments WHERE trail_id = ANY($1::uuid[])`, [allIds]
);
await pool.query(`DELETE FROM trails WHERE id = ANY($1::uuid[])`, [allIds]);

const { rows: [remaining] } = await pool.query(`SELECT COUNT(*) AS count FROM trails`);

console.log(`\n=== Done ===`);
console.log(`  France/Calais removed:  ${frRows.length}`);
console.log(`  Ireland (ROI) removed:  ${irRows.length}`);
console.log(`  Total removed:          ${allIds.length}`);
console.log(`  Progress records removed: ${progressRes.rowCount ?? 0}`);
console.log(`  Trails remaining:       ${remaining.count}`);

await pool.end();
