import { Pool, QueryResultRow } from "pg";

// Singleton pool — prevents exhausting connections during Next.js hot reloads
const globalForPg = globalThis as unknown as { _pgPool?: Pool };

export const pool =
  globalForPg._pgPool ??
  new Pool({
    // Uses PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD env vars.
    // We deliberately avoid `connectionString` because the password contains
    // literal % characters that pg-connection-string would try to URL-decode.
    ssl: { rejectUnauthorized: false },
    max: process.env.NODE_ENV === "production" ? 1 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPg._pgPool = pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
) {
  return pool.query<T>(sql, params);
}
