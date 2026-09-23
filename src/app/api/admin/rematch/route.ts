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

// Hard safety net on top of TIME_BUDGET_MS, 2026-09-23: that budget is only
// checked BETWEEN trails inside matchNextBatch, not enforced mid-operation
// — one unusually slow trail can still blow past it and hit Vercel's raw
// 60s FUNCTION_INVOCATION_TIMEOUT, which returns Vercel's own HTML error
// page instead of this route's JSON and crashes RematchButton.tsx's
// res.json() call. Same fix as the sibling /api/admin/resync route.
const HARD_DEADLINE_MS = 50_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

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

  const TIMED_OUT_SENTINEL = Symbol("timedOut");
  const raced = await withDeadline<Awaited<ReturnType<typeof matchNextBatch>> | typeof TIMED_OUT_SENTINEL>(
    matchNextBatch(userId, PAGE_SIZE, TIME_BUDGET_MS),
    HARD_DEADLINE_MS,
    TIMED_OUT_SENTINEL
  );
  const timedOut = raced === TIMED_OUT_SENTINEL;
  const result = timedOut
    ? { checkedThisBatch: 0, matchedThisBatch: 0, totalChecked: 0, totalTrails: 0, done: false, hadFailures: false }
    : raced;

  logSyncEvent(userId, "admin_rematch_call", {
    triggeredBy: callerId,
    checkedThisCall: result.checkedThisBatch,
    matchedThisCall: result.matchedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
    timedOut,
  });

  return NextResponse.json({
    matchedTrails: result.matchedThisBatch,
    checkedThisCall: result.checkedThisBatch,
    totalChecked: result.totalChecked,
    totalTrails: result.totalTrails,
    done: result.done,
    timedOut,
  });
}
