import { matchBatchPool } from "@/lib/db";
import { matchNextBatch, STALE_CHECK_BBOX_DEGREES } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { ADMIN_USER_ID } from "@/lib/admin";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Same batch shape as the admin route and the old client-driven endpoint —
// one call's worth of real work, safely within Vercel's 60s function cap.
const CHAIN_BATCH_SIZE = 30;
const CHAIN_TIME_BUDGET_MS = 45_000;

// 80 hops * 30 trails/hop = 2,400 trail-checks — comfortably more than the
// ~1,181-trail catalog even accounting for retries, just a backstop against
// a chain that somehow never converges (e.g. matchNextBatch's candidate
// query returning the same never-succeeding trails every time) looping
// forever and quietly running up function invocations.
const MAX_CHAIN_HOPS = 80;

// Same "Vercel sets this automatically when CRON_SECRET is configured,
// falls back to unauthenticated (logged) otherwise" pattern as
// cron/resume-stuck-syncs — functional without it, more secure with it.
function chainAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

// Same hardening as description-chain.ts's dispatchNextHop (2026-08-27) —
// retries a transient dispatch failure instead of letting it silently end
// the chain, with an explicit per-attempt timeout so a hanging fetch can't
// eat the whole remaining hop budget across retries.
const DISPATCH_MAX_ATTEMPTS = 2;
const DISPATCH_ATTEMPT_TIMEOUT_MS = 5_000;
const DISPATCH_RETRY_DELAY_MS = 500;

