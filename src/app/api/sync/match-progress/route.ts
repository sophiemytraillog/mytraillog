import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// Read-only progress snapshot, polled by the dashboard while a new user's
// sync and matching run (TrailMatchProgress every 4s, SyncButton's
// background state every 10s). No matching work happens here — that runs
// server-side regardless of whether anyone's looking (see match-chain.ts).
//
// Fields (2026-10-31 onboarding fixes):
// - totalChecked / totalTrails / done: overall matching progress
// - nationalChecked / nationalTotal: the first-sync banner clears once all
//   National Trails are checked, so the client can refresh itself then
// - finalCheck: the user's first full sync finished and their checks were
//   reset for a from-scratch re-match (sync-engine.ts) which hasn't
//   finished yet — shown as "Running final check…" rather than a counter
//   that appears to jump backwards
// - syncStatus / activityCount: keeps the background-sync activity count
//   climbing instead of freezing after the first chunk
export async function GET() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { rows: [r] } = await query<{
    total: string;
    checked: string;
    national_total: string;
    national_checked: string;
    sync_status: string | null;
    activity_count: string;
    had_reset: boolean;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked,
       (SELECT COUNT(*) FROM trails WHERE category = 'national_trail') AS national_total,
       (SELECT COUNT(*) FROM trail_match_checks c JOIN trails t ON t.id = c.trail_id
          WHERE c.user_id = $1 AND t.category = 'national_trail') AS national_checked,
       (SELECT sync_status FROM users WHERE id = $1) AS sync_status,
       (SELECT COUNT(*) FROM activities WHERE user_id = $1) AS activity_count,
       EXISTS (SELECT 1 FROM sync_log WHERE user_id = $1 AND event = 'first_sync_checks_reset') AS had_reset`,
    [userId]
  );

  const totalChecked = parseInt(r.checked);
  const totalTrails = parseInt(r.total);
  const done = totalChecked >= totalTrails;
  return NextResponse.json({
    totalChecked,
    totalTrails,
    done,
    nationalChecked: parseInt(r.national_checked),
    nationalTotal: parseInt(r.national_total),
    finalCheck: r.had_reset && !done,
    syncStatus: r.sync_status,
    activityCount: parseInt(r.activity_count),
  });
}
