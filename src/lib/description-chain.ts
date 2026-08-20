import { processDescriptionBatch } from "@/lib/trail-descriptions";

const CHAIN_TIME_BUDGET_MS = 45_000;

// Budget-capped anyway (reserveBackfillSlot won't hand out more than
// DAILY_UPDATE_BUDGET slots across the whole app per day), so this is just a
// backstop against a chain that somehow never converges looping forever.
const MAX_CHAIN_HOPS = 40;

// Same "Vercel sets this automatically when CRON_SECRET is configured,
// falls back to unauthenticated (logged) otherwise" pattern as match-chain.ts
// and cron/resume-stuck-syncs — functional without it, more secure with it.
function chainAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/**
 * Runs one batch of the description-writing backlog for a user, then — if
 * there's more left and the daily budget isn't exhausted — hands off to a
 * fresh serverless invocation via /api/internal/continue-descriptions,
 * same "each hop only ever covers one batch, never the whole backlog"
 * trick as match-chain.ts.
 *
 * Root cause this exists to fix (2026-08-20): handleNewActivity's own
 * inline matching attempt is time-boxed to 20s and explicitly skips the
 * description write if matching hasn't landed by then — by design, on the
 * assumption something would come back and catch it up later. Nothing did;
 * the only thing that ever finished the job was a manual button nobody was
 * clicking, so activities with fully confirmed trail matches sat for days
 * with no description ever written. Triggered from wherever trail matching
 * actually completes (webhook, sync, the trail-matching background chain)
 * and swept daily by cron for anything those miss.
 */
export async function runDescriptionBatchAndChain(
  userId: string,
  origin: string,
  hop = 0,
  triggeredBy = "chain"
): Promise<void> {
  if (hop >= MAX_CHAIN_HOPS) {
    console.warn(
      `[description-chain] Hop limit (${MAX_CHAIN_HOPS}) reached for user ${userId} — stopping; the daily cron sweep will pick up whatever's left`
    );
    return;
  }

  let result;
  try {
    result = await processDescriptionBatch(userId, CHAIN_TIME_BUDGET_MS, triggeredBy);
  } catch (err) {
    console.error(`[description-chain] Batch failed for user ${userId} at hop ${hop}:`, err);
    return;
  }

  // done: nothing left to check right now. budgetExhausted: the app-wide
  // daily cap is spent — more opens up gradually tomorrow, not worth
  // chaining further today.
  if (result.done || result.budgetExhausted) {
    console.log(
      `[description-chain] Stopping for user ${userId} after ${hop + 1} hop(s) — done=${result.done} budgetExhausted=${result.budgetExhausted}`
    );
    return;
  }

  try {
    const res = await fetch(new URL("/api/internal/continue-descriptions", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chainAuthHeaders() },
      body: JSON.stringify({ userId, hop: hop + 1 }),
    });
    if (!res.ok) {
      console.error(`[description-chain] Next hop dispatch for user ${userId} returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[description-chain] Failed to dispatch next hop for user ${userId}:`, err);
  }
}

/** Starts a fresh chain (hop 0) — the entry point callers actually use. */
export function triggerDescriptionChain(
  userId: string,
  origin: string,
  triggeredBy: string
): Promise<void> {
  return runDescriptionBatchAndChain(userId, origin, 0, triggeredBy);
}