async function dispatchNextHop(path: string, body: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= DISPATCH_MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DISPATCH_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(new URL(path, CHAIN_DISPATCH_ORIGIN), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...chainAuthHeaders() },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.ok) return true;
      console.error(`[chain-dispatch] ${path} returned HTTP ${res.status} (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS})`);
    } catch (err) {
      console.error(`[chain-dispatch] ${path} failed (attempt ${attempt}/${DISPATCH_MAX_ATTEMPTS}):`, err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < DISPATCH_MAX_ATTEMPTS) await sleep(DISPATCH_RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Runs one batch of trail matching for a user, then — if there's more left
 * — hands off to a FRESH serverless invocation via an HTTP call to
 * /api/internal/continue-matching rather than looping in-process. That's
 * the actual trick for outrunning Vercel's 60s per-invocation cap on a
 * ~1,181-trail catalog: each hop's own execution time only ever covers one
 * batch (~45s worst case), never the whole remaining backlog, no matter how
 * many hops it takes to finish.
 *
 * Callers run this inside waitUntil() (see /api/sync/activities and
 * dashboard/page.tsx) so it keeps working after their own response has
 * already been sent — sync completing, or the dashboard rendering, no
 * longer means the browser has to stay open for matching to finish. The
 * daily cron sweep (cron/resume-stuck-syncs) remains as a once-a-day
 * backstop for whatever this misses — a chain that fails outright (network
 * blip dispatching the next hop, a deploy restarting mid-chain) doesn't
 * retry itself, by design: better to let the next natural trigger (another
 * sync, another dashboard visit, or the cron) pick it up than to build
 * retry logic into a fire-and-forget background chain.
 */
export async function runMatchBatchAndChain(
  userId: string,
  hop = 0
): Promise<void> {
  if (hop >= MAX_CHAIN_HOPS) {
    console.warn(
      `[match-chain] Hop limit (${MAX_CHAIN_HOPS}) reached for user ${userId} — stopping; the daily cron sweep will pick up whatever's left`
    );
    return;
  }

  let result;
  try {
    result = await matchNextBatch(userId, CHAIN_BATCH_SIZE, CHAIN_TIME_BUDGET_MS, matchBatchPool);
  } catch (err) {
    console.error(`[match-chain] Batch failed for user ${userId} at hop ${hop}:`, err);
    return;
  }

  if (result.done) {
    console.log(
      `[match-chain] Complete for user ${userId} after ${hop + 1} hop(s) — ${result.totalChecked}/${result.totalTrails} trails checked`
    );
    return;
  }

  try {
    // Awaited only until the next hop acknowledges receipt (its own handler
    // responds immediately and does its batch afterward via its own
    // waitUntil) — not until the rest of the chain finishes, so this
    // invocation's own lifetime stays bounded to just its own batch.
    const res = await fetch(new URL("/api/internal/continue-matching", CHAIN_DISPATCH_ORIGIN), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chainAuthHeaders() },
      body: JSON.stringify({ userId, hop: hop + 1 }),
    });
    if (!res.ok) {
      console.error(`[match-chain] Next hop dispatch for user ${userId} returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[match-chain] Failed to dispatch next hop for user ${userId}:`, err);
  }
}

/** Starts a fresh chain (hop 0) — the entry point callers actually use. */
export function triggerMatchChain(userId: string): Promise<void> {
  return runMatchBatchAndChain(userId, 0);
}

// ── Daily match-backlog drain (cron-triggered) ──────────────────────────────
//
// runMatchBatchAndChain above is reactive and scoped to one user — it only
// ever runs for whoever just synced or opened the dashboard. Dormant
// accounts (set up once, never revisited) never trigger it at all: found
// during the 2026-08-21 pre-launch review, 6 of 10 users were still sitting
// at 8-245 of 1,181 trails checked, weeks after their last sync, because
// nothing had ever prompted their chain to run. The old cron sweep (5
// users/day, 30 trails/user) was too slow to close that on its own — at
// that rate a user needing 1,100+ trails would take over a month. This was
// originally the proactive equivalent of description-chain.ts's backlog
// drain: cycle through EVERY user with incomplete matching, hop after hop,
// via self-dispatch to /api/internal/continue-match-drain, until nothing's
// left.
//
// Self-dispatch chaining DISABLED, 2026-09-02 (see MATCH_DRAIN_CHAINING_ENABLED
// below) — after three rounds of fixes (query cost, connection-acquisition,
// then a dedicated matchBatchPool) still couldn't stop hops from dying on
// "timeout exceeded when trying to connect" against Supabase's pooler, which
// smelled like a project-level pooler/connection ceiling being hit by the
// combined total of concurrently-running Vercel instances — not something
// fixable by reshaping our own in-app pools further, and each failed hop was
// a real risk to live traffic sharing that same pooler. Until that's
// actually diagnosed (Supabase's own connection limit, concurrency patterns),
// this now does ONE short batch per cron run and stops — no chaining, no
// risk of a runaway hop sequence contending for connections. At current
// backlog sizes (~400 stale pairs) even 20/day clears it in about three
// weeks; this doesn't need to be fast, just not break anything else.
const DRAIN_HOP_BATCH_SIZE = 30;
const DRAIN_HOP_TIME_BUDGET_MS = 15_000;

// Flip back to true once the underlying pooler-contention question above is
// actually resolved — the chaining code itself (dispatchNextHop call and
// MAX_DRAIN_HOPS backstop) is left in place, just unreachable while this is
// false.
const MATCH_DRAIN_CHAINING_ENABLED = false;

// No daily budget cap here unlike the description drain — trail matching
// doesn't spend a scarce external quota (Strava's rate limit), just DB/CPU
// time, so there's no equivalent of reserveBackfillSlot to respect. Bounded
// instead by a generous hop count purely as a backstop against a chain that
// somehow never converges. Moot while MATCH_DRAIN_CHAINING_ENABLED is false
// (every cron run is hop 0 and stops itself), kept for when chaining is
// re-enabled.
const MAX_DRAIN_HOPS = 300;

// Least-recently-swept user first (own cron_match_sweep/client_match_batch
// sync_log events as the clock, NULLS FIRST so a user who's never had one
// goes first) — same round-robin-by-history trick as
// description-chain.ts's pickNextDrainCandidate, so one very-behind account
// doesn't hold up everyone else's turn.
//
// Root cause this exists to fix (2026-08-31): this WHERE clause only asked
// "does this user have any trail with NO check row at all" — it had no
// staleness awareness, unlike matchNextBatch's own candidate query one
// level down (which correctly treats a check as needing redoing when a
// newer nearby activity has landed since — see STALE_CHECK_BBOX_DEGREES in
// match-trails.ts). Once every user reached full coverage (a check row for
// every trail, even if some are stale), this outer gate could never select
// ANYONE again — matchNextBatch was fully capable of resolving stale pairs
// the moment it got a chance to run, but never got that chance, because
// the picker in front of it kept reporting "nothing to drain" every single
// night. Result: the stale count only ever grew (new activities keep
// invalidating checks) with nothing ever bringing it back down — confirmed
// via two consecutive nightly cron runs both logging match_drain_hop
// {"outcome":"nothing_to_drain"} in ~100ms, despite the stale count having
// grown from 94 to 114 over the same period.
//
// First attempt at the staleness check (2026-08-31, same day) drove the
// correlation from trails: for every one of a user's 1,181 trails, run a
// subquery over that user's activities checking for a newer nearby one.
// That's the wrong side to drive from — most users add a handful of new
// activities a day, far fewer than 1,181 trails — and it had no query-level
// statement_timeout, so it just hung for the full 60s until Vercel force-
// killed the whole function, confirmed directly: "Task timed out after 60
// seconds" with no other error, and match_drain_hop logging "started" with
// nothing after it, every single time.
//
// This version drives from activities instead (JOIN trails ON t.simplified_geometry
// && ST_Expand(a.geometry, ...) — the same indexed-bbox-on-the-left pattern
// documented everywhere else in this codebase, e.g. matchNextBatch's own
// staleness clause and getActivityTrailMatches's candidate query), so
// Postgres can use idx_trails_simplified_geometry per activity rather than
// re-scanning a user's whole activity history once per trail. The
// trail_match_checks join is on its own primary key, not a correlated
// EXISTS. Also now wrapped in its own bounded statement_timeout — if it's
// ever slow for some account this doesn't anticipate, it fails fast and
// this hop just tries again next time, instead of consuming the entire
// function budget silently.
const CANDIDATE_QUERY_TIMEOUT_MS = 10_000;

async function pickNextMatchDrainCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  // matchBatchPool, not the shared `pool` — this picker runs every hop of an
  // unattended sweep, same reasoning as matchNextBatch's own connection a
  // few lines down. Root cause this exists to fix (2026-09-01): it used to
  // grab a connection from the shared `pool` (max 3 in production, shared
  // with the live Strava webhook) *before* the try block below, so any
  // failure to acquire one — the pool being busy, a connectionTimeoutMillis
  // timeout — rejected uncaught, silently killing the whole hop with
  // nothing logged past match_drain_hop's own "started" entry. Confirmed in
  // production: three consecutive hops (2026-08-31 19:45, 2026-09-01 03:06,
  // 2026-09-01 10:25) each logged "started" and then nothing at all — no
  // "nothing_to_drain", no "hard_failure", no "dispatched_next" — while a
  // real, growing backlog (390 stale pairs across 9 users) sat undrained.
  // Moving the connect() inside try/catch means a failed acquisition now
  // degrades to the same safe `null` fallback as a query failure, instead
  // of crashing the hop.
  //
  // Second root cause (2026-09-02): moving this to the single shared
  // batchPool didn't fully fix it either — that pool was ALSO used by the
  // description drain, which by then had become a near-continuous poller
  // (cron-job.org hitting /api/internal/drain-batch every ~2 minutes), so it
  // permanently occupied the one available connection and starved this
  // picker and matchNextBatch's own writes out the same way, just from a
  // different cause: "timeout exceeded when trying to connect" from both
  // sides, and match_drain_hop hops still dying silently after "started".
  // Split into its own dedicated matchBatchPool (see db.ts) so the two
  // drains can never starve each other.
  let client;
  try {
    client = await matchBatchPool.connect();
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${CANDIDATE_QUERY_TIMEOUT_MS}'`);
    const { rows } = await client.query<{ id: string; first_name: string | null }>(
      `SELECT u.id, u.first_name
       FROM users u
       WHERE (
         EXISTS (
           SELECT 1 FROM trails t
           WHERE NOT EXISTS (
             SELECT 1 FROM trail_match_checks c WHERE c.user_id = u.id AND c.trail_id = t.id
           )
         )
         OR EXISTS (
           SELECT 1
           FROM activities a
           JOIN trails t ON t.simplified_geometry && ST_Expand(a.geometry, ${STALE_CHECK_BBOX_DEGREES})
           JOIN trail_match_checks c ON c.user_id = a.user_id AND c.trail_id = t.id
           WHERE a.user_id = u.id
             AND a.geometry IS NOT NULL
             AND a.created_at > c.checked_at
         )
       )
       -- Basic-feature gate (2026-09-30): matching stops for grace_period/
       -- expired accounts, same as sync — see subscription.ts's
       -- hasBasicAccess (kept in sync manually, since this runs as raw SQL
       -- rather than importing the JS helper).
       AND u.subscription_status IN ('trial', 'active')
       ORDER BY COALESCE(
         (SELECT MAX(s.created_at) FROM sync_log s
          WHERE s.user_id = u.id AND s.event IN ('cron_match_sweep', 'client_match_batch')),
         '-infinity'
       ) ASC
       LIMIT 1`
    );
    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (err) {
    // client may be undefined if matchBatchPool.connect() itself is what failed
    await client?.query("ROLLBACK").catch(() => {});
    console.error("[match-drain] pickNextMatchDrainCandidate failed:", err);
    return null; // safe: this hop finds nothing this time, next hop tries fresh
  } finally {
    client?.release();
  }
}

export async function runMatchDrainHop(hop = 0): Promise<void> {
  if (hop >= MAX_DRAIN_HOPS) {
    console.warn(`[match-drain] Hop limit (${MAX_DRAIN_HOPS}) reached — stopping; tomorrow's cron picks up where this left off`);
    logSyncEvent(ADMIN_USER_ID, "match_drain_hop", { hop, outcome: "hop_limit_reached" });
    return;
  }

  // Logged for EVERY hop, not just hop 0 (2026-08-27, same reasoning as
  // description-chain.ts's dispatchNextHop) — a hop that dies before its
  // own cron_match_sweep row lands previously left zero trace beyond hop 0.
  logSyncEvent(ADMIN_USER_ID, "match_drain_hop", { hop, outcome: "started" });

  const candidate = await pickNextMatchDrainCandidate();
  if (!candidate) {
    console.log(`[match-drain] Nothing left to drain — stopping after ${hop} hop(s)`);
    logSyncEvent(ADMIN_USER_ID, "match_drain_hop", { hop, outcome: "nothing_to_drain" });
    return;
  }

  let result;
  try {
    // matchBatchPool, not the shared `pool` — this sweep runs unattended
    // across every user in the account and can take hundreds of hops. Root
    // cause this exists to fix (2026-08-22): running on the shared pool,
    // this drain and the description drain competed with the Strava webhook
    // for the same handful of Supabase pooler slots, and a live user's
    // real-time activity sync silently lost the race (webhook/strava's
    // handleNewActivity failed with an unlogged connection error — see the
    // fix there). Its own dedicated pool (split from a single shared
    // batchPool on 2026-09-02, see db.ts) means neither this nor the
    // description drain can starve each other, on top of never crowding out
    // latency-sensitive requests.
    result = await matchNextBatch(candidate.id, DRAIN_HOP_BATCH_SIZE, DRAIN_HOP_TIME_BUDGET_MS, matchBatchPool);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[match-drain] Batch failed for ${candidate.first_name ?? candidate.id} at hop ${hop}:`, err);
    logSyncEvent(ADMIN_USER_ID, "match_drain_hop", { hop, outcome: "hard_failure", candidateId: candidate.id, message });
    return; // don't chain past a hard failure — tomorrow's cron retries cleanly
  }

  // Logged (not just console) for two reasons: visibility, and — the part
  // that actually matters for correctness — pickNextMatchDrainCandidate's
  // own ORDER BY reads this same event back out to decide who's least
  // recently swept. Without it every hop would re-pick the same candidate
  // forever, since nothing would ever update their place in the rotation.
  logSyncEvent(candidate.id, "cron_match_sweep", {
    triggeredBy: "match-drain",
    checkedThisBatch: result.checkedThisBatch,
    matchedThisBatch: result.matchedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
  });
  console.log(
    `[match-drain] hop ${hop} — ${candidate.first_name ?? candidate.id}: checked ${result.checkedThisBatch}, matched ${result.matchedThisBatch}, totalChecked ${result.totalChecked}/${result.totalTrails}`
  );

  // Back off before the next hop if this one hit real failures — a signal
  // the pool is under pressure (matchBatchPool's own small `max` filling up, or
  // Supabase's pooler itself near its session cap) rather than one-off bad
  // luck on a single trail. Pausing here gives that pressure a chance to
  // clear instead of the drain immediately dispatching another hop and
  // compounding it.
  // Kept short (not, say, 15s) deliberately — this sleep eats into the same
  // 60s Vercel function ceiling as everything else in this hop, on top of
  // DRAIN_HOP_TIME_BUDGET_MS's own 45s. Long enough to matter, short enough
  // that it can't push a hop past its own function timeout and lose the
  // chain until the next cron day.
  if (result.hadFailures) {
    console.warn(`[match-drain] Hop ${hop} hit failures — backing off before the next hop`);
    await sleep(5_000);
  }

  if (!MATCH_DRAIN_CHAINING_ENABLED) {
    // See MATCH_DRAIN_CHAINING_ENABLED's comment above — one short batch per
    // cron run, then stop, rather than self-dispatching to the next hop.
    logSyncEvent(ADMIN_USER_ID, "match_drain_hop", { hop, outcome: "chaining_disabled" });
    return;
  }

  // Whether or not this candidate's OWN backlog just finished, there may be
  // more — theirs or someone else's — so always re-pick fresh on the next
  // hop rather than committing to draining one user to completion first.
  const dispatched = await dispatchNextHop("/api/internal/continue-match-drain", { hop: hop + 1 });
  logSyncEvent(ADMIN_USER_ID, "match_drain_hop", {
    hop,
    outcome: dispatched ? "dispatched_next" : "dispatch_failed",
  });
}

/** Starts a fresh daily drain (hop 0) — called once from the cron route. */
export function triggerMatchDrain(): Promise<void> {
  return runMatchDrainHop(0);
}

// ── External-scheduler match drain (2026-09-07) ─────────────────────────────
//
// The daily cron (resume-stuck-syncs) only calls triggerMatchDrain once a
// day, and MATCH_DRAIN_CHAINING_ENABLED being false means that's a single
// bounded hop — one candidate, one small batch — then it stops. Meanwhile
// the REACTIVE chain (runMatchBatchAndChain) only ever fires off the back of
// a sync or a dashboard visit, so a user who doesn't do either (like Luke
// Davis sitting at 236/1,182 trails checked for two straight days, see the
// investigation this fixes) never gets any further progress at all between
// cron runs. The description backlog already solved exactly this shape of
// problem with runExternalDrainBatch, driven by an external scheduler
// (cron-job.org) hitting /api/internal/drain-batch every ~2 minutes — this
// is the same fix applied to matching: one bounded, non-self-dispatching
// batch per call, safe for an external scheduler to hit on a tight interval
// with no shared invocation lineage (so Vercel's loop-detection protection
// never enters into it, same reasoning as runExternalDrainBatch above).
//
// Deliberately reuses pickNextMatchDrainCandidate (least-recently-swept
// first, same round-robin fairness as the daily drain) and matchBatchPool
// (not the shared `pool`) — same reasoning as runMatchDrainHop throughout
// this file.
//
// Budget kept small (not EXTERNAL_DRAIN_BATCH_TIME_BUDGET_MS-sized) because
// this runs in the SAME external-scheduler call as the description drain —
// see drain-batch/route.ts, which calls both in one request. cron-job.org
// has a hard 30s request timeout independent of this route's own 60s
// maxDuration (see description-chain.ts's own comment on this).
//
// This is a NOMINAL budget only, same caveat as DRAIN_HOP_TIME_BUDGET_MS
// above — matchNextBatch checks it BETWEEN trails, not during one, and a
// single trail's own MATCH_SQL carries its own separate 3-minute
// statement_timeout (see computeTrailProgress in match-trails.ts). Confirmed
// directly while wiring this up: a combined call can legitimately run
// 30-40s wall-clock even with this budget at 6s, whenever either phase
// lands on a slow individual query (an OAuth token refresh in the
// description phase, or one costly trail in this one). That's an accepted,
// pre-existing characteristic of both drains, not something this budget can
// fully bound — cron-job.org logging an occasional timeout on a call that
// actually completed and checkpointed correctly server-side is the same
// tradeoff description-chain.ts's own comment already documents. Kept small
// anyway so the COMMON case (no slow query) stays comfortably under 30s.
const EXTERNAL_MATCH_DRAIN_TIME_BUDGET_MS = 6_000;

export interface ExternalMatchDrainResult {
  candidateId: string | null;
  checkedThisBatch: number;
  matchedThisBatch: number;
  done: boolean; // true only when pickNextMatchDrainCandidate found nobody left to drain
}

/**
 * Entry point for the external scheduler — one HTTP call in, one JSON
 * response out, no self-dispatch, exactly one candidate's worth of work
 * (unlike runExternalDrainBatch, which loops across multiple candidates —
 * matching's own per-trail cost is high enough, and the external cadence
 * frequent enough, that one candidate per call is plenty; see the comment
 * above pickNextMatchDrainCandidate for how slow a single candidate's own
 * discovery query can already be).
 */
export async function runExternalMatchDrainBatch(): Promise<ExternalMatchDrainResult> {
  const candidate = await pickNextMatchDrainCandidate();
  if (!candidate) {
    return { candidateId: null, checkedThisBatch: 0, matchedThisBatch: 0, done: true };
  }

  let result;
  try {
    result = await matchNextBatch(
      candidate.id,
      DRAIN_HOP_BATCH_SIZE,
      EXTERNAL_MATCH_DRAIN_TIME_BUDGET_MS,
      matchBatchPool
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-match-drain] Batch failed for ${candidate.first_name ?? candidate.id}:`, err);
    logSyncEvent(ADMIN_USER_ID, "external_match_drain_batch", {
      outcome: "hard_failure",
      candidateId: candidate.id,
      message,
    });
    return { candidateId: candidate.id, checkedThisBatch: 0, matchedThisBatch: 0, done: false };
  }

  // Same reasoning as runMatchDrainHop's own logSyncEvent call —
  // pickNextMatchDrainCandidate's ORDER BY reads this back out to decide who's
  // least recently swept, so skipping it would mean this candidate gets
  // re-picked forever instead of rotating to the next-neediest account.
  logSyncEvent(candidate.id, "cron_match_sweep", {
    triggeredBy: "external-match-drain",
    checkedThisBatch: result.checkedThisBatch,
    matchedThisBatch: result.matchedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
  });

  return {
    candidateId: candidate.id,
    checkedThisBatch: result.checkedThisBatch,
    matchedThisBatch: result.matchedThisBatch,
    done: false,
  };
}
