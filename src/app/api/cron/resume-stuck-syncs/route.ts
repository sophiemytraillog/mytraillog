import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { matchNextBatch } from "@/lib/match-trails";
import { processDescriptionBatch } from "@/lib/trail-descriptions";
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

// Third phase, same run: sweep the description-writing backlog. Root cause
// this exists to fix (2026-08-20): handleNewActivity's inline write is
// skipped whenever its own 20s matching budget times out, on the assumption
// something would circle back once matching actually finished — nothing
// did, since the only thing that ever finished the job (the "Update
// historical activity descriptions" button) is manual. The primary path is
// now the same waitUntil()-chained background job pattern as trail matching
// (see description-chain.ts), triggered from the webhook and from sync
// completion; this sweep is the once-a-day backstop for whatever a failed
// chain dispatch or a stalled account still misses.
const DESCRIPTION_SWEEP_TIME_BUDGET_MS = 55_000;
const DESCRIPTION_SWEEP_USERS_PER_RUN = 5;

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

  // Phase 2: safety net for sync-engine's deferred trail matches. The
  // primary path is now the server-side waitUntil()-chained background job
  // (see match-chain.ts), triggered from /api/sync/activities on sync
  // completion and from dashboard/page.tsx on any visit with leftover
  // matching — neither depends on the browser staying open. This sweep is
  // the once-a-day backstop for whatever that still misses: a chain that
  // fails to dispatch its next hop, a deploy restarting mid-chain, or an
  // account that hasn't synced or opened the dashboard since a chain last
  // stalled. Bounded to a handful of users per run so the backlog drains
  // fairly across days rather than one account eating the whole time budget.
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

  // Phase 3: description-writing backlog sweep. Only users who've actually
  // opted in (strava_description_updates) and have at least one activity
  // with a confirmed trail match still unwritten are candidates — the
  // EXISTS below is cheap (index on activity_trail_matches.user_id) and
  // avoids reading processDescriptionBatch's own discovery query for every
  // user in the app just to find out most have nothing pending.
  const descriptionResults: Array<{ userId: string; checkedThisRun: number; updatedThisRun: number; done: boolean }> = [];

  if (Date.now() - startedAt < DESCRIPTION_SWEEP_TIME_BUDGET_MS) {
    const { rows: pendingUsers } = await pool.query<{ id: string; first_name: string | null }>(
      `SELECT u.id, u.first_name
       FROM users u
       WHERE u.strava_description_updates = TRUE
         AND EXISTS (
           SELECT 1 FROM activities a
           JOIN activity_trail_matches atm ON atm.activity_id = a.id
           WHERE a.user_id = u.id AND a.strava_description_updated = FALSE
         )
       ORDER BY u.last_synced_at ASC
       LIMIT ${DESCRIPTION_SWEEP_USERS_PER_RUN}`
    );

    for (const user of pendingUsers) {
      const remainingBudget = DESCRIPTION_SWEEP_TIME_BUDGET_MS - (Date.now() - startedAt);
      if (remainingBudget <= 0) {
        console.log(`[cron/resume-stuck-syncs] Description-sweep budget reached — ${pendingUsers.length - descriptionResults.length} user(s) deferred to next run`);
        break;
      }

      const result = await processDescriptionBatch(user.id, remainingBudget, "cron");

      console.log(`[cron/resume-stuck-syncs] description sweep — ${user.first_name ?? user.id}: checked ${result.checkedThisBatch}, updated ${result.updatedThisBatch}, done=${result.done}`);

      descriptionResults.push({
        userId: user.id,
        checkedThisRun: result.checkedThisBatch,
        updatedThisRun: result.updatedThisBatch,
        done: result.done,
      });

      if (result.budgetExhausted) {
        console.log("[cron/resume-stuck-syncs] Daily description budget exhausted — stopping sweep for today");
        break;
      }
    }
  }

  return NextResponse.json({
    staleUsersFound: staleUsers.length,
    processed: results.length,
    results,
    matchSweep: matchResults,
    descriptionSweep: descriptionResults,
  });
}
