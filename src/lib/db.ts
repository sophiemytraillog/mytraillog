import { Pool, QueryResultRow } from "pg";

// Singleton pool — prevents exhausting connections during Next.js hot reloads
const globalForPg = globalThis as unknown as { _pgPool?: Pool };

// REVERTED: a locally-reproduced "self-signed certificate in certificate
// chain" issue with connectionString looked like a real bug (see git
// history), but switching to discrete PGHOST/PGPORT/etc was never verified
// against Vercel's actual production environment variables — only tested
// locally against .env.local. If Vercel was only ever configured with
// DATABASE_URL (very possible — the PG* vars may only exist for this
// repo's local-only scripts/*.mjs), that change would silently break every
// DB operation in production. Reverting to the connection string, which is
// what actually ran successfully in production for months prior.
export const pool =
  globalForPg._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: process.env.NODE_ENV === "production" ? 3 : 10,
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
