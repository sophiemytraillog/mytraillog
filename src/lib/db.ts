import { Client, Pool, QueryResult, QueryResultRow } from "pg";

// ── Per-query statement_timeout through Supabase's transaction-mode pooler ──
//
// DATABASE_URL goes through Supavisor on port 6543 (transaction mode). It
// ignores connection-time settings (pg's `statement_timeout` option and
// `options=-c statement_timeout=...` were both tested 2026-11-02: SHOW still
// reported the server default of 2min), and a plain session-level `SET`
// lands on whichever backend happens to serve it — it can leak to other
// requests sharing that backend, or never apply to the next query at all.
// The only reliable way to bound a statement is `SET LOCAL` inside the same
// transaction as the statement itself.
//
// TimeoutClient does that automatically:
//   - A standalone statement runs as `BEGIN; SET LOCAL statement_timeout = N`
//     → statement → COMMIT (ROLLBACK on error).
//   - An explicit BEGIN gets `SET LOCAL statement_timeout = N` right after it;
//     any `SET LOCAL statement_timeout` the code issues later in that
//     transaction overrides it as before (e.g. match-trails.ts's 3 min).
//   - `SET [LOCAL] statement_timeout = X` outside a transaction is NOT sent
//     (that's what leaked); X becomes the limit for the rest of this
//     checkout instead, so routes like fill-gaps (55s) keep their own limit.
//     Reset on every checkout via the pool's "acquire" event.
//
// Caveat: statement_timeout only stops a query at a point where Postgres
// checks for cancellation. Heavy PostGIS/GEOS unions can run well past it —
// a MATCH_SQL query with a 3-minute SET LOCAL was seen running for ~12 min.
const TXN_START = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const TXN_END = /^\s*(COMMIT|END|ABORT|ROLLBACK)\b(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b)/i;
const SET_TIMEOUT =
  /^\s*SET\s+(?:(?:LOCAL|SESSION)\s+)?statement_timeout\s*(?:=|TO)\s*'?\s*(\d+)\s*(ms|s|min)?\s*'?\s*;?\s*$/i;
const RESET_TIMEOUT = /^\s*RESET\s+statement_timeout\s*;?\s*$/i;
// Statements that can't run inside a transaction block, or that shouldn't be
// wrapped (session/transaction control, utility commands).
const NO_WRAP =
  /^\s*(SET|RESET|SHOW|VACUUM|ANALYZE|CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX|CLUSTER|LISTEN|UNLISTEN|NOTIFY|COPY|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED|DISCARD|DEALLOCATE)\b/i;

function timeoutToMs(value: string, unit: string | undefined): number {
  const n = parseInt(value, 10);
  switch (unit?.toLowerCase()) {
    case "s":
      return n * 1000;
    case "min":
      return n * 60_000;
    default:
      return n;
  }
}

