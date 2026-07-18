/**
 * Trail database cleanup — two passes:
 *   1. Remove trails outside the UK (south of lat 49.5 or east of lon 2.0)
 *   2. Remove National Cycle Network / generic cycle route entries
 *
 * Cascades to user_trail_progress and user_trail_manual_segments.
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

async function deleteTrails(ids, label) {
  if (ids.length === 0) return { progress: 0, segments: 0 };
  const progressRes = await pool.query(
    `DELETE FROM user_trail_progress WHERE trail_id = ANY($1::uuid[])`, [ids]
  );
  const segRes = await pool.query(
    `DELETE FROM user_trail_manual_segments WHERE trail_id = ANY($1::uuid[])`, [ids]
  );
  await pool.query(`DELETE FROM trails WHERE id = ANY($1::uuid[])`, [ids]);
  return { progress: progressRes.rowCount ?? 0, segments: segRes.rowCount ?? 0 };
}

// ── 1. Out-of-UK trails ────────────────────────────────────────────────────────
console.log("=== Pass 1: Trails outside UK bounds ===\n");

const oobResult = await pool.query(`
  SELECT
    id, name, region,
    round(ST_YMin(ST_Envelope(geometry))::numeric, 3) AS lat_min,
    round(ST_XMax(ST_Envelope(geometry))::numeric, 3) AS lon_max
  FROM trails
  WHERE
    ST_YMin(ST_Envelope(geometry)) < 49.5
    OR ST_XMax(ST_Envelope(geometry)) > 2.0
  ORDER BY lat_min, name
`);

if (oobResult.rows.length === 0) {
  console.log("  None found.\n");
} else {
  for (const r of oobResult.rows) {
    console.log(`  [lat_min=${r.lat_min}, lon_max=${r.lon_max}] ${r.name} (${r.region})`);
  }
  console.log();
}

const oobIds = oobResult.rows.map(r => r.id);
const oobDeleted = await deleteTrails(oobIds, "out-of-UK");
console.log(`  Removed: ${oobIds.length} trail(s), ${oobDeleted.progress} progress record(s)\n`);

// ── 2. NCN / generic cycle network routes ────────────────────────────────────
console.log("=== Pass 2: NCN / cycle network routes ===\n");

const ncnResult = await pool.query(`
  SELECT id, name, region
  FROM trails
  WHERE
    name ILIKE '%NCN%'
    OR name ILIKE '%National Cycle Network%'
    OR name ILIKE '%National Cycle Route%'
    OR name ILIKE '%Regional Cycle Route%'
    OR name ILIKE '%Sustrans%'
    OR name ~* '^Route\\s+\\d+$'
  ORDER BY name
`);

if (ncnResult.rows.length === 0) {
  console.log("  None found.\n");
} else {
  for (const r of ncnResult.rows) {
    console.log(`  ${r.name} (${r.region})`);
  }
  console.log();
}

const ncnIds = ncnResult.rows.map(r => r.id);
const ncnDeleted = await deleteTrails(ncnIds, "NCN");
console.log(`  Removed: ${ncnIds.length} trail(s), ${ncnDeleted.progress} progress record(s)\n`);

// ── Summary ───────────────────────────────────────────────────────────────────
const { rows: [remaining] } = await pool.query(`SELECT COUNT(*) AS count FROM trails`);

console.log("=== Summary ===");
console.log(`  Out-of-UK trails removed:  ${oobIds.length}`);
console.log(`  NCN/cycle routes removed:  ${ncnIds.length}`);
console.log(`  Total removed:             ${oobIds.length + ncnIds.length}`);
console.log(`  Trails remaining:          ${remaining.count}`);

await pool.end();
