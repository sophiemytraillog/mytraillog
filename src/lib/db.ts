import { Pool, QueryResultRow } from "pg";

// Singleton pool — prevents exhausting connections during Next.js hot reloads
const globalForPg = globalThis as unknown as { _pgPool?: Pool };

// Discrete PG* vars, not DATABASE_URL: the connection string's password has
// literal % characters that pg's URL parser tries to percent-decode, and
// (separately) its embedded sslmode=require is treated by pg as an alias for
// verify-full — which silently overrides the rejectUnauthorized:false below
// and made every connection fail with "self-signed certificate in
// certificate chain". Every script in this repo already connects this way;
// db.ts was the one place still using the connection string.
export const pool =
  globalForPg._pgPool ??
  new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
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
