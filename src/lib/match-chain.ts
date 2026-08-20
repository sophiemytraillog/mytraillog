import { matchNextBatch } from "@/lib/match-trails";

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
  origin: string,
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
    const res = await fetch(new URL("/api/internal/continue-matching", origin), {
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
export function triggerMatchChain(userId: string, origin: string): Promise<void> {
  return runMatchBatchAndChain(userId, origin, 0);
}
