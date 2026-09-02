import { pool } from "./db";
import { getValidAccessToken } from "./strava";

/**
 * Revokes the Strava grant and deletes all of a user's data — shared by the
 * self-service /api/account/delete route and the trial-expiry auto-cleanup
 * (see trial-lifecycle.ts), so there's exactly one place that knows how to
 * fully remove an account.
 */
export async function revokeStravaAndDeleteUser(userId: string): Promise<{ deleted: boolean }> {
  // Best-effort: revoke the Strava grant so it also shows as removed on
  // Strava's own "My Apps" page, not just deleted from our DB. A failure
  // here (token already expired/invalid, Strava briefly down) shouldn't
  // block deleting the user's own data — that's the part we fully control.
  try {
    const token = await getValidAccessToken(userId);
    const res = await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token }),
    });
    if (!res.ok) {
      console.warn(`[account-deletion] Strava deauthorize returned HTTP ${res.status} for user ${userId}`);
    }
  } catch (err) {
    console.warn(`[account-deletion] Strava deauthorize failed for user ${userId}:`, err);
  }

  try {
    // users cascades (ON DELETE CASCADE) to activities, user_trail_progress,
    // user_trail_manual_segments, sync_log, trail_match_checks, and
    // activity_trail_matches — see schema.sql. trail_requests uses
    // ON DELETE SET NULL by design: past trail suggestions stay visible for
    // admin follow-up, anonymised, rather than being deleted outright.
    const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    console.log(`[account-deletion] Deleted ${rowCount ?? 0} user record for ${userId}`);
    return { deleted: (rowCount ?? 0) > 0 };
  } catch (err) {
    console.error(`[account-deletion] Failed to delete data for user ${userId}:`, err);
    return { deleted: false };
  }
}
