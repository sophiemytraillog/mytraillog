import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { runDescriptionBatchAndChain } from "@/lib/description-chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Server-to-server relay link in the background description-writing chain
// (see description-chain.ts) — same shape as /api/internal/continue-matching.
// Not user-facing. Responds immediately and does the real batch work after,
// via waitUntil(), so the caller only ever waits for this hop to acknowledge.
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn("[internal/continue-descriptions] CRON_SECRET not set — endpoint is unauthenticated");
  }

  const body = await request.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  const hop = typeof body?.hop === "number" ? body.hop : 0;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  waitUntil(runDescriptionBatchAndChain(userId, origin, hop, "chain"));

  return NextResponse.json({ accepted: true, hop });
}
