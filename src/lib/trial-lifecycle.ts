import { pool } from "./db";
import { logSyncEvent } from "./sync-log";
import { sendUserEmail } from "./email";
import { revokeStravaAndDeleteUser } from "./account-deletion";

// ── Trial lifecycle (2026-09-16) ────────────────────────────────────────────
// trial (1 month from signup) -> grace_period (14 days after trial ends) ->
// deleted (14 days into grace_period). Reminder emails only go out to users
// who've provided contact_email (Strava never exposes an athlete's email) —
// see schema.sql's contact_email comment. The grace_period -> deletion
// cleanup itself is NOT conditional on having an email; only the courtesy
// reminders are (per the 2026-09-16 request, item 3 vs item 5).
//
// No paywall enforcement anywhere in here — trial and grace_period users
// keep full access right up until the account is actually deleted. This is
// purely date tracking, reminder emails, and cleanup.

interface LifecycleUser {
  id: string;
  first_name: string | null;
  contact_email: string | null;
}

export interface TrialLifecycleResult {
  statusCounts: Record<string, number>;
  remindersSent: number;
  graceStarted: number;
  finalWarningsSent: number;
  cleanedUp: Array<{ id: string; name: string }>;
  summaryLines: string[];
}

async function getStatusCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ subscription_status: string; count: string }>(
    `SELECT subscription_status, COUNT(*)::text AS count FROM users GROUP BY subscription_status`
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.subscription_status] = parseInt(row.count, 10);
  return counts;
}

// 7 days before trial_ends_at, still in 'trial' — one-shot via the
// NOT EXISTS(sync_log) idempotency check (same pattern used across this
// codebase for "have I already done this" without a dedicated boolean
// column — e.g. pickNextMatchDrainCandidate's staleness clause).
async function sendTrialEndingReminders(): Promise<number> {
  const { rows } = await pool.query<LifecycleUser>(
    `SELECT u.id, u.first_name, u.contact_email
     FROM users u
     WHERE u.subscription_status = 'trial'
       AND u.trial_ends_at IS NOT NULL
       AND u.trial_ends_at <= NOW() + INTERVAL '7 days'
       AND u.contact_email IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_log s WHERE s.user_id = u.id AND s.event = 'trial_reminder_sent'
       )`
  );

  for (const user of rows) {
    await sendUserEmail(
      user.contact_email!,
      "Your My Trail Log free trial ends in 7 days",
      [
        `Hi ${user.first_name ?? "there"},`,
        "Your My Trail Log free trial ends in 7 days. Subscribe for £12.99/year to keep tracking your trails.",
      ]
    );
    logSyncEvent(user.id, "trial_reminder_sent", {});
  }
  return rows.length;
}

// trial_ends_at has passed while still 'trial' — flip to grace_period for
// EVERYONE in this state (not conditional on email), then email whoever
// provided one. Single UPDATE...RETURNING so concurrent/duplicate cron runs
// can't double-transition the same row (the WHERE won't match it a second
// time once it's grace_period).
async function startGracePeriods(): Promise<number> {
  const { rows } = await pool.query<LifecycleUser>(
    `UPDATE users
     SET subscription_status = 'grace_period'
     WHERE subscription_status = 'trial'
       AND trial_ends_at IS NOT NULL
       AND trial_ends_at <= NOW()
     RETURNING id, first_name, contact_email`
  );

  for (const user of rows) {
    logSyncEvent(user.id, "trial_expired_grace_started", {});
    if (user.contact_email) {
      await sendUserEmail(
        user.contact_email,
        "Your My Trail Log free trial has ended",
        [
          `Hi ${user.first_name ?? "there"},`,
          "Your free trial has ended. Subscribe within 14 days to keep your data, or your account will be removed.",
        ]
      );
      logSyncEvent(user.id, "trial_expired_notice_sent", {});
    }
  }
  return rows.length;
}

// 7 days into the 14-day grace period (7 remaining) — final warning, same
// email-required + NOT EXISTS(sync_log) idempotency pattern as the trial
// reminder above.
async function sendGracePeriodFinalWarnings(): Promise<number> {
  const { rows } = await pool.query<LifecycleUser>(
    `SELECT u.id, u.first_name, u.contact_email
     FROM users u
     WHERE u.subscription_status = 'grace_period'
       AND u.trial_ends_at IS NOT NULL
       AND u.trial_ends_at <= NOW() - INTERVAL '7 days'
       AND u.contact_email IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sync_log s WHERE s.user_id = u.id AND s.event = 'grace_period_final_warning_sent'
       )`
  );

  for (const user of rows) {
    await sendUserEmail(
      user.contact_email!,
      "Final notice: your My Trail Log account will be removed in 7 days",
      [
        `Hi ${user.first_name ?? "there"},`,
        "Your My Trail Log account will be removed in 7 days. Subscribe now to keep your trail progress.",
      ]
    );
    logSyncEvent(user.id, "grace_period_final_warning_sent", {});
  }
  return rows.length;
}

// 14 days into grace_period — revoke Strava, delete the account, free the
// athlete slot. Runs regardless of contact_email (unlike the reminders
// above — see this file's top comment).
async function cleanupExpiredGracePeriods(): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query<{ id: string; first_name: string | null; last_name: string | null }>(
    `SELECT id, first_name, last_name
     FROM users
     WHERE subscription_status = 'grace_period'
       AND trial_ends_at IS NOT NULL
       AND trial_ends_at <= NOW() - INTERVAL '14 days'`
  );

  const cleanedUp: Array<{ id: string; name: string }> = [];
  for (const user of rows) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.id;

    // Awaited directly (not logSyncEvent's usual fire-and-forget) and
    // written BEFORE the delete below — sync_log.user_id is a NOT NULL FK
    // to users, so this insert would fail once the row is actually gone,
    // and a fire-and-forget call here could lose the race against the
    // DELETE that follows two lines down.
    await pool
      .query(`INSERT INTO sync_log (user_id, event, detail) VALUES ($1, $2, $3)`, [
        user.id,
        "trial_expired_cleanup",
        JSON.stringify({ name }),
      ])
      .catch((err) => console.error(`[trial-lifecycle] Failed to log trial_expired_cleanup for ${user.id}:`, err));

    const { deleted } = await revokeStravaAndDeleteUser(user.id);
    if (deleted) cleanedUp.push({ id: user.id, name });
  }
  return cleanedUp;
}

export async function runTrialLifecycleCheck(): Promise<TrialLifecycleResult> {
  const statusCounts = await getStatusCounts();
  const remindersSent = await sendTrialEndingReminders();
  const graceStarted = await startGracePeriods();
  const finalWarningsSent = await sendGracePeriodFinalWarnings();
  const cleanedUp = await cleanupExpiredGracePeriods();

  const summaryLines: string[] = [
    `Trial status: ${statusCounts.trial ?? 0} trial, ${statusCounts.grace_period ?? 0} grace_period, ${statusCounts.active ?? 0} active.`,
  ];
  if (remindersSent > 0) summaryLines.push(`Sent ${remindersSent} trial-ending-soon reminder(s).`);
  if (graceStarted > 0) summaryLines.push(`${graceStarted} trial(s) expired -> moved to grace_period.`);
  if (finalWarningsSent > 0) summaryLines.push(`Sent ${finalWarningsSent} grace-period final-warning email(s).`);
  if (cleanedUp.length > 0) {
    summaryLines.push(`Cleaned up ${cleanedUp.length} expired account(s): ${cleanedUp.map((u) => u.name).join(", ")}.`);
  }

  return { statusCounts, remindersSent, graceStarted, finalWarningsSent, cleanedUp, summaryLines };
}
