import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { matchNextBatch } from "@/lib/match-trails";
import { ADMIN_USER_ID } from "@/lib/admin";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIME_BUDGET_MS = 45_000;
const PAGE_SIZE = 30;

// Manual escape hatch for a user whose sync completed (or is stuck) but
// somehow ended up with zero trail matches — see the Paul Crowe investigation
// this route was built for. Resumable across any number of calls (browser
// sessions, days, whatever) via trail_match_checks rather than a client-held
// offset into an alphabetical scan: a crash mid-sweep previously meant the
// next attempt restarted from "A" and re-walked everything already done.
// National Trails (the ~20 the category flags, the ones users actually
// look at first) are always processed before the 1,100+ other long-distance
// paths, so a user sees their headline trails within the first call or two
// instead of waiting for an alphabetical sweep to reach them by chance.
// Each trail gets up to 3 attempts with a backoff between them for
// transient connection drops (observed in practice: DNS blips, dropped
// connections mid-loop); a trail still failing after 3 tries is skipped and
// retried once more at the end of this call if time remains, then left
// unchecked for the next call rather than being falsely marked done.
export async function POST(request: NextRequest) {
  const callerId = cookies().get("strava_user_id")?.value;
  if (callerId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const userId = typeof body.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { rows: userRows } = await query<{ id: string }>("SELECT id FROM users WHERE id = $1", [userId]);
  if (userRows.length === 0) {
    return NextResponse.json({ error: "No such user" }, { status: 404 });
  }

  const result = await matchNextBatch(userId, PAGE_SIZE, TIME_BUDGET_MS);

  logSyncEvent(userId, "admin_rematch_call", {
    triggeredBy: callerId,
    checkedThisCall: result.checkedThisBatch,
    matchedThisCall: result.matchedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
  });

  return NextResponse.json({
    matchedTrails: result.matchedThisBatch,
    checkedThisCall: result.checkedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
  });
}
