import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { pool } from "@/lib/db";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { triggerMatchDrain } from "@/lib/match-chain";
import { triggerBacklogDrain } from "@/lib/description-chain";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

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
const STALE_THRESHOLD_MINUTES = 3;

// Second phase, same run: kick off the daily trail-match backlog drain.
// finishSync only ever matches against the trails near *that chunk's* new
// activities, capped at MAX_TRAILS_PER_FINISH_SYNC — see the comment there.
// For an account whose backfill touches more than the cap in one area, the
// overflow trails get zero automatic follow-up unless something re-triggers
// matching near them. Previously the only recovery was a human noticing
// (see /api/admin/rematch's "Paul Crowe investigation" — Chris Rance and
// Luke Barton-Davis, 2026-08-19, were the same bug) and manually rematching.
//
// Used to be a bounded in-process loop here (5 users/run, 30 trails/user,
// within this invocation's own ~50s ceiling) — too slow for a dormant
// account: pre-launch review, 2026-08-21, found 6 of 10 users still sitting
// at 8-245 of 1,181 trails checked, weeks after their last sync, because
// nothing had ever prompted a chain to run for them and the old sweep would
// have taken over a month to close a 1,100-trail gap at 30/day. Like phase
// 3 below, triggerMatchDrain hands off to a waitUntil()-chained background
// job (see match-chain.ts's runMatchDrainHop) that cycles through EVERY
// user with incomplete trail_match_checks, 200 trails at a time, entirely
// independent of this invocation's own 60s ceiling.

// Third phase, same run: kick off the daily description-backlog drain.
// Unlike phases 1 and 2, this ISN'T bounded to this invocation's own time
// budget — triggerBacklogDrain hands off to description-chain.ts's
// runBacklogDrainHop, which self-chains across every user with pending
// backlog via /api/internal/continue-description-drain, hop after hop,
// for as long as there's budget left (reserveBackfillSlot's 250/day cap).
// One waitUntil() kickoff here can end up covering the whole rest of the
// day, entirely independent of this cron invocation's own 60s ceiling.
//
// Root cause this exists to fix (2026-08-20): handleNewActivity's inline
// write is skipped whenever its own 20s matching budget times out, on the
// assumption something would circle back once matching actually finished —
// nothing did but a manual button nobody was clicking. The reactive chain
// (webhook/sync completion, see description-chain.ts's
// runDescriptionBatchAndChain) now catches most of that in real time; this
// daily kickoff is what proactively drains whatever backlog is left over
// regardless — previously a second follow-up finding (Sophie: ~1,950
// pending, daily budget at 46/250 with nothing actively spending it) once
// the reactive-only version turned out to still leave the bulk of a large
// backlog sitting idle most days.

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

  // Unconditional heartbeat — the only durable proof this invocation
  // actually happened, independent of anything below succeeding or
  // failing. Root cause this exists to fix (2026-08-25): every previous
  // signal this route produced (stale-sync logs, drain events) was
  // conditional on there being work to do, so a night where nothing was
  // stuck and nothing was pending left literally zero trace — indistinguishable
  // from Vercel's cron scheduler simply never having invoked this route at
  // all. If this event is missing for a given night, the cron didn't fire;
  // if it's present but the drain events below aren't, the fault is
  // downstream of this point, not the cron trigger itself.
  logSyncEvent(ADMIN_USER_ID, "cron_heartbeat", { route: "resume-stuck-syncs" });

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

  waitUntil(triggerMatchDrain());
  waitUntil(triggerBacklogDrain());

  return NextResponse.json({
    staleUsersFound: staleUsers.length,
    processed: results.length,
    results,
    matchDrainStarted: true,
    descriptionDrainStarted: true,
  });
}
