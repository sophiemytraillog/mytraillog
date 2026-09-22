import { pool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { triggerMatchChain } from "@/lib/match-chain";
import { triggerDescriptionChain } from "@/lib/description-chain";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Matches runSyncChunk's own DEFAULT_BUDGET_MS (sync-engine.ts) — 15s margin
// under Vercel's 60s maxDuration for the final DB write and dispatch to the
// next hop.
const CHAIN_TIME_BUDGET_MS = 45_000;

// Root cause this exists to fix (2026-09-22): syncing a large activity
// history required the BROWSER to stay open and keep reopening an
// EventSource per chunk (see the old SyncButton auto-continue loop) — close
// the tab mid-sync and nothing moved again until the next dashboard visit's
// 60s self-heal nudge. This chain lets the server keep fetching chunks on
// its own after the first browser-driven one, same reactive self-dispatch
// pattern as match-chain.ts's runMatchBatchAndChain.
//
// IMPORTANT — this alone is not sufficient for every account, by this
// codebase's own prior experience with the exact same pattern:
//   1. Self-dispatch (a hop calling itself via HTTP to trigger the next one)
//      hits Vercel's own loop-detection protection (HTTP 508) after 4-5
//      hops, deterministically — confirmed for description-chain.ts's
//      identical pattern, root-caused 2026-08-27. No amount of retrying or
//      backoff gets past it; it's intentional platform behavior, not a
//      transient failure.
//   2. A self-dispatch chain run unattended across many accounts can also
//      exhaust Supabase's pooler connection ceiling — confirmed for
//      match-chain.ts's equivalent drain, which had to be DISABLED
//      (MATCH_DRAIN_CHAINING_ENABLED = false) after three rounds of fixes
//      still couldn't stop it.
// A large sync (hundreds+ of activities, many chunks) is exactly the case
// most likely to run past a handful of hops, which is exactly the case this
// whole feature exists to fix — so this reactive chain is deliberately NOT
// the only mechanism. runExternalSyncResumeBatch below (wired into
// drain-batch/route.ts, same external cadence already proven for
// descriptions and matching) is the real backstop: it needs no chain at all,
// just picks up whichever stale sync has gone quiet longest and advances it
// one more bounded step, call after call, with no shared invocation lineage
// to trip the loop detector.
const MAX_CHAIN_HOPS = 15;

// Same "Vercel sets this automatically when CRON_SECRET is configured,
// falls back to unauthenticated (logged) otherwise" pattern as
// match-chain.ts and cron/resume-stuck-syncs.
function chainAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

// Same hardening as description-chain.ts/match-chain.ts's dispatchNextHop —
// retries a transient dispatch failure instead of letting it silently end
// the chain.
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
 * Runs one sync chunk for a user, then — if there's more to fetch — hands
 * off to a fresh serverless invocation via /api/internal/continue-sync
 * instead of looping in-process, same trick as match-chain.ts's
 * runMatchBatchAndChain for outrunning Vercel's 60s per-invocation cap.
 *
 * Callers run this inside waitUntil() (see /api/sync/activities's "partial"
 * branch) so it keeps working after the browser's own connection has
 * already moved on — closing the tab after the first chunk no longer stops
 * the rest of the sync.
 *
 * Matching/description-writing is only triggered on "complete", not on
 * every intermediate "partial" hop — same as the SSE route's own existing
 * behavior: finishSync (called every hop, partial or complete) already
 * covers the trails nearby THIS hop's activities inline, and firing the
 * wider match/description chains once per hop as well would just be
 * redundant overlapping work for no benefit.
 */
export async function runSyncChunkAndChain(userId: string, hop = 0): Promise<void> {
  if (hop >= MAX_CHAIN_HOPS) {
    console.warn(
      `[sync-chain] Hop limit (${MAX_CHAIN_HOPS}) reached for user ${userId} — stopping; runExternalSyncResumeBatch (drain-batch) will pick up the rest`
    );
    return;
  }

  let result;
  try {
    result = await runSyncChunk(userId, { budgetMs: CHAIN_TIME_BUDGET_MS });
  } catch (err) {
    console.error(`[sync-chain] Chunk failed for user ${userId} at hop ${hop}:`, err);
    return;
  }

  if (result.status === "rate_limited" || result.status === "error" || result.status === "subscription_required") {
    console.warn(`[sync-chain] Stopping for user ${userId} at hop ${hop}: ${result.status}`);
    return;
  }

  if (result.newDbIds.length > 0) {
    await finishSync(userId, result.newDbIds).catch((err) => {
      console.error(`[sync-chain] finishSync failed for user ${userId} at hop ${hop}:`, err);
    });
  }

  if (result.status === "complete") {
    console.log(`[sync-chain] Complete for user ${userId} after ${hop + 1} hop(s)`);
    // Catch up the wider match/description backlog, same as the SSE route's
    // own "complete" branch — finishSync above only covered trails near
    // this hop's own activities (MAX_TRAILS_PER_FINISH_SYNC cap).
    await Promise.all([
      triggerMatchChain(userId),
      triggerDescriptionChain(userId, "sync"),
    ]).catch((err) => {
      console.error(`[sync-chain] Post-complete match/description trigger failed for user ${userId}:`, err);
    });
    return;
  }

  // status === "partial" — more to fetch, dispatch the next hop.
  const dispatched = await dispatchNextHop("/api/internal/continue-sync", { userId, hop: hop + 1 });
  if (!dispatched) {
    console.error(`[sync-chain] Failed to dispatch next hop for user ${userId} — runExternalSyncResumeBatch will pick this up instead`);
  }
}

/** Starts a fresh chain (hop 0) — the entry point callers actually use. */
export function triggerSyncChain(userId: string): Promise<void> {
  return runSyncChunkAndChain(userId, 0);
}

// ── External-scheduler sync resume (2026-09-22) ─────────────────────────────
//
// The real backstop, not the reactive chain above — see MAX_CHAIN_HOPS's
// comment for why. Same shape as match-chain.ts's runExternalMatchDrainBatch:
// one HTTP call in, one bounded batch of work, no self-dispatch, safe for an
// external scheduler to hit on a tight interval with no shared invocation
// lineage (so Vercel's loop-detection protection never enters into it).
// Picks up whichever stale sync has gone longest without progress and
// advances it exactly one runSyncChunk call, regardless of how the previous
// attempt stalled — reactive chain hit its hop cap, a dispatch failed, the
// user closed the tab before the reactive chain even got triggered, a deploy
// restarted mid-chain, anything. Wired into drain-batch/route.ts alongside
// the existing description/matching phases so it runs on that same ~2-minute
// external cadence rather than needing a separate scheduler set up.
const EXTERNAL_SYNC_RESUME_TIME_BUDGET_MS = 10_000;

// Higher than the dashboard's own 60s self-heal threshold (dashboard/page.tsx)
// — that one fires on a page load a human is actually looking at, so it can
// afford to be eager; this runs unattended and re-picks the same candidate
// repeatedly if it's still genuinely mid-chunk, so a slightly longer
// threshold avoids racing an in-flight reactive-chain hop that just hasn't
// reached its next heartbeat yet.
const EXTERNAL_SYNC_RESUME_STALE_SECONDS = 90;

async function pickNextStaleSyncCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  const { rows } = await pool.query<{ id: string; first_name: string | null }>(
    `SELECT id, first_name FROM users
     WHERE sync_status = 'syncing'
       AND sync_progress_at < NOW() - INTERVAL '${EXTERNAL_SYNC_RESUME_STALE_SECONDS} seconds'
       -- Basic-feature gate (2026-09-30 convention, see match-chain.ts and
       -- description-chain.ts's own candidate queries) — kept in sync
       -- manually since this runs as raw SQL rather than importing
       -- subscription.ts's hasBasicAccess.
       AND subscription_status IN ('trial', 'active')
     ORDER BY sync_progress_at ASC
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export interface ExternalSyncResumeResult {
  candidateId: string | null;
  status?: string;
  timedOut: boolean;
}

/**
 * Entry point for the external scheduler — advances exactly one stale sync
 * by one runSyncChunk call. `timeBudgetMs` is the REAL hard ceiling,
 * enforced via Promise.race — runSyncChunk's own budgetMs is only checked
 * BETWEEN Strava API pages, not a true limit (same gap that caused
 * match-chain.ts's runExternalMatchDrainBatch to need this exact same
 * hardening, 2026-09-08 — see that function's comment for the production
 * 504/orphaned-query incident this pattern prevents). Racing doesn't cancel
 * the underlying runSyncChunk call — it keeps running server-side and its
 * result, if any, still lands — it just stops THIS function waiting for it.
 */
export async function runExternalSyncResumeBatch(
  timeBudgetMs: number = EXTERNAL_SYNC_RESUME_TIME_BUDGET_MS
): Promise<ExternalSyncResumeResult> {
  const candidate = await pickNextStaleSyncCandidate();
  if (!candidate) {
    return { candidateId: null, timedOut: false };
  }

  const syncPromise = runSyncChunk(candidate.id, { budgetMs: timeBudgetMs })
    .then((result) => ({ timedOut: false as const, result }))
    .catch((err) => ({ timedOut: false as const, error: err as unknown }));

  const outcome = await Promise.race([
    syncPromise,
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), timeBudgetMs)),
  ]);

  if (outcome.timedOut) {
    console.warn(`[external-sync-resume] Timed out after ${timeBudgetMs}ms for ${candidate.first_name ?? candidate.id} — still running in the background`);
    logSyncEvent(ADMIN_USER_ID, "external_sync_resume", {
      outcome: "timed_out",
      candidateId: candidate.id,
      timeBudgetMs,
    });
    // heartbeat (sync_progress_at) is updated by runSyncChunk itself after
    // each Strava page it saves — no need to touch it here. If the
    // underlying call genuinely made progress before this race lost, the
    // NEXT external call will naturally see a fresher sync_progress_at and
    // pick someone else, same round-robin effect as match-chain.ts's
    // equivalent timeout branch.
    return { candidateId: candidate.id, timedOut: true };
  }

  if ("error" in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    console.error(`[external-sync-resume] Chunk failed for ${candidate.first_name ?? candidate.id}:`, outcome.error);
    logSyncEvent(ADMIN_USER_ID, "external_sync_resume", { outcome: "hard_failure", candidateId: candidate.id, message });
    return { candidateId: candidate.id, status: "error", timedOut: false };
  }

  const { result } = outcome;
  if (result.status === "rate_limited" || result.status === "error" || result.status === "subscription_required") {
    logSyncEvent(ADMIN_USER_ID, "external_sync_resume", { outcome: result.status, candidateId: candidate.id });
    return { candidateId: candidate.id, status: result.status, timedOut: false };
  }

  if (result.newDbIds.length > 0) {
    await finishSync(candidate.id, result.newDbIds).catch((err) => {
      console.error(`[external-sync-resume] finishSync failed for ${candidate.first_name ?? candidate.id}:`, err);
    });
  }

  if (result.status === "complete") {
    await Promise.all([
      triggerMatchChain(candidate.id),
      triggerDescriptionChain(candidate.id, "sync"),
    ]).catch((err) => {
      console.error(`[external-sync-resume] Post-complete match/description trigger failed for ${candidate.first_name ?? candidate.id}:`, err);
    });
  }

  logSyncEvent(ADMIN_USER_ID, "external_sync_resume", {
    outcome: "completed",
    candidateId: candidate.id,
    status: result.status,
    fetched: result.fetched,
    saved: result.saved,
  });
  return { candidateId: candidate.id, status: result.status, timedOut: false };
}
