import { pool, batchPool } from "@/lib/db";
import { processDescriptionBatch } from "@/lib/trail-descriptions";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Root cause this exists to fix (2026-08-27): the drain would run a
// handful of hops cleanly, then go silent for HOURS with no error and no
// budgetExhausted flag — remaining work sitting untouched until the next
// external trigger (cron, webhook, dashboard visit) restarted it from
// scratch. The dispatch fetch to hand off to the next hop was fire-and-
// forget: any transient failure (network blip, a slow cold start on the
// receiving function) just logged a console.error and the chain died,
// with nothing durable recording that it had even been attempted — so a
// "did it stop because the dispatch failed, or because the DISPATCHED hop
// itself died before logging anything" question was unanswerable after
// the fact. dispatchNextHop retries (transient blips shouldn't kill an
// otherwise-healthy chain) and its result is always logged by the caller,
// success or failure, so every hop boundary now leaves durable evidence.
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
// Bumped 45s -> 48s (2026-08-27): most observed hops actually end early
// because the candidate's own pending queue runs dry before the time
// budget does, not because the budget itself is the constraint — but for
// large-backlog accounts (Sophie: ~1,900 pending) every extra second here
// is directly more activities processed per hop. Left a 12s margin before
// Vercel's 60s ceiling for the dispatch attempt (see dispatchNextHop)
// rather than pushing closer — this chain still needs that headroom, even
// though the external-scheduler path below doesn't.
const DRAIN_HOP_TIME_BUDGET_MS = 48_000;

// Budget-capped in practice (750/day / ~10-20 activities per hop settles
// well under this in normal conditions), so this is mainly a backstop
// against a chain that somehow never converges. Raised 80 -> 400
// (2026-08-27): at a conservative ~5 activities/hop on a bad day, 750/day
// needs up to ~150 hops to actually reach budgetExhausted — 80 could cut
// a sustained drain off well before the real stopping condition, silently
// capping the day's progress far short of budget for no good reason.
const MAX_DRAIN_HOPS = 400;

// Temporary deprioritization, 2026-08-26: Paul Crowe's account has several
// spots he revisits constantly enough (hundreds of his own nearby
// activities clustered together) that even with the per-activity time caps
// above, his batches are slower and more failure-prone than everyone
// else's — and being one of the largest backlogs, the plain
// least-recently-drained ordering kept giving him an outsized share of
// turns anyway. Sorted last, not excluded: the ORDER BY below still picks
// him once no OTHER user has pending work, so this resolves itself
// automatically as everyone else catches up rather than needing to be
// manually reverted later. Remove once his backlog is confirmed draining
// smoothly on its own turns.
const TEMPORARILY_DEPRIORITIZED_USER_ID = "5116460b-94f7-476f-957c-8678b73778af"; // Paul Crowe

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
     ORDER BY
       (u.id = $1) ASC,
       COALESCE(
         (SELECT MAX(s.created_at) FROM sync_log s WHERE s.user_id = u.id AND s.event = 'description_batch'),
         '-infinity'
       ) ASC
     LIMIT 1`,
    [TEMPORARILY_DEPRIORITIZED_USER_ID]
  );
  return rows[0] ?? null;
}

export async function runBacklogDrainHop(hop = 0): Promise<void> {
  if (hop >= MAX_DRAIN_HOPS) {
    console.warn(`[description-drain] Hop limit (${MAX_DRAIN_HOPS}) reached — stopping; tomorrow's cron picks up where this left off`);
    logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "hop_limit_reached" });
    return;
  }

  // Logged for EVERY hop, not just hop 0 (2026-08-27 — see dispatchNextHop's
  // comment for why this changed): a hop that dies before completing its
  // batch previously left zero trace beyond hop 0, making "the dispatch
  // failed" indistinguishable from "the dispatched hop died silently" after
  // the fact. Cheap relative to everything else a hop does; sync_log isn't
  // a hot path.
  logSyncEvent(ADMIN_USER_ID, "description_drain_hop", { hop, outcome: "started" });

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
  const dispatched = await dispatchNextHop("/api/internal/continue-description-drain", { hop: hop + 1 });
  logSyncEvent(ADMIN_USER_ID, "description_drain_hop", {
    hop,
    outcome: dispatched ? "dispatched_next" : "dispatch_failed",
  });
}

/** Starts a fresh daily drain (hop 0) — called once from the cron route. */
export function triggerBacklogDrain(): Promise<void> {
  return runBacklogDrainHop(0);
}

