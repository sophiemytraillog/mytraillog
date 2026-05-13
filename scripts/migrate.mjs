/**
 * Run with: npm run db:migrate
 * Uses node --env-file=.env.local to load credentials without extra deps.
 */
import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, "../src/lib/schema.sql"), "utf-8");

const pool = new Pool({
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

console.log("Connecting to database...");

try {
  const client = await pool.connect();
  console.log(`Connected to ${process.env.PGHOST}/${process.env.PGDATABASE}`);

  console.log("Running schema migration...");
  await client.query(sql);
  client.release();

  console.log("✓ Migration complete.");
} catch (err) {
  console.error("✗ Migration failed:", err.message);
  if (err.detail) console.error("  Detail:", err.detail);
  process.exit(1);
} finally {
  await pool.end();
}
