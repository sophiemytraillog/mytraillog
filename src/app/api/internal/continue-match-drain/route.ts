import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { runMatchDrainHop } from "@/lib/match-chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-to-server relay link in the daily trail-match backlog drain (see
// match-chain.ts's runMatchDrainHop) — same shape as
// /api/internal/continue-description-drain, but cycling through every user
// with incomplete trail_match_checks rather than one specific user. Not
// user-facing. Responds immediately and does the real batch work after, via
// waitUntil(), so the caller only ever waits for this hop to acknowledge.
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/continue-match-drain] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const body = await request.json().catch(() => null);
  const hop = typeof body?.hop === "number" ? body.hop : 0;

  waitUntil(runMatchDrainHop(hop));

  return NextResponse.json({ accepted: true, hop });
}
