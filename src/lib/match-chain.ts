import { pool, batchPool } from "@/lib/db";
import { matchNextBatch } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";

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
    result = await matchNextBatch(userId, CHAIN_BATCH_SIZE, CHAIN_TIME_BUDGET_MS);
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
// that rate a user needing 1,100+ trails would take over a month. This is
// the proactive equivalent of description-chain.ts's backlog drain: cycles
// through EVERY user with incomplete matching, not a capped handful, hop
// after hop, until nothing's left.
const DRAIN_HOP_BATCH_SIZE = 200;
const DRAIN_HOP_TIME_BUDGET_MS = 45_000;

// No daily budget cap here unlike the description drain — trail matching
// doesn't spend a scarce external quota (Strava's rate limit), just DB/CPU
// time, so there's no equivalent of reserveBackfillSlot to respect. Bounded
// instead by a generous hop count purely as a backstop against a chain that
// somehow never converges.
const MAX_DRAIN_HOPS = 300;

// Least-recently-swept user first (own cron_match_sweep/client_match_batch
// sync_log events as the clock, NULLS FIRST so a user who's never had one
// goes first) — same round-robin-by-history trick as
// description-chain.ts's pickNextDrainCandidate, so one very-behind account
// doesn't hold up everyone else's turn.
async function pickNextMatchDrainCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  const { rows } = await pool.query<{ id: string; first_name: string | null }>(
    `SELECT u.id, u.first_name
     FROM users u
     WHERE EXISTS (
       SELECT 1 FROM trails t
       WHERE NOT EXISTS (
         SELECT 1 FROM trail_match_checks c WHERE c.user_id = u.id AND c.trail_id = t.id
       )
     )
     ORDER BY COALESCE(
       (SELECT MAX(s.created_at) FROM sync_log s
        WHERE s.user_id = u.id AND s.event IN ('cron_match_sweep', 'client_match_batch')),
       '-infinity'
     ) ASC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function runMatchDrainHop(hop = 0): Promise<void> {
  if (hop >= MAX_DRAIN_HOPS) {
    console.warn(`[match-drain] Hop limit (${MAX_DRAIN_HOPS}) reached — stopping; tomorrow's cron picks up where this left off`);
    return;
  }

  const candidate = await pickNextMatchDrainCandidate();
  if (!candidate) {
    console.log(`[match-drain] Nothing left to drain — stopping after ${hop} hop(s)`);
    return;
  }

  let result;
  try {
    // batchPool, not the shared `pool` — this sweep runs unattended across
    // every user in the account and can take hundreds of hops. Root cause
    // this exists to fix (2026-08-22): running on the shared pool, this drain
    // and the description drain below competed with the Strava webhook for
    // the same handful of Supabase pooler slots, and a live user's real-time
    // activity sync silently lost the race (webhook/strava's handleNewActivity
    // failed with an unlogged connection error — see the fix there). batchPool
    // has its own small `max` specifically so this can never crowd out
    // latency-sensitive requests.
    result = await matchNextBatch(candidate.id, DRAIN_HOP_BATCH_SIZE, DRAIN_HOP_TIME_BUDGET_MS, batchPool);
  } catch (err) {
    console.error(`[match-drain] Batch failed for ${candidate.first_name ?? candidate.id} at hop ${hop}:`, err);
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
  // the pool is under pressure (batchPool's own small `max` filling up, or
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

  // Whether or not this candidate's OWN backlog just finished, there may be
  // more — theirs or someone else's — so always re-pick fresh on the next
  // hop rather than committing to draining one user to completion first.
  try {
    const res = await fetch(new URL("/api/internal/continue-match-drain", CHAIN_DISPATCH_ORIGIN), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chainAuthHeaders() },
      body: JSON.stringify({ hop: hop + 1 }),
    });
    if (!res.ok) {
      console.error(`[match-drain] Next hop dispatch returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[match-drain] Failed to dispatch next hop:`, err);
  }
}

/** Starts a fresh daily drain (hop 0) — called once from the cron route. */
export function triggerMatchDrain(): Promise<void> {
  return runMatchDrainHop(0);
}
