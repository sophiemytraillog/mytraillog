import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { revokeStravaAndDeleteUser } from "@/lib/account-deletion";

export const dynamic = "force-dynamic";

// Required by Strava's API agreement and UK GDPR: a user must be able to
// revoke access and have their data deleted from within the app, not just
// by disconnecting on Strava's side.
export async function POST() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  console.log(`[account/delete] Deleting all data for user ${userId}`);

  // revokeStravaAndDeleteUser (src/lib/account-deletion.ts) is shared with
  // the trial-expiry auto-cleanup cron — same Strava-deauth-then-delete
  // logic either way.
  const { deleted } = await revokeStravaAndDeleteUser(userId);
  if (!deleted) {
    // A failure here genuinely means the user's data was NOT deleted —
    // don't clear cookies or report success.
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
