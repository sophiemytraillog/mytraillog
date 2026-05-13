/**
 * Migration: add parent_trail_id to trails and populate it for known section trails.
 * Run with: node scripts/migrate-parent-trails.mjs
 */
import { Pool } from "pg";

const pool = new Pool({
  host: "aws-0-eu-west-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  user: "postgres.aslnarlpfriidizzcbep",
  password: "%EG:y5a82ujzR6:",
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

// Parent trail UUIDs
const PARENTS = {
  SWCP:               "24c8767a-096c-4c32-a530-3119c659c3c8",
  PENNINE_WAY:        "9491fbd7-f9d3-4f47-848c-b1827ce67403",
  COAST_TO_COAST:     "c099006a-1886-43f2-b446-d9820ccea009",
  NORTH_DOWNS_WAY:    "7ac14d98-7cde-4707-9f49-4514206deeb2",
  PEDDARS_WAY:        "0316d19e-bea5-4093-82dc-dd135c56a162",
  PEMBROKESHIRE:      "1a0afcc0-055e-4644-961f-f17134e7856d",
  WEST_HIGHLAND_WAY:  "9afc7b1f-4085-441f-840a-5ffc1c5c566e",
  SOUTHERN_UPLAND:    "2517fe46-f617-480d-bdd9-c467f9b8f6c6",
  SPEYSIDE_WAY:       "f5d6c6c1-d6f5-45cc-abfa-24d4f6e2e900",
  THAMES_PATH:        "2d6050df-a34c-4c4a-8340-ece6b5d9546e",
  GREAT_GLEN_WAY:     "b4507332-2936-401a-a8e7-0e4cf9043a10",
};

// Each entry: [label, parentId, whereClause]
// All UPDATEs guard on parent_trail_id IS NULL AND category != 'national_trail'
const UPDATES = [
  [
    "South West Coast Path sections",
    PARENTS.SWCP,
    `name ILIKE 'South West Coast Path%'`,
  ],
  [
    "Pennine Way sections",
    PARENTS.PENNINE_WAY,
    `name ILIKE 'Pennine Way%'`,
  ],
  [
    "Coast to Coast Walk sections",
    PARENTS.COAST_TO_COAST,
    `name ILIKE 'Coast to Coast Walk%'`,
  ],
  [
    "North Downs Way sections",
    PARENTS.NORTH_DOWNS_WAY,
    `name ILIKE 'North Downs Way (%'`,
  ],
  [
    "Peddars Way section",
    PARENTS.PEDDARS_WAY,
    `name = 'Peddars Way'`,
  ],
  [
    "Pembrokeshire Coast Path sections",
    PARENTS.PEMBROKESHIRE,
    `name ILIKE 'Pembrokeshire Coast Path%' AND name != 'Pembrokeshire Coast Path'`,
  ],
  [
    "West Highland Way sections",
    PARENTS.WEST_HIGHLAND_WAY,
    `name ILIKE 'West Highland Way (%'`,
  ],
  [
    "Southern Upland Way sections",
    PARENTS.SOUTHERN_UPLAND,
    `name ILIKE 'Southern Upland Way (%'`,
  ],
  [
    "Speyside Way sections",
    PARENTS.SPEYSIDE_WAY,
    `name ILIKE 'Speyside Way (%'`,
  ],
  [
    "Thames Path sections",
    PARENTS.THAMES_PATH,
    `name ILIKE 'Thames Path -%'`,
  ],
  [
    "Great Glen Way sections",
    PARENTS.GREAT_GLEN_WAY,
    `name ILIKE 'Great Glen Way -%'`,
  ],
];

console.log("Connecting to database...");
const client = await pool.connect();
console.log("Connected.\n");

try {
  // ── Step 1: add column if it doesn't exist ──────────────────────────────────
  console.log("Adding parent_trail_id column (if not exists)...");
  await client.query(`
    ALTER TABLE trails
      ADD COLUMN IF NOT EXISTS parent_trail_id UUID REFERENCES trails(id);
  `);
  console.log("Column ready.\n");

  // ── Step 2: populate parent_trail_id for known section trails ───────────────
  console.log("Setting parent_trail_id for section trails...");
  let totalRowsUpdated = 0;

  for (const [label, parentId, whereClause] of UPDATES) {
    const sql = `
      UPDATE trails
         SET parent_trail_id = $1
       WHERE ${whereClause}
         AND parent_trail_id IS NULL
         AND category != 'national_trail';
    `;
    const result = await client.query(sql, [parentId]);
    const count = result.rowCount ?? 0;
    totalRowsUpdated += count;
    console.log(`  ${label}: ${count} row(s) updated`);
  }

  console.log(`\nTotal rows updated: ${totalRowsUpdated}`);

  // ── Step 3: verification count ──────────────────────────────────────────────
  console.log("\nVerification:");
  const { rows } = await client.query(`
    SELECT COUNT(*) AS total_with_parent
      FROM trails
     WHERE parent_trail_id IS NOT NULL;
  `);
  console.log(`  Trails with parent_trail_id set: ${rows[0].total_with_parent}`);

  console.log("\nMigration complete.");
} catch (err) {
  console.error("Migration failed:", err.message);
  if (err.detail) console.error("Detail:", err.detail);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
