import { pool, batchPool } from "@/lib/db";
import { processDescriptionBatch } from "@/lib/trail-descriptions";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    const res = await fetch(new URL("/api/internal/continue-descriptions", CHAIN_DISPATCH_ORIGIN), {
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
  triggeredBy: string
): Promise<void> {
  return runDescriptionBatchAndChain(userId, 0, triggeredBy);
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

export async function runBacklogDrainHop(hop = 0): Promise<void> {
  if (hop >= MAX_DRAIN_HOPS) {
    console.warn(`[description-drain] Hop limit (${MAX_DRAIN_HOPS}) reached — stopping; tomorrow's cron picks up where this left off`);
    logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "hop_limit_reached" });
    return;
  }

  // Root cause this exists to fix (2026-08-25): before this, the ONLY
  // durable trace of a drain hop running was per-candidate sync_log rows
  // written further down — meaning a hop that found nothing to drain (or
  // never got invoked at all, e.g. the cron itself silently not firing)
  // left zero evidence either way. This distinguishes "ran, found nothing"
  // (this event exists) from "never ran" (it doesn't) — the latter can
  // only be inferred by its absence, since a function that's never invoked
  // can't log anything about itself, but at least the FIRST hop of a
  // working chain now always leaves a trace even on an empty day.
  if (hop === 0) {
    logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "started" });
  }

  const candidate = await pickNextDrainCandidate();
  if (!candidate) {
    console.log(`[description-drain] Nothing left to drain — stopping after ${hop} hop(s)`);
    logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "nothing_to_drain" });
    return;
  }

  let result;
  try {
    // batchPool, not the shared `pool` — same fix as match-chain.ts's
    // runMatchDrainHop, and for the same reason: this sweep runs unattended
    // across every user with pending backlog and previously competed with
    // the Strava webhook for the same limited Supabase pooler slots. See the
    // comment there for the full root-cause writeup (2026-08-22).
    result = await processDescriptionBatch(candidate.id, DRAIN_HOP_TIME_BUDGET_MS, "cron-drain", batchPool);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[description-drain] Batch failed for ${candidate.first_name ?? candidate.id} at hop ${hop}:`, err);
    logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "hard_failure", candidateId: candidate.id, message });
    return; // don't chain past a hard failure — tomorrow's cron retries cleanly
  }

  console.log(
    `[description-drain] hop ${hop} — ${candidate.first_name ?? candidate.id}: checked ${result.checkedThisBatch}, updated ${result.updatedThisBatch}, budgetExhausted=${result.budgetExhausted}`
  );

  if (result.budgetExhausted) {
    console.log(`[description-drain] Daily budget spent after ${hop + 1} hop(s) — stopping for today`);
    return;
  }

  // Kept short deliberately — eats into the same 60s Vercel function ceiling
  // as everything else in this hop, on top of DRAIN_HOP_TIME_BUDGET_MS's own
  // 45s. See match-chain.ts's runMatchDrainHop for the matching backoff.
  if (result.hadErrors) {
    console.warn(`[description-drain] Hop ${hop} hit errors — backing off before the next hop`);
    await sleep(5_000);
  }

  // Whether or not this candidate's OWN backlog just finished, there may be
  // more — theirs or someone else's — so always re-pick fresh on the next
  // hop rather than committing to draining one user to completion first.
  try {
    const res = await fetch(new URL("/api/internal/continue-description-drain", CHAIN_DISPATCH_ORIGIN), {
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
export function triggerBacklogDrain(): Promise<void> {
  return runBacklogDrainHop(0);
}

// ── Dashboard-visit backup trigger ──────────────────────────────────────────
//
// Root cause this exists to fix (2026-08-24): the cron sweep above is the
// ONLY thing that's supposed to proactively drain accounts nobody happens
// to be actively syncing/webhooking right now — but Vercel Cron on the
// Hobby plan isn't reliable enough to depend on alone. Confirmed in
// practice: Luke Barton-Davis and Paul Crowe went untouched for 4+ days
// despite sitting at the front of the least-recently-drained queue the
// whole time, while daily Strava API usage sat at 3-195 calls against a
// 1,500 budget — the drain just wasn't firing most days (see
// chain-origin.ts for the specific bug this turned out to be). Rather than
// trust the cron alone, every dashboard visit now doubles as a chance to
// notice "nothing has run yet today" and kick the drain off itself.
async function hasDrainRunToday(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM backfill_api_usage WHERE usage_date = CURRENT_DATE LIMIT 1`
  );
  return rows.length > 0;
}

/**
 * Call from any authenticated page load (wrapped in waitUntil() by the
 * caller — this never blocks rendering). Cheap on the common path: one
 * indexed SELECT, no-op once today's backfill_api_usage row already
 * exists from the cron (or an earlier visitor) having run. Only actually
 * kicks off a drain hop on whichever visit happens to be first to notice
 * the day hasn't started yet.
 */
export async function triggerDrainIfNotRunToday(): Promise<void> {
  try {
    if (await hasDrainRunToday()) return;
    console.log("[description-drain] No backfill activity recorded yet today — triggering backup drain from a dashboard visit");
    await triggerBacklogDrain();
  } catch (err) {
    console.error("[description-drain] triggerDrainIfNotRunToday failed:", err);
  }
}
