import { pool } from "@/lib/db";
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

// ── Daily backlog drain (cron-triggered) ────────────────────────────────────
//
// runDescriptionBatchAndChain above is scoped to one user and triggered
// reactively (a webhook/sync just happened for THEM) — it isn't what
// proactively works through the wider backlog. This is: one daily kickoff
// from cron/resume-stuck-syncs, chaining hop after hop across every user
// with pending backlog — not just a handful within one bounded invocation —
// until reserveBackfillSlot reports the day's 250 spent, so the backlog
// keeps draining all day without needing anyone to sync, get a webhook
// event, or click the manual button.
const DRAIN_HOP_TIME_BUDGET_MS = 45_000;

// Budget-capped in practice (250/day / ~6-10 activities per hop settles
// well under this), so this is just a backstop against a hop that somehow
// keeps reporting "more to do" without ever exhausting the budget or
// running out of users.
const MAX_DRAIN_HOPS = 80;

// Least-recently-drained user first (own description_batch events as the
// clock, NULLS FIRST so a user who's never had one goes first) — each hop
// only gives one user their turn, so this naturally round-robins across
// everyone with pending backlog instead of one large account (Sophie:
// ~1,950 pending) holding the whole day's budget hostage before anyone
// else gets a single write.
async function pickNextDrainCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  const { rows } = await pool.query<{ id: string; first_name: string | null }>(
    `SELECT u.id, u.first_name
     FROM users u
     WHERE u.strava_description_updates = TRUE
       AND EXISTS (
         SELECT 1 FROM activities a
         JOIN activity_trail_matches atm ON atm.activity_id = a.id
         WHERE a.user_id = u.id AND a.strava_description_updated = FALSE
       )
     ORDER BY COALESCE(
       (SELECT MAX(s.created_at) FROM sync_log s WHERE s.user_id = u.id AND s.event = 'description_batch'),
       '-infinity'
     ) ASC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function runBacklogDrainHop(origin: string, hop = 0): Promise<void> {
  if (hop >= MAX_DRAIN_HOPS) {
    console.warn(`[description-drain] Hop limit (${MAX_DRAIN_HOPS}) reached — stopping; tomorrow's cron picks up where this left off`);
    return;
  }

  const candidate = await pickNextDrainCandidate();
  if (!candidate) {
    console.log(`[description-drain] Nothing left to drain — stopping after ${hop} hop(s)`);
    return;
  }

  let result;
  try {
    result = await processDescriptionBatch(candidate.id, DRAIN_HOP_TIME_BUDGET_MS, "cron-drain");
  } catch (err) {
    console.error(`[description-drain] Batch failed for ${candidate.first_name ?? candidate.id} at hop ${hop}:`, err);
    return; // don't chain past a hard failure — tomorrow's cron retries cleanly
  }

  console.log(
    `[description-drain] hop ${hop} — ${candidate.first_name ?? candidate.id}: checked ${result.checkedThisBatch}, updated ${result.updatedThisBatch}, budgetExhausted=${result.budgetExhausted}`
  );

  if (result.budgetExhausted) {
    console.log(`[description-drain] Daily budget spent after ${hop + 1} hop(s) — stopping for today`);
    return;
  }

  // Whether or not this candidate's OWN backlog just finished, there may be
  // more — theirs or someone else's — so always re-pick fresh on the next
  // hop rather than committing to draining one user to completion first.
  try {
    const res = await fetch(new URL("/api/internal/continue-description-drain", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...chainAuthHeaders() },
      body: JSON.stringify({ hop: hop + 1 }),
    });
    if (!res.ok) {
      console.error(`[description-drain] Next hop dispatch returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[description-drain] Failed to dispatch next hop:`, err);
  }
}

/** Starts a fresh daily drain (hop 0) — called once from the cron route. */
export function triggerBacklogDrain(origin: string): Promise<void> {
  return runBacklogDrainHop(origin, 0);
}
