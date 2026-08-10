import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";

export const dynamic = "force-dynamic";

// Required by Strava's API agreement and UK GDPR: a user must be able to
// revoke access and have their data deleted from within the app, not just
// by disconnecting on Strava's side.
export async function POST() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Best-effort: revoke the Strava grant so it also shows as removed on
  // Strava's own "My Apps" page, not just deleted from our DB. A failure
  // here (token already expired/invalid, Strava briefly down) shouldn't
  // block deleting the user's own data — that's the part we fully control
  // and the part they're actually asking for.
  try {
    const token = await getValidAccessToken(userId);
    const res = await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token }),
    });
    if (!res.ok) {
      console.warn(`[account/delete] Strava deauthorize returned HTTP ${res.status} for user ${userId}`);
    }
  } catch (err) {
    console.warn(`[account/delete] Strava deauthorize failed for user ${userId}:`, err);
  }

  console.log(`[account/delete] Deleting all data for user ${userId}`);

  try {
    // users cascades (ON DELETE CASCADE) to activities, user_trail_progress,
    // user_trail_manual_segments, sync_log, trail_match_checks, and
    // activity_trail_matches — see schema.sql. trail_requests uses
    // ON DELETE SET NULL by design: past trail suggestions stay visible for
    // admin follow-up, anonymised (no link back to this account), rather
    // than being deleted outright — trail_name/region/url/notes aren't
    // personal data about the user once that link is gone.
    const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    console.log(`[account/delete] Deleted ${rowCount ?? 0} user record for ${userId}`);
  } catch (err) {
    // Unlike the Strava call above, a failure here genuinely means the
    // user's data was NOT deleted — don't clear cookies or report success.
    console.error(`[account/delete] Failed to delete data for user ${userId}:`, err);
    return NextResponse.json(
      { error: "Something went wrong deleting your data. Please try again." },
      { status: 500 }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete("strava_user_id");
  response.cookies.delete("strava_athlete");
  return response;
}
