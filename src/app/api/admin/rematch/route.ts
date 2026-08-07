import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { computeTrailProgress } from "@/lib/match-trails";
import { ADMIN_USER_ID } from "@/lib/admin";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE_SIZE = 40;
const TIME_BUDGET_MS = 45_000;

// Manual escape hatch for exactly the failure mode that prompted this route:
// a user whose sync completed (or is stuck) but somehow ended up with zero
// trail matches.
//
// Originally tried discovering "trails near any of this user's activities"
// as one query, to scope computeTrailProgress to a small candidate set —
// mirrors finishSync's own incremental-sync pattern. That works fine for a
// typical account, but timed out (Postgres 57014) against a real ~1,300-
// activity account even with the same simplified-geometry pre-filter
// computeTrailProgress itself uses per-trail: checking every trail against
// every activity in one query is a fundamentally more expensive shape than
// computeTrailProgress's own per-trail loop, regardless of indexing.
//
// Instead this walks the full trails table in resumable pages, exactly
// like sync's own partial/continue chunking (see SyncButton.tsx) — each
// call processes trails until close to the time budget, then returns a
// nextOffset for the client to resume from. Correctly handles any account
// size; a small account finishes in one call, a large one takes several
// clicks of "Continue" the same way a big first sync does.
export async function POST(request: NextRequest) {
  const callerId = cookies().get("strava_user_id")?.value;
  if (callerId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const userId = typeof body.userId === "string" ? body.userId : null;
  const offset = typeof body.offset === "number" && body.offset >= 0 ? body.offset : 0;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE id = $1", [userId]);
  if (rows.length === 0) {
    return NextResponse.json({ error: "No such user" }, { status: 404 });
  }

  if (offset === 0) {
    logSyncEvent(userId, "admin_rematch_triggered", { triggeredBy: callerId });
  }

  const { rows: totalRows } = await query<{ count: string }>("SELECT COUNT(*) FROM trails");
  const totalTrails = parseInt(totalRows[0]?.count ?? "0");

  const startedAt = Date.now();
  let cursor = offset;
  let matchedTrails = 0;
  let trailsChecked = 0;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const { rows: page } = await query<{ id: string }>(
      "SELECT id FROM trails ORDER BY name LIMIT $1 OFFSET $2",
      [PAGE_SIZE, cursor]
    );
    if (page.length === 0) break;

    matchedTrails += await computeTrailProgress(userId, page.map((t) => t.id));
    trailsChecked += page.length;
    cursor += page.length;

    if (page.length < PAGE_SIZE) break; // reached the end of the table
  }

  const done = cursor >= totalTrails;
  if (done) {
    logSyncEvent(userId, "admin_rematch_complete", { matchedTrails, trailsChecked: cursor });
  }

  return NextResponse.json({
    matchedTrails,
    trailsCheckedThisCall: trailsChecked,
    nextOffset: cursor,
    totalTrails,
    done,
  });
}
