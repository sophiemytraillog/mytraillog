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

  // Recording strava_id into deleted_users and deleting the user row happen
  // in one transaction — getting this split wrong in either direction is a
  // real problem: recorded-but-not-deleted would wrongly deny a still-live
  // account its trial if something else re-triggered signup, and deleted-
  // but-not-recorded would let a genuinely-deleted account get a free
  // second trial on reconnect (see strava/callback/route.ts's
  // deleted_users check, 2026-09-30).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [user] } = await client.query<{ strava_id: string }>(
      "SELECT strava_id FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (user?.strava_id) {
      await client.query(
        "INSERT INTO deleted_users (strava_id) VALUES ($1) ON CONFLICT (strava_id) DO UPDATE SET deleted_at = NOW()",
        [user.strava_id]
      );
    }
    // users cascades (ON DELETE CASCADE) to activities, user_trail_progress,
    // user_trail_manual_segments, sync_log, trail_match_checks, and
    // activity_trail_matches — see schema.sql. trail_requests uses
    // ON DELETE SET NULL by design: past trail suggestions stay visible for
    // admin follow-up, anonymised, rather than being deleted outright.
    const { rowCount } = await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
    console.log(`[account-deletion] Deleted ${rowCount ?? 0} user record for ${userId}`);
    return { deleted: (rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[account-deletion] Failed to delete data for user ${userId}:`, err);
    return { deleted: false };
  } finally {
    client.release();
  }
}
