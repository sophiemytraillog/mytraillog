// runSyncChunk and finishSync deliberately use TWO DIFFERENT dedicated pools
// here, not one shared between them:
//   - syncBatchPool for runSyncChunk — the critical path that actually makes
//     sync progress. Its own queries are all fast (simple SELECT/INSERT/
//     UPDATE), so a small dedicated pool suits it well.
//   - matchBatchPool for finishSync — confirmed necessary in production,
//     2026-09-22: giving BOTH functions the same dedicated pool (the first
//     version of this fix) was an improvement but not sufficient. finishSync
//     calls computeTrailProgress, which can legitimately run for minutes on
//     an active account (confirmed elsewhere in this codebase: Glen 127s/5
//     trails, David 283s/7 trails) — and since the chain dispatches the NEXT
//     hop immediately (see the doc comment on runSyncChunkAndChain), that
//     next hop's OWN runSyncChunk call needs a connection back from the same
//     pool within seconds, not minutes. FINISH_SYNC_RACE_BUDGET_MS stops
//     THIS hop waiting on a slow finishSync, but the abandoned work keeps
//     running server-side and keeps its connection checked out for as long
//     as it takes — on a pool shared with runSyncChunk, that starved the
//     very next hop out, reproducing "timeout exceeded when trying to
//     connect" even after the dedicated-pool fix, confirmed directly in
//     Vercel's logs. Routing finishSync's matching work onto matchBatchPool
//     instead — the pool already dedicated to exactly this kind of work,
//     and already proven under the external match-drain's own sustained
//     load — means a lingering finishSync call can never block the sync
//     chain's own forward progress again, no matter how long it runs.
import { syncBatchPool, matchBatchPool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { triggerMatchChain } from "@/lib/match-chain";
import { triggerDescriptionChain } from "@/lib/description-chain";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Deliberately smaller than runSyncChunk's own DEFAULT_BUDGET_MS (45s) —
// this hop still has finishSync's inline trail matching to do afterward
// (up to MAX_TRAILS_PER_FINISH_SYNC nearby trails, sync-engine.ts), which
// has no budget of its own. Root-caused in production, 2026-09-22, testing
// Luke Davis's reconnect: a hop combining a 45s chunk fetch with finishSync
// (84 nearby trails that hop) hit Vercel's actual runtime ceiling —
// "Task timed out after 60 seconds" in the function logs — which kills the
// ENTIRE waitUntil()'d invocation, including whatever hadn't run yet. Since
// dispatching the next hop happens AFTER finishSync, that kill silently
// broke the chain with no next hop ever dispatched — confirmed by a 39-
// minute gap in sync_log before the external-scheduler backstop (the whole
// reason that exists — see MAX_CHAIN_HOPS below) eventually noticed and
// resumed it.
//
// Lowered further, 15s (from 25s), the SAME day: dispatching the next hop
// now happens BEFORE finishSync (see the doc comment on
// runSyncChunkAndChain), so finishSync no longer needs to be starved to
// protect the chain's own continuation — that's already safe regardless of
// how long finishSync takes. What it DOES still need to fit inside is
// Vercel's 60s per-invocation ceiling, alongside FINISH_SYNC_RACE_BUDGET_MS
// below: 15s (sync) + dispatch's own worst case (~10.5s, two 5s attempts
// plus a retry delay) + FINISH_SYNC_RACE_BUDGET_MS's 30s leaves ~4.5s
// margin under 60s.
const CHAIN_TIME_BUDGET_MS = 15_000;

// See CHAIN_TIME_BUDGET_MS's comment. finishSync's inline computeTrailProgress
// calls have no time budget of their own (each trail gets its own 3-minute
// statement_timeout — see match-trails.ts) and can legitimately run long, the
// same gap that made runExternalMatchDrainBatch need this exact same
// Promise.race hardening (2026-09-08 — see that function's comment for the
// production 504/orphaned-query incident it fixes). Racing doesn't cancel
// finishSync — the underlying computeTrailProgress calls keep running
// server-side and still land in the DB — it just stops THIS hop waiting on
// them, so a slow trail can't take the whole chain down with it. Any trail
// finishSync doesn't get to in time isn't lost: the external match-drain
// backstop (match-chain.ts) picks up whatever's still unmatched.
//
// Raised 10s -> 30s, 2026-09-22, hours after the value above first shipped:
// testing Luke Davis's account (5 National Trails among his candidates,
// including South West Coast Path — documented elsewhere in this codebase,
// see match-trails.ts, as one of the slowest trails to compute) confirmed
// 10s was never enough to get through even ONE trail in
// MAX_TRAILS_PER_FINISH_SYNC's up-to-40-trail batch, let alone checkpoint
// any progress: 13 consecutive matching_triggered events, zero
// matching_complete, zero matching_error — every single hop's
// computeTrailProgress call was being abandoned mid-loop before it could
// write even one trail_match_checks row. National Trails are deliberately
// processed FIRST (see the nearbyTrails query in sync-engine.ts) precisely
// because they're what users look for immediately — but that ordering only
// helps if there's enough time to actually reach one, and 10s wasn't, for
// an account whose first candidates happen to include the coastal 1,014km
// trail. Now that dispatch no longer waits on this function (see
// CHAIN_TIME_BUDGET_MS's comment), there's no reason to keep it this
// short — 30s gives real per-hop progress a chance without meaningfully
// changing the platform-ceiling math above.
const FINISH_SYNC_RACE_BUDGET_MS = 30_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

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
 *
 * On "partial", the next hop is dispatched BEFORE finishSync runs, not
 * after — deliberately. finishSync is the slow, unbounded part of a hop
 * (see FINISH_SYNC_RACE_BUDGET_MS); if it or anything after it still
 * somehow overran Vercel's own runtime ceiling despite the budgets here,
 * dispatching first means the CHAIN keeps moving regardless — a lost hop's
 * own matching is recoverable later (the external match-drain backstop
 * gets there eventually), but a lost dispatch previously meant the whole
 * chain silently stopped with nothing to notice for up to
 * EXTERNAL_SYNC_RESUME_STALE_SECONDS.
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
    result = await runSyncChunk(userId, { budgetMs: CHAIN_TIME_BUDGET_MS, dbPool: syncBatchPool });
  } catch (err) {
    console.error(`[sync-chain] Chunk failed for user ${userId} at hop ${hop}:`, err);
    return;
  }

  if (result.status === "rate_limited" || result.status === "error" || result.status === "subscription_required") {
    console.warn(`[sync-chain] Stopping for user ${userId} at hop ${hop}: ${result.status}`);
    return;
  }

  if (result.status === "partial") {
    // Dispatch first — see the doc comment above for why this ordering
    // matters. Awaited only until the next hop acknowledges receipt, same
    // as match-chain.ts's equivalent.
    const dispatched = await dispatchNextHop("/api/internal/continue-sync", { userId, hop: hop + 1 });
    if (!dispatched) {
      console.error(`[sync-chain] Failed to dispatch next hop for user ${userId} — runExternalSyncResumeBatch will pick this up instead`);
    }
  }

  if (result.newDbIds.length > 0) {
    await withDeadline(
      finishSync(userId, result.newDbIds, matchBatchPool).catch((err) => {
        console.error(`[sync-chain] finishSync failed for user ${userId} at hop ${hop}:`, err);
      }),
      FINISH_SYNC_RACE_BUDGET_MS,
      undefined
    );
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

// Below this, don't bother starting finishSync at all — same reasoning as
// drain-batch/route.ts's own MIN_USEFUL_MATCH_BUDGET_MS/
// MIN_USEFUL_SYNC_RESUME_BUDGET_MS: a call with barely any time left is
// vanishingly unlikely to make real progress before its race times out
// anyway, so skip the discovery/connection overhead entirely.
const MIN_USEFUL_FINISH_SYNC_MS = 3_000;

// Higher than the dashboard's own 60s self-heal threshold (dashboard/page.tsx)
// — that one fires on a page load a human is actually looking at, so it can
// afford to be eager; this runs unattended and re-picks the same candidate
// repeatedly if it's still genuinely mid-chunk, so a slightly longer
// threshold avoids racing an in-flight reactive-chain hop that just hasn't
// reached its next heartbeat yet.
const EXTERNAL_SYNC_RESUME_STALE_SECONDS = 90;

async function pickNextStaleSyncCandidate(): Promise<{ id: string; first_name: string | null } | null> {
  const { rows } = await syncBatchPool.query<{ id: string; first_name: string | null }>(
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
  // Tracked so finishSync below gets whatever's ACTUALLY left of the
  // caller's own timeBudgetMs, not the reactive chain's fixed
  // FINISH_SYNC_RACE_BUDGET_MS regardless of how much runSyncChunk already
  // used. The caller here is drain-batch/route.ts, which has its own
  // shared TOTAL_REQUEST_BUDGET_MS across three phases — blindly adding a
  // fixed 30s on top of whatever this phase already spent would risk
  // reproducing the exact FUNCTION_INVOCATION_TIMEOUT regression that
  // constant exists to prevent (see FINISH_SYNC_RACE_BUDGET_MS's comment),
  // just moved to this call site instead of the reactive chain's.
  const startedAt = Date.now();
  const candidate = await pickNextStaleSyncCandidate();
  if (!candidate) {
    return { candidateId: null, timedOut: false };
  }

  const syncPromise = runSyncChunk(candidate.id, { budgetMs: timeBudgetMs, dbPool: syncBatchPool })
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
    // Same hard-race reasoning as runSyncChunkAndChain's own finishSync
    // call — see FINISH_SYNC_RACE_BUDGET_MS's comment. But NOT that same
    // fixed budget: this function's caller (drain-batch/route.ts) passed
    // timeBudgetMs as ITS OWN real ceiling for this whole call, and the
    // runSyncChunk race above may already have used a good chunk of it —
    // capping at whatever's actually left (with a small minimum below
    // which finishSync isn't worth attempting at all) keeps this call's
    // TOTAL duration bounded to what the caller actually asked for, rather
    // than tacking a fixed 30s on top regardless of how much of
    // timeBudgetMs remains.
    const remainingForFinishSync = timeBudgetMs - (Date.now() - startedAt);
    if (remainingForFinishSync > MIN_USEFUL_FINISH_SYNC_MS) {
      await withDeadline(
        finishSync(candidate.id, result.newDbIds, matchBatchPool).catch((err) => {
          console.error(`[external-sync-resume] finishSync failed for ${candidate.first_name ?? candidate.id}:`, err);
        }),
        remainingForFinishSync,
        undefined
      );
    }
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
