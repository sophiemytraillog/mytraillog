import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
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
const TOTAL_TIME_BUDGET_MS = 50_000;
const STALE_THRESHOLD_MINUTES = 3;

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
    if (Date.now() - startedAt > TOTAL_TIME_BUDGET_MS) {
      console.log(`[cron/resume-stuck-syncs] Time budget reached — ${staleUsers.length - results.length} user(s) deferred to next run`);
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

  return NextResponse.json({
    staleUsersFound: staleUsers.length,
    processed: results.length,
    results,
  });
}
