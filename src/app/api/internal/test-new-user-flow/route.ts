import { NextRequest, NextResponse } from "next/server";
import { runNewUserFlowDiagnostics } from "@/lib/new-user-flow-check";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// External-monitoring entry point — hit this on a schedule (or manually)
// to get a PASS/WARN/FAIL readout of every stage a brand-new user's
// account actually passes through, without creating one. See
// new-user-flow-check.ts for what each step does and why. Same
// CRON_SECRET auth pattern as drain-batch and resume-stuck-syncs; the
// admin dashboard's "System Health" button calls the SAME underlying
// check via /api/admin/test-new-user-flow instead (admin-cookie
// authenticated), since CRON_SECRET must never reach the browser.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/test-new-user-flow] CRON_SECRET not set — endpoint is unauthenticated");
  }

  // Always 200 regardless of `healthy` — same convention as
  // /api/internal/health-check: the real verdict lives in the JSON body
  // (`healthy` + each step's own `status`), not the HTTP status code. A
  // caller doing simple 2xx-only uptime monitoring only ever confirms this
  // route itself ran without crashing, not that every step passed — read
  // `healthy` in the body for the real answer, the same way health-check's
  // own callers (its cron job, which reads `issues`) already have to.
  const report = await runNewUserFlowDiagnostics();
  return NextResponse.json(report);
}