// ── External-scheduler drain (no self-dispatch) ─────────────────────────────
//
// Root cause this exists to fix (2026-08-27): the self-dispatching chain
// above — each hop calling itself via HTTP to trigger the next one — hits
// Vercel's own anti-recursion protection after 4-5 hops: confirmed directly
// in production logs, `[chain-dispatch] ... returned HTTP 508` (Loop
// Detected) on every retry attempt, deterministically, every time. No
// amount of retrying or backoff gets past this — Vercel is refusing the
// request on purpose, not failing transiently. Bumping DRAIN_HOP_TIME_BUDGET_MS
// or MAX_DRAIN_HOPS above can't fix it either: the ceiling is on how many
// times a route may call itself in a lineage, not on time or hop count.
//
// The actual fix is architectural: stop self-dispatching. An external
// scheduler (cron-job.org or similar, hitting GET /api/internal/drain-batch
// on a fixed interval — see that route) sends independent HTTP requests
// with no shared invocation lineage, so loop detection never triggers.
// Each call runs this function once and returns — no fetch to itself
// anywhere in here — looping ACROSS MULTIPLE CANDIDATES in-process instead,
// for as long as this invocation's own time budget allows, which is more
// efficient per call than the chain ever was anyway (no dispatch overhead,
// no reserved margin for a next-hop fetch that doesn't exist here).
//
// Existing triggers (cron's triggerBacklogDrain, the webhook and dashboard
// backup triggers) are UNCHANGED and still run alongside this — they cover
// real-time descriptions for today's new activities; this covers bulk
// overnight draining via an external cadence instead of self-chaining.
const EXTERNAL_DRAIN_BATCH_TIME_BUDGET_MS = 50_000;

// Below this, don't bother starting another candidate — processDescriptionBatch's
// own loop already needs at least ACTIVITY_NEW_GROUND_BUDGET_MS-equivalent
// margin to attempt even one activity (see trail-descriptions.ts); less
// than that left in THIS call isn't worth the discovery-query overhead of
// picking a new candidate that could barely get started before returning.
const MIN_USEFUL_REMAINING_MS = 15_000;

export interface ExternalDrainBatchResult {
  candidatesProcessed: number;
  totalChecked: number;
  totalUpdated: number;
  done: boolean;
  budgetExhausted: boolean;
  tookMs: number;
}

/**
 * Entry point for the external scheduler — one HTTP call in, one JSON
 * response out, no self-dispatch. Loops across as many candidates as fit
 * in EXTERNAL_DRAIN_BATCH_TIME_BUDGET_MS, re-picking fresh each time (same
 * round-robin fairness as the chain — a candidate whose backlog outlasts
 * this call just gets picked again, less recently drained, next call).
 */
export async function runExternalDrainBatch(): Promise<ExternalDrainBatchResult> {
  const startedAt = Date.now();
  let candidatesProcessed = 0;
  let totalChecked = 0;
  let totalUpdated = 0;
  let budgetExhausted = false;
  let done = false;

  for (;;) {
    const remaining = EXTERNAL_DRAIN_BATCH_TIME_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < MIN_USEFUL_REMAINING_MS) break;

    const candidate = await pickNextDrainCandidate();
    if (!candidate) {
      done = true;
      break;
    }

    let result;
    try {
      result = await processDescriptionBatch(candidate.id, remaining, "external-drain", batchPool);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[external-drain] Batch failed for ${candidate.first_name ?? candidate.id}:`, err);
      logSyncEvent(ADMIN_USER_ID, "external_drain_batch", {
        outcome: "hard_failure",
        candidateId: candidate.id,
        message,
        candidatesProcessed,
      });
      break; // stop this call cleanly — the next external trigger retries fresh
    }

    candidatesProcessed++;
    totalChecked += result.checkedThisBatch;
    totalUpdated += result.updatedThisBatch;
    console.log(
      `[external-drain] ${candidate.first_name ?? candidate.id}: checked ${result.checkedThisBatch}, updated ${result.updatedThisBatch}`
    );

    if (result.budgetExhausted) {
      budgetExhausted = true;
      break;
    }
  }

  const summary: ExternalDrainBatchResult = {
    candidatesProcessed,
    totalChecked,
    totalUpdated,
    done,
    budgetExhausted,
    tookMs: Date.now() - startedAt,
  };
  logSyncEvent(ADMIN_USER_ID, "external_drain_batch", { outcome: "completed", ...summary });
  return summary;
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
