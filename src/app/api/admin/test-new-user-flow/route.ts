import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_USER_ID } from "@/lib/admin";
import { runNewUserFlowDiagnostics } from "@/lib/new-user-flow-check";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Powers the admin dashboard's "System Health" button — same underlying
// check as /api/internal/test-new-user-flow (see new-user-flow-check.ts),
// just admin-cookie authenticated instead of CRON_SECRET, since that
// secret must never reach the browser. Same auth pattern as
// /api/admin/rematch.
export async function POST() {
  const callerId = cookies().get("strava_user_id")?.value;
  if (callerId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const report = await runNewUserFlowDiagnostics();
  return NextResponse.json(report);
}
