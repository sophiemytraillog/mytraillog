import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { matchNextBatch } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
// Vercel Hobby plan hard-caps function duration at 60s, same ceiling as
// /api/sync/activities — this route is the client-driven continuation of
// finishSync's own capped inline matching pass (see sync-engine.ts's
// MAX_TRAILS_PER_FINISH_SYNC), called in a loop by TrailMatchProgress until
// `done`. One call processes one bounded batch; a large backlog finishes
// over several calls instead of one long-running request.
export const maxDuration = 60;

const BATCH_SIZE = 30;
const TIME_BUDGET_MS = 45_000;

export async function GET() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const result = await matchNextBatch(userId, BATCH_SIZE, TIME_BUDGET_MS);

  logSyncEvent(userId, "client_match_batch", {
    checkedThisBatch: result.checkedThisBatch,
    matchedThisBatch: result.matchedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
  });

  return NextResponse.json(result);
}
