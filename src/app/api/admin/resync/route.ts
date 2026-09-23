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

  const startedAt = Date.now();

  // ── Phase 1: sync — one chunk, only if a sync is actually in progress.
  // A "complete" account has nothing to resume; running finishSync's own
  // registration query again for it would just be wasted work.
  let sync: {
    status: string;
    fetched?: number;
    saved?: number;
    skipped?: boolean;
  };
  if (userRows[0].sync_status === "syncing") {
    const result = await runSyncChunk(userId, { budgetMs: 20_000, dbPool: syncBatchPool });
    sync = { status: result.status };
    if (result.status === "partial" || result.status === "complete") {
      sync.fetched = result.fetched;
      sync.saved = result.saved;
      if (result.newDbIds.length > 0) {
        await finishSync(userId, result.newDbIds, matchBatchPool).catch((err) => {
          console.error(`[admin/resync] finishSync failed for user ${userId}:`, err);
        });
      }
    }
  } else {
    sync = { status: userRows[0].sync_status, skipped: true };
  }

  // ── Phase 2: matching — bounded to whatever's left of the shared budget.
  const remainingAfterSync = TOTAL_BUDGET_MS - (Date.now() - startedAt);
  let matching: Awaited<ReturnType<typeof matchNextBatch>> | { skipped: true };
  if (remainingAfterSync >= MIN_USEFUL_MATCH_BUDGET_MS) {
    matching = await matchNextBatch(userId, MATCH_PAGE_SIZE, remainingAfterSync, matchBatchPool);
  } else {
    matching = { skipped: true };
  }

  // ── Phase 3: descriptions — same budget-carve-out pattern.
  const remainingAfterMatching = TOTAL_BUDGET_MS - (Date.now() - startedAt);
  let descriptions: Awaited<ReturnType<typeof processDescriptionBatch>> | { skipped: true };
  if (remainingAfterMatching >= MIN_USEFUL_DESC_BUDGET_MS) {
    descriptions = await processDescriptionBatch(userId, remainingAfterMatching, "admin_resync", descriptionBatchPool);
  } else {
    descriptions = { skipped: true };
  }

  // Terminal sync outcomes (nothing left to resume, or something that won't
  // resolve by clicking again) count as "done" for this phase so the button
  // stops looping instead of spinning forever.
  const syncDone =
    sync.status === "complete" ||
    sync.skipped === true ||
    sync.status === "rate_limited" ||
    sync.status === "error" ||
    sync.status === "subscription_required";
  const matchingDone = "skipped" in matching ? true : matching.done;
  const descriptionsDone = "skipped" in descriptions ? true : descriptions.done || descriptions.budgetExhausted;

  logSyncEvent(userId, "admin_resync_call", {
    triggeredBy: callerId,
    sync,
    matching,
    descriptions,
  });

  return NextResponse.json({
    sync,
    matching,
    descriptions,
    done: syncDone && matchingDone && descriptionsDone,
  });
}
