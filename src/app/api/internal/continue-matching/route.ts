import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { runMatchBatchAndChain } from "@/lib/match-chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-to-server relay link in the background trail-matching chain (see
// match-chain.ts). Not user-facing — called by a previous hop of the same
// chain, or by the first trigger in /api/sync/activities or
// dashboard/page.tsx. Responds immediately and does the real batch work
// after, via waitUntil(), same pattern as the Strava webhook — so the
// caller only ever waits for this hop to acknowledge, not for the whole
// remaining chain to finish.
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/continue-matching] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const body = await request.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  const hop = typeof body?.hop === "number" ? body.hop : 0;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  waitUntil(runMatchBatchAndChain(userId, hop));

  return NextResponse.json({ accepted: true, hop });
}
