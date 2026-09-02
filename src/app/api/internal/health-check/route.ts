import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";
import { runTrialLifecycleCheck } from "@/lib/trial-lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily pre/post-launch sanity sweep — read-only, no remediation. Every
// query here mirrors one already proven against production during the
// 2026-08-21 pre-launch review; this just makes that a standing, automated
// check instead of a one-off manual pass. Scheduled 30 minutes after
// cron/resume-stuck-syncs (see vercel.json) so it reports state AFTER that
// sweep has had a chance to fix what it can, rather than flagging things
// that were already about to self-heal.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/health-check] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const issues: string[] = [];

  // 1a. Sync stuck in 'syncing' — the cron sweep's own stale-sync phase
  // should already be resuming these; still here in an hour means
  // something's wrong with THAT recovery path, not just a slow sync.
  const stuckSyncing = await pool.query<{ first_name: string | null; last_name: string | null; sync_progress_at: Date }>(
    `SELECT first_name, last_name, sync_progress_at FROM users
     WHERE sync_status = 'syncing' AND sync_progress_at < NOW() - INTERVAL '1 hour'
     ORDER BY sync_progress_at ASC`
  );
  if (stuckSyncing.rows.length > 0) {
    issues.push(
      `${stuckSyncing.rows.length} user(s) stuck in sync_status='syncing' for over 1 hour: ` +
        stuckSyncing.rows.map((u) => `${u.first_name} ${u.last_name} (since ${u.sync_progress_at.toISOString()})`).join(", ")
    );
  }

  // 1b. sync_status='error' — runSyncChunk sets this on a Strava rate limit
  // or any thrown error, but nothing ever automatically retries it (only
  // 'syncing' is picked up by the cron's stuck-sync sweep) — a real gap
  // found during the pre-launch code walkthrough, not yet fixed, so this
  // is the interim signal until it is.
  const errored = await pool.query<{ first_name: string | null; last_name: string | null }>(
    `SELECT first_name, last_name FROM users WHERE sync_status = 'error'`
  );
  if (errored.rows.length > 0) {
    issues.push(
      `${errored.rows.length} user(s) with sync_status='error' (no automatic retry path exists yet): ` +
        errored.rows.map((u) => `${u.first_name} ${u.last_name}`).join(", ")
    );
  }

  // 2. Geo-tagged activities but zero trail_match_checks rows at all — the
  // trail-matching chain never even started for this account.
  const neverMatched = await pool.query<{ first_name: string | null; last_name: string | null; activity_count: string }>(
    `SELECT u.first_name, u.last_name, COUNT(a.id)::text AS activity_count
     FROM users u
     JOIN activities a ON a.user_id = u.id AND a.geometry IS NOT NULL
     WHERE NOT EXISTS (SELECT 1 FROM trail_match_checks c WHERE c.user_id = u.id)
     GROUP BY u.id, u.first_name, u.last_name`
  );
  if (neverMatched.rows.length > 0) {
    issues.push(
      `${neverMatched.rows.length} user(s) have geo-tagged activities but zero trail_match_checks rows (matching never started): ` +
        neverMatched.rows.map((u) => `${u.first_name} ${u.last_name} (${u.activity_count} activities)`).join(", ")
    );
  }

  // 3. Stale trail_match_checks — checked before a since-added nearby
  // activity. Same detection query as scripts/audit-stale-matches.mjs and
  // matchNextBatch's own candidate query (match-trails.ts) — a nonzero
  // count here is expected background noise (self-heals the next time
  // that user's chain runs) unless it's large or growing across days.
  const stale = await pool.query<{ first_name: string | null; last_name: string | null; stale_trails: string }>(
    `SELECT u.first_name, u.last_name, COUNT(DISTINCT c.trail_id)::text AS stale_trails
     FROM trail_match_checks c
     JOIN users u ON u.id = c.user_id
     JOIN trails t ON t.id = c.trail_id
     WHERE EXISTS (
       SELECT 1 FROM activities a
       WHERE a.user_id = c.user_id AND a.geometry IS NOT NULL
         AND a.created_at > c.checked_at
         AND t.simplified_geometry && ST_Expand(a.geometry, 0.003)
     )
     GROUP BY u.id, u.first_name, u.last_name`
  );
  const totalStale = stale.rows.reduce((sum, r) => sum + parseInt(r.stale_trails), 0);
  if (totalStale > 0) {
    issues.push(
      `${totalStale} stale trail_match_checks pair(s) across ${stale.rows.length} user(s): ` +
        stale.rows.map((u) => `${u.first_name} ${u.last_name} (${u.stale_trails})`).join(", ")
    );
  }

  // 4. Confirmed trail match, description writes on, never even attempted —
  // the exact symptom that motivated building the automatic description
  // chain in the first place (see description-chain.ts).
  const { rows: [neverAttempted] } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM activities a
     JOIN activity_trail_matches atm ON atm.activity_id = a.id
     JOIN users u ON u.id = a.user_id
     WHERE a.strava_description_updated = FALSE
       AND a.description_update_attempts = 0
       AND u.strava_description_updates = TRUE`
  );
  if (parseInt(neverAttempted.n) > 0) {
    issues.push(
      `${neverAttempted.n} activities have a confirmed trail match, description writes enabled, and were never attempted (strava_description_updated=false, description_update_attempts=0).`
    );
  }

  // 5a. Literal 0%/0-distance user_trail_progress rows — MATCH_SQL only
  // ever inserts a row when covered_geom is non-empty, so this should be
  // structurally impossible; kept as a regression guard, not because it's
  // ever been observed.
  const zeroProgress = await pool.query<{ first_name: string | null; last_name: string | null; trail_name: string }>(
    `SELECT u.first_name, u.last_name, t.name AS trail_name
     FROM user_trail_progress utp
     JOIN users u ON u.id = utp.user_id
     JOIN trails t ON t.id = utp.trail_id
     WHERE utp.completed_distance = 0 OR utp.completion_percentage = 0`
  );
  if (zeroProgress.rows.length > 0) {
    issues.push(
      `${zeroProgress.rows.length} user_trail_progress row(s) show 0 distance/percentage (should be structurally impossible): ` +
        zeroProgress.rows.slice(0, 10).map((r) => `${r.first_name} ${r.last_name} / ${r.trail_name}`).join(", ")
    );
  }

  // 5b. The real-world version of "0% where activity_trail_matches has
  // data": activity_trail_matches links an activity to a trail but
  // user_trail_progress has no row for that (user, trail) pair at all —
  // renders as 0%/not-started on the dashboard despite a supposedly
  // matched activity. Root cause of the original South Downs Way
  // investigation (2026-08-19/20).
  const orphaned = await pool.query<{ first_name: string | null; last_name: string | null; trail_name: string; n: string }>(
    `SELECT u.first_name, u.last_name, t.name AS trail_name, COUNT(*)::text AS n
     FROM activity_trail_matches atm
     JOIN users u ON u.id = atm.user_id
     JOIN trails t ON t.id = atm.trail_id
     WHERE NOT EXISTS (
       SELECT 1 FROM user_trail_progress utp
       WHERE utp.user_id = atm.user_id AND utp.trail_id = atm.trail_id
     )
     GROUP BY u.id, u.first_name, u.last_name, t.id, t.name
     ORDER BY n DESC
     LIMIT 20`
  );
  if (orphaned.rows.length > 0) {
    issues.push(
      `${orphaned.rows.length} (user, trail) pair(s) have activity_trail_matches but no user_trail_progress row: ` +
        orphaned.rows.slice(0, 10).map((r) => `${r.first_name} ${r.last_name} / ${r.trail_name} (${r.n})`).join(", ") +
        (orphaned.rows.length > 10 ? `, and ${orphaned.rows.length - 10} more` : "")
    );
  }

  // 6. Trial lifecycle — reminders, trial -> grace_period transitions,
  // grace_period final warnings, and 14-day-expired cleanup (Strava
  // deauth + account deletion). See trial-lifecycle.ts. This is the one
  // check here that isn't read-only: it sends emails and can delete
  // accounts, same "part of the daily health-check cron" placement asked
  // for in the 2026-09-16 request (item 6) rather than a separate cron —
  // Vercel Hobby only allows two daily crons (see vercel.json) and this
  // one already runs after resume-stuck-syncs each night.
  let trialSummaryLines: string[] = [];
  try {
    const trial = await runTrialLifecycleCheck();
    trialSummaryLines = trial.summaryLines;
    console.log(`[internal/health-check] Trial lifecycle: ${trial.summaryLines.join(" ")}`);
  } catch (err) {
    console.error("[internal/health-check] Trial lifecycle check failed:", err);
    issues.push(`Trial lifecycle check threw an error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const healthy = issues.length === 0;
  console.log(`[internal/health-check] ${healthy ? "All clear" : `${issues.length} issue(s) found`}`);

  // Status-counts line always appears whenever the email actually sends, so
  // it's included even on an otherwise-healthy day where a trial reminder
  // or cleanup happened — but a quiet day with zero issues AND zero trial
  // activity still sends nothing, same as before this check existed.
  const trialHadActivity = trialSummaryLines.length > 1; // index 0 is always the status-counts line
  if (!healthy || trialHadActivity) {
    await sendNotificationEmail(
      `My Trail Log health check - ${issues.length} issue(s) found`,
      [...issues, ...trialSummaryLines]
    );
  }

  return NextResponse.json({ healthy, issueCount: issues.length, issues, trial: trialSummaryLines });
}
