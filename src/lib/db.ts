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
const isNewPool = !globalForPg._pgPool;

export const pool =
  globalForPg._pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: process.env.NODE_ENV === "production" ? 3 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

// node-postgres emits 'error' on the Pool itself (not on whatever client
// happens to be mid-query) when an IDLE pooled connection drops — e.g. a
// network blip, or Supabase recycling a connection between two queries in
// the same request. Without a listener here, that's an unhandled
// EventEmitter 'error' event, which is fatal to the whole Node process by
// default — bypassing every try/catch in the app, since it isn't tied to
// any in-flight await. Confirmed happening in practice (scripts/resume-
// sync.mjs crashed this way mid-sweep); this is the same pool every route
// in the app shares, so the same crash was equally possible in a live
// Vercel invocation. Logging and swallowing it here is standard
// node-postgres practice — the dead connection is simply removed from the
// pool and a new one opened on the next query.
// Only attach once per actual Pool object: this module re-evaluates on
// every Next.js dev-mode hot-reload, but the pool itself is reused via
// globalForPg (see below) — attaching unconditionally would pile up a new
// listener on every reload.
if (isNewPool) {
  pool.on("error", (err) => {
    console.error("[db] Idle pool client error:", err.message);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPg._pgPool = pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
) {
  return pool.query<T>(sql, params);
}
