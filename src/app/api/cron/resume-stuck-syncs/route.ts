import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { matchNextBatch } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-side fallback for the dashboard's self-heal nudge (see
// dashboard/page.tsx's staleSync check) — catches users who abandoned a
// sync mid-flight and never came back to the dashboard to trigger the
// client-side resume. Without this, a stuck sync could sit in
// sync_status='syncing' forever with literally nothing to ever revisit it.
//
// Vercel Hobby plan caps cron jobs at once/day (see vercel.json) — this is
// a coarse safety net, not the primary recovery path. Most stuck syncs get
// caught immediately by the dashboard nudge the next time the user opens
// the app; this only matters for users who never come back on their own.
//
// Each stale user gets one short chunk (budget well under the per-user
// share of this function's own 60s ceiling), matching are run for
// whatever that chunk saved (same partial-chunk fix as the SSE route), and
// the sweep moves on — a user needing many chunks converges over several
// days of daily runs, same as they would if they kept reopening the
// dashboard once a day themselves.
const PER_USER_BUDGET_MS = 8_000;
const STALE_SYNC_TIME_BUDGET_MS = 25_000;
const TOTAL_TIME_BUDGET_MS = 50_000;
const STALE_THRESHOLD_MINUTES = 3;

// Second phase, same run: sweep up sync-engine's own deferred trails.
// finishSync only ever matches against the trails near *that chunk's* new
// activities, capped at MAX_TRAILS_PER_FINISH_SYNC — see the comment there.
// For an account whose backfill touches more than the cap in one area, the
// overflow trails get zero automatic follow-up once sync_status flips to
// 'complete' and no further chunks/webhook events arrive to re-trigger
// matching near them. Previously the only recovery was a human noticing
// (see /api/admin/rematch's "Paul Crowe investigation" — Chris Rance and
// Luke Barton-Davis, 2026-08-19, were the same bug) and manually rematching.
// Reuses trail_match_checks as the resume checkpoint, same as the admin
// route, so this and a manual admin call never duplicate work or race.
const MATCH_SWEEP_USERS_PER_RUN = 5;
const MATCH_SWEEP_TRAILS_PER_USER = 30;

export async function GET(request: NextRequest) {
  // Vercel sets this automatically when CRON_SECRET is configured in the
  // project's environment variables; falls back to allowing the request
  // (logged) if that hasn't been set up yet, same pattern as RESEND_API_KEY
  // elsewhere in this app — functional without it, more secure with it.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[cron/resume-stuck-syncs] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const startedAt = Date.now();
  const { rows: staleUsers } = await pool.query<{ id: string; first_name: string | null }>(
    `SELECT id, first_name FROM users
     WHERE sync_status = 'syncing'
       AND sync_progress_at < NOW() - INTERVAL '${STALE_THRESHOLD_MINUTES} minutes'`
  );

  const results: Array<{ userId: string; status: string }> = [];

  for (const user of staleUsers) {
    if (Date.now() - startedAt > STALE_SYNC_TIME_BUDGET_MS) {
      console.log(`[cron/resume-stuck-syncs] Stale-sync budget reached — ${staleUsers.length - results.length} user(s) deferred to next run`);
      break;
    }

    try {
      logSyncEvent(user.id, "cron_resume_attempt", {});
      const result = await runSyncChunk(user.id, { budgetMs: PER_USER_BUDGET_MS });

      if (result.status === "complete" || result.status === "partial") {
        await finishSync(user.id, result.newDbIds).catch((err) => {
          console.error(`[cron/resume-stuck-syncs] finishSync failed for ${user.id}:`, err);
        });
      }

      results.push({ userId: user.id, status: result.status });
      console.log(`[cron/resume-stuck-syncs] ${user.first_name ?? user.id}: ${result.status}`);
    } catch (err) {
      console.error(`[cron/resume-stuck-syncs] Error resuming ${user.id}:`, err);
      results.push({ userId: user.id, status: "error" });
    }
  }

  // Phase 2: safety net for sync-engine's deferred trail matches, for users
  // whose sync completed but who never reopened the dashboard — the primary
  // recovery path is now TrailMatchProgress auto-continuing client-side
  // (see DashboardClient), same "fast path is client-driven, cron is the
  // once-a-day fallback for users who never come back" split as phase 1.
  // Bounded to a handful of users per run so the backlog drains fairly
  // across days rather than one account eating the whole time budget.
  const matchResults: Array<{ userId: string; checkedThisRun: number; matchedThisRun: number; done: boolean }> = [];

  if (Date.now() - startedAt < TOTAL_TIME_BUDGET_MS) {
    const { rows: incompleteUsers } = await pool.query<{ id: string; first_name: string | null }>(
      `SELECT u.id, u.first_name
       FROM users u
       WHERE u.sync_status = 'complete'
         AND EXISTS (
           SELECT 1 FROM trails t
           WHERE NOT EXISTS (
             SELECT 1 FROM trail_match_checks c WHERE c.user_id = u.id AND c.trail_id = t.id
           )
         )
       ORDER BY u.last_synced_at ASC
       LIMIT ${MATCH_SWEEP_USERS_PER_RUN}`
    );

    for (const user of incompleteUsers) {
      const remainingBudget = TOTAL_TIME_BUDGET_MS - (Date.now() - startedAt);
      if (remainingBudget <= 0) {
        console.log(`[cron/resume-stuck-syncs] Match-sweep budget reached — ${incompleteUsers.length - matchResults.length} user(s) deferred to next run`);
        break;
      }

      const result = await matchNextBatch(user.id, MATCH_SWEEP_TRAILS_PER_USER, remainingBudget);

      logSyncEvent(user.id, "cron_match_sweep", {
        checkedThisRun: result.checkedThisBatch,
        matchedThisRun: result.matchedThisBatch,
        done: result.done,
      });
      console.log(`[cron/resume-stuck-syncs] match sweep — ${user.first_name ?? user.id}: checked ${result.checkedThisBatch}, matched ${result.matchedThisBatch}, done=${result.done}`);

      matchResults.push({
        userId: user.id,
        checkedThisRun: result.checkedThisBatch,
        matchedThisRun: result.matchedThisBatch,
        done: result.done,
      });
    }
  }

  return NextResponse.json({
    staleUsersFound: staleUsers.length,
    processed: results.length,
    results,
    matchSweep: matchResults,
  });
}
