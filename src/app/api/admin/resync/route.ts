import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query, syncBatchPool, matchBatchPool, descriptionBatchPool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { matchNextBatch } from "@/lib/match-trails";
import { processDescriptionBatch } from "@/lib/trail-descriptions";
import { ADMIN_USER_ID } from "@/lib/admin";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Manual "push this one along" button for /admin (2026-09-23 request) — for
// a new signup that looks stalled between reactive-chain hop limits and the
// next external drain run, this does one bounded round of all three phases
// (sync, matching, descriptions) for a SINGLE user in one click, rather than
// needing Claude Code (or a raw curl call) to kick it. Same three
// primitives and dedicated batch pools the reactive chains and
// drain-batch/route.ts already use — this isn't a new code path, just a
// per-user, admin-triggered entry point into the existing ones.
//
// One call only ever covers one bounded round (sync chunk + matching batch
// + description batch, budget-shared like drain-batch), same "never the
// whole backlog in one shot" reasoning as everywhere else in this app —
// the client button (ResyncButton.tsx) loops calling this until `done` is
// true, mirroring RematchButton's existing loop-until-done pattern.
const TOTAL_BUDGET_MS = 45_000;
const MIN_USEFUL_MATCH_BUDGET_MS = 3_000;
const MIN_USEFUL_DESC_BUDGET_MS = 3_000;
const MATCH_PAGE_SIZE = 30;

// Hard safety net on top of TOTAL_BUDGET_MS, 2026-09-23: that 45s figure is
// only a SOFT budget honoured between iterations (matchNextBatch/
// processDescriptionBatch only check elapsed time between trails/
// activities, not mid-operation) — one unusually slow trail or DB call can
// still blow well past it, exactly like the finishSync race this same
// pattern already exists for in sync-chain.ts. Confirmed happening here in
// practice for Luke Davis: this route hit Vercel's raw 60s
// FUNCTION_INVOCATION_TIMEOUT, which returns Vercel's own HTML error page
// instead of this route's JSON — and ResyncButton.tsx's res.json() call
// crashed trying to parse it ("Unexpected token 'A', "An error o"... is
// not valid JSON"), surfacing as a confusing client-side error rather than
// a clean "try again". Racing the whole three-phase run against a hard
// deadline well under the 60s cap means this route ALWAYS returns valid
// JSON — worst case, an honest "timed out, whatever finished is still
// saved" response — never a platform-level crash page.
const HARD_DEADLINE_MS = 50_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

interface ResyncResult {
  sync: { status: string; fetched?: number; saved?: number; skipped?: boolean };
  matching: Awaited<ReturnType<typeof matchNextBatch>> | { skipped: true };
  descriptions: Awaited<ReturnType<typeof processDescriptionBatch>> | { skipped: true };
  done: boolean;
  timedOut?: boolean;
}

export async function POST(request: NextRequest) {
  const callerId = cookies().get("strava_user_id")?.value;
  if (callerId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const userId = typeof body.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { rows: userRows } = await query<{ id: string; sync_status: string }>(
    "SELECT id, sync_status FROM users WHERE id = $1",
    [userId]
  );
  if (userRows.length === 0) {
    return NextResponse.json({ error: "No such user" }, { status: 404 });
  }

  const runPhases = async (): Promise<ResyncResult> => {
    const startedAt = Date.now();

    // ── Phase 1: sync — one chunk, only if a sync is actually in progress.
    // A "complete" account has nothing to resume; running finishSync's own
    // registration query again for it would just be wasted work.
    const sync: { status: string; fetched?: number; saved?: number; skipped?: boolean } =
      userRows[0].sync_status === "syncing"
        ? { status: "syncing" } // placeholder, overwritten below once runSyncChunk resolves
        : { status: userRows[0].sync_status, skipped: true };

    if (userRows[0].sync_status === "syncing") {
      const result = await runSyncChunk(userId, { budgetMs: 20_000, dbPool: syncBatchPool });
      sync.status = result.status;
      if (result.status === "partial" || result.status === "complete") {
        sync.fetched = result.fetched;
        sync.saved = result.saved;
        if (result.newDbIds.length > 0) {
          await finishSync(userId, result.newDbIds, matchBatchPool).catch((err) => {
            console.error(`[admin/resync] finishSync failed for user ${userId}:`, err);
          });
        }
      }
    }

    // ── Phase 2: matching — bounded to whatever's left of the shared budget.
    const remainingAfterSync = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const matching: ResyncResult["matching"] =
      remainingAfterSync >= MIN_USEFUL_MATCH_BUDGET_MS
        ? await matchNextBatch(userId, MATCH_PAGE_SIZE, remainingAfterSync, matchBatchPool)
        : { skipped: true };

    // ── Phase 3: descriptions — same budget-carve-out pattern.
    const remainingAfterMatching = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const descriptions: ResyncResult["descriptions"] =
      remainingAfterMatching >= MIN_USEFUL_DESC_BUDGET_MS
        ? await processDescriptionBatch(userId, remainingAfterMatching, "admin_resync", descriptionBatchPool)
        : { skipped: true };

    // Terminal sync outcomes (nothing left to resume, or something that
    // won't resolve by clicking again) count as "done" for this phase so
    // the button stops looping instead of spinning forever.
    const syncDone =
      sync.status === "complete" ||
      sync.skipped === true ||
      sync.status === "rate_limited" ||
      sync.status === "error" ||
      sync.status === "subscription_required";
    const matchingDone = "skipped" in matching ? true : matching.done;
    const descriptionsDone = "skipped" in descriptions ? true : descriptions.done || descriptions.budgetExhausted;

    return { sync, matching, descriptions, done: syncDone && matchingDone && descriptionsDone };
  };

  const result = await withDeadline<ResyncResult>(runPhases(), HARD_DEADLINE_MS, {
    sync: { status: "timeout", skipped: true },
    matching: { skipped: true },
    descriptions: { skipped: true },
    done: false,
    timedOut: true,
  });

  logSyncEvent(userId, "admin_resync_call", {
    triggeredBy: callerId,
    ...result,
  });

  return NextResponse.json(result);
}
