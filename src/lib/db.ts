import { Pool, QueryResultRow } from "pg";

// Singleton pool — prevents exhausting connections during Next.js hot reloads
const globalForPg = globalThis as unknown as { _pgPool?: Pool; _pgBatchPool?: Pool };

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

// Separate, deliberately small pool for unattended background sweeps — the
// daily trail-match drain and description-backlog drain (see match-chain.ts's
// runMatchDrainHop and description-chain.ts's runBacklogDrainHop). Root cause
// this exists to fix (2026-08-22): those sweeps run continuously across every
// user in the account, and Supabase's pooler has a hard session-count ceiling
// shared by everything hitting it. Giving them their own pool with a small
// `max` means they can never claim more than a couple of slots no matter how
// long they run, guaranteeing `pool` — used by the Strava webhook and other
// live, user-facing requests — always has room. connectionTimeoutMillis is
// generously long here for the same reason: a background sweep can afford to
// wait several seconds for a free connection; a webhook response can't.
export const batchPool =
  globalForPg._pgBatchPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: process.env.NODE_ENV === "production" ? 1 : 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });

const isNewBatchPool = !globalForPg._pgBatchPool;
if (isNewBatchPool) {
  batchPool.on("error", (err) => {
    console.error("[db] Idle batch-pool client error:", err.message);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPg._pgBatchPool = batchPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
) {
  return pool.query<T>(sql, params);
}