function makeTimeoutClient(defaultTimeoutMs: number) {
  return class TimeoutClient extends Client {
    private inTxn = false;
    private overrideMs: number | null = null;

    resetTimeoutState() {
      this.inTxn = false;
      this.overrideMs = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query(config: any, values?: any, callback?: any): any {
      if (typeof values === "function") {
        callback = values;
        values = undefined;
      }
      // Only plain text queries are managed; submittables (cursors, streams)
      // pass straight through.
      const text =
        typeof config === "string"
          ? config
          : config && typeof config.text === "string" && typeof config.submit !== "function"
            ? config.text
            : null;
      if (text === null) return super.query(config, values, callback);

      const result = this.runWithTimeout(text, config, values);
      if (typeof callback === "function") {
        result.then((res) => callback(null, res), (err) => callback(err));
        return undefined;
      }
      return result;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private raw(config: any, values?: any): Promise<QueryResult> {
      return super.query(config, values);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async runWithTimeout(text: string, config: any, values: any): Promise<QueryResult> {
      const set = text.match(SET_TIMEOUT);
      if (set) {
        const ms = timeoutToMs(set[1], set[2]);
        if (this.inTxn) return this.raw(`SET LOCAL statement_timeout = ${ms}`);
        this.overrideMs = ms;
        return { command: "SET", rowCount: null, oid: 0, rows: [], fields: [] };
      }
      if (RESET_TIMEOUT.test(text)) {
        this.overrideMs = null;
        if (this.inTxn) return this.raw(`SET LOCAL statement_timeout = ${defaultTimeoutMs}`);
        return { command: "RESET", rowCount: null, oid: 0, rows: [], fields: [] };
      }

      const timeoutMs = this.overrideMs ?? defaultTimeoutMs;

      if (TXN_START.test(text)) {
        const res = await this.raw(config, values);
        this.inTxn = true;
        await this.raw(`SET LOCAL statement_timeout = ${timeoutMs}`);
        return res;
      }
      if (TXN_END.test(text)) {
        try {
          return await this.raw(config, values);
        } finally {
          this.inTxn = false;
        }
      }
      if (this.inTxn || NO_WRAP.test(text)) return this.raw(config, values);

      await this.raw(`BEGIN; SET LOCAL statement_timeout = ${timeoutMs}`);
      try {
        const res = await this.raw(config, values);
        await this.raw("COMMIT");
        return res;
      } catch (err) {
        await this.raw("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  };
}

// Default per-statement limit for the shared, user-facing pool. Code that
// needs longer (matching's 3 min, fill-gaps' 55s) sets its own, as before.
// The background batch pools below are left on the server default (2min).
const MAIN_POOL_STATEMENT_TIMEOUT_MS = 30_000;

// Singleton pool — prevents exhausting connections during Next.js hot reloads
const globalForPg = globalThis as unknown as {
  _pgPool?: Pool;
  _pgDescriptionBatchPool?: Pool;
  _pgMatchBatchPool?: Pool;
  _pgSyncBatchPool?: Pool;
};

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
    // Raised 3 -> 6 (2026-10-30): Postgres had ~15 of 60 connections in use
    // while the app was failing with "timeout exceeded when trying to
    // connect" — the queue was in these app-side pools, not the database.
    max: process.env.NODE_ENV === "production" ? 6 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    Client: makeTimeoutClient(MAIN_POOL_STATEMENT_TIMEOUT_MS),
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
  // A timeout set by one route must not carry over to the next checkout.
  pool.on("acquire", (client) => {
    (client as unknown as { resetTimeoutState?: () => void }).resetTimeoutState?.();
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPg._pgPool = pool;
}

// Separate, deliberately small pools for unattended background sweeps — the
// description-backlog drain (description-chain.ts's runBacklogDrainHop and
// runExternalDrainBatch) and the trail-match drain (match-chain.ts's
// runMatchDrainHop). Root cause this exists to fix (2026-08-22): those sweeps
// run continuously across every user in the account, and Supabase's pooler
// has a hard session-count ceiling shared by everything hitting it. Giving
// them their own pool with a small `max` means they can never claim more
// than a couple of slots no matter how long they run, guaranteeing `pool` —
// used by the Strava webhook and other live, user-facing requests — always
// has room. connectionTimeoutMillis is generously long here for the same
// reason: a background sweep can afford to wait several seconds for a free
// connection; a webhook response can't.
//
// Originally a single shared `batchPool` covered both drains. Split into two
// on 2026-09-02 after the description drain became a near-continuous poller
// (cron-job.org hitting /api/internal/drain-batch every ~2 minutes, not once
// a day — see drain-batch's own history) and started permanently occupying
// the one shared connection, starving the match drain out: confirmed via
// "timeout exceeded when trying to connect" errors from BOTH sides
// (match-trails' per-trail write, and external-drain's own batch call) and
// match_drain_hop hops logging "started" and then nothing at all as the
// whole function hung waiting for a connection that never freed up. Each
// drain now has its own pool, so neither can starve the other no matter how
// busy either one is.
//
// Raised 1 -> 4 per pool (2026-10-30, Vercel Pro): with 300s functions and
// Fluid compute running several invocations on one instance, a single
// connection per pool was the bottleneck — 113 sync chunks failed in one day
// with "timeout exceeded when trying to connect" while Postgres itself sat
// at ~15/60 connections. Worst case per instance is now 6 + 4 + 4 + 4 = 18.
function makeBatchPool(prodMax = 4) {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: process.env.NODE_ENV === "production" ? prodMax : 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
}

export const descriptionBatchPool = globalForPg._pgDescriptionBatchPool ?? makeBatchPool();
const isNewDescriptionBatchPool = !globalForPg._pgDescriptionBatchPool;
if (isNewDescriptionBatchPool) {
  descriptionBatchPool.on("error", (err) => {
    console.error("[db] Idle description-batch-pool client error:", err.message);
  });
}
if (process.env.NODE_ENV !== "production") {
  globalForPg._pgDescriptionBatchPool = descriptionBatchPool;
}

// max=3 (not the other batch pools' 1), 2026-09-22: since the reactive sync
// chain started routing finishSync's matching work here too (see
// syncBatchPool's comment below), this pool can now have several hops'
// worth of finishSync calls genuinely overlapping at once — confirmed in
// production testing Luke Davis's account, hops firing every ~16-17s while
// a single finishSync call can legitimately take up to its own 30s race
// budget (FINISH_SYNC_RACE_BUDGET_MS, sync-chain.ts). On a single
// connection, those overlapping calls just queue behind each other and
// each one's own race times out waiting for a connection that never frees
// up in time — confirmed directly: 13+ consecutive matching_triggered
// events with zero matching_complete. Three connections gives enough
// concurrent headroom for that overlap to actually make progress instead
// of serializing into a permanent queue, while still being a small,
// dedicated pool that can't compete with live user-facing traffic on the
// shared `pool`.
// (Now 4, same as the other batch pools — see makeBatchPool, 2026-10-30.)
export const matchBatchPool = globalForPg._pgMatchBatchPool ?? makeBatchPool(4);
const isNewMatchBatchPool = !globalForPg._pgMatchBatchPool;
if (isNewMatchBatchPool) {
  matchBatchPool.on("error", (err) => {
    console.error("[db] Idle match-batch-pool client error:", err.message);
  });
}
if (process.env.NODE_ENV !== "production") {
  globalForPg._pgMatchBatchPool = matchBatchPool;
}

// Dedicated pool for the sync-continuation chain (sync-chain.ts). Root
// cause this exists to fix (2026-09-22): the reactive self-dispatch chain
// reliably died at hop 3 every run testing Luke Davis's reconnect, always
// with "timeout exceeded when trying to connect" — the same Supabase
// pooler-exhaustion failure match-chain.ts's equivalent drain hit and had
// to be worked around for (see MATCH_DRAIN_CHAINING_ENABLED there), caused
// by runSyncChunk/finishSync competing with live user-facing traffic (the
// Strava webhook, real dashboard visits) for the shared `pool`'s tiny
// production max (3) — worse here than for matching, since each hop fires
// a fresh serverless invocation within milliseconds of the last (confirmed
// in production logs: sub-second gaps between hops), so a burst of hops
// can hold several connections from this pool at once. Same fix as
// matchBatchPool/descriptionBatchPool: its own small dedicated pool means
// the sync chain can never starve live traffic, or be starved by it.
export const syncBatchPool = globalForPg._pgSyncBatchPool ?? makeBatchPool();
const isNewSyncBatchPool = !globalForPg._pgSyncBatchPool;
if (isNewSyncBatchPool) {
  syncBatchPool.on("error", (err) => {
    console.error("[db] Idle sync-batch-pool client error:", err.message);
  });
}
if (process.env.NODE_ENV !== "production") {
  globalForPg._pgSyncBatchPool = syncBatchPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
) {
  return pool.query<T>(sql, params);
}
