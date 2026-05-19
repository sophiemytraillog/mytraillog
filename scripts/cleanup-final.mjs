/**
 * Definitive trail cleanup — three passes, each with a preview before deleting.
 *
 * 1. FRANCE  — centroid lon > 1.2 AND lat < 51.15
 *    Catches all Normandy / Calais / channel-crossing routes.
 *    Kent trails all sit at lat > 51.2 so are safe.
 *
 * 2. NCN / generic cycle routes — name-based filter (same as initial cleanup).
 *
 * 3. REPUBLIC OF IRELAND — centroid in Ireland (lon < -5.8) excluding NI:
 *    NI keep zone A: lat > 54.0 AND lon -7.0 to -5.4  (Down, Armagh, Antrim, E.Derry)
 *    NI keep zone B: lat > 54.5 AND lon -8.0 to -5.4  (Tyrone, Fermanagh, N.Derry, Antrim coast)
 */
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PGHOST, port: parseInt(process.env.PGPORT),
  database: process.env.PGDATABASE, user: process.env.PGUSER,
  password: process.env.PGPASSWORD, ssl: { rejectUnauthorized: false },
});

async function deleteIds(ids) {
  if (ids.length === 0) return 0;
  const p = await pool.query(`DELETE FROM user_trail_progress WHERE trail_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM user_trail_manual_segments WHERE trail_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM trails WHERE id = ANY($1::uuid[])`, [ids]);
  return p.rowCount ?? 0;
}

// ── 1. France ─────────────────────────────────────────────────────────────────
const { rows: frRows } = await pool.query(`
  SELECT id, name,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE ST_X(ST_Centroid(geometry)) > 1.2
    AND ST_Y(ST_Centroid(geometry)) < 51.15
  ORDER BY cy
`);
console.log(`=== France/Calais: ${frRows.length} ===`);
for (const r of frRows) console.log(`  [${r.cx}, ${r.cy}] ${r.name}`);
const frProgress = await deleteIds(frRows.map(r => r.id));

// ── 2. NCN / generic cycle routes ─────────────────────────────────────────────
const { rows: ncnRows } = await pool.query(`
  SELECT id, name FROM trails
  WHERE
    name ILIKE '%NCN%'
    OR name ILIKE '%National Cycle Network%'
    OR name ILIKE '%National Cycle Route%'
    OR name ILIKE '%Regional Cycle Route%'
    OR name ILIKE '%Sustrans%'
    OR name ~* '^Route\\s+\\d+$'
  ORDER BY name
`);
console.log(`\n=== NCN / cycle routes: ${ncnRows.length} ===`);
for (const r of ncnRows) console.log(`  ${r.name}`);
const ncnProgress = await deleteIds(ncnRows.map(r => r.id));

// ── 3. Republic of Ireland ─────────────────────────────────────────────────────
const { rows: irRows } = await pool.query(`
  SELECT id, name,
    round(ST_X(ST_Centroid(geometry))::numeric, 3) AS cx,
    round(ST_Y(ST_Centroid(geometry))::numeric, 3) AS cy
  FROM trails
  WHERE
    ST_X(ST_Centroid(geometry)) < -5.8
    AND ST_Y(ST_Centroid(geometry)) BETWEEN 51.0 AND 55.5
    AND NOT (
      -- NI zone A: Down, Armagh, Antrim, eastern Derry
      (ST_Y(ST_Centroid(geometry)) > 54.0
       AND ST_X(ST_Centroid(geometry)) BETWEEN -7.0 AND -5.4)
      OR
      -- NI zone B: Tyrone, Fermanagh, northern Derry, Antrim coast
      (ST_Y(ST_Centroid(geometry)) > 54.5
       AND ST_X(ST_Centroid(geometry)) BETWEEN -8.0 AND -5.4)
    )
  ORDER BY cy
`);
console.log(`\n=== Republic of Ireland: ${irRows.length} ===`);
for (const r of irRows) console.log(`  [${r.cx}, ${r.cy}] ${r.name}`);
const irProgress = await deleteIds(irRows.map(r => r.id));

// ── Summary ───────────────────────────────────────────────────────────────────
const { rows: [rem] } = await pool.query(`SELECT COUNT(*) AS count FROM trails`);
const total = frRows.length + ncnRows.length + irRows.length;
const totalProgress = frProgress + ncnProgress + irProgress;

console.log(`
=== Summary ===
  France removed:         ${frRows.length}
  NCN routes removed:     ${ncnRows.length}
  Ireland (ROI) removed:  ${irRows.length}
  Total removed:          ${total}
  Progress records cleared: ${totalProgress}
  Trails remaining:       ${rem.count}
`);

await pool.end();
