import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { computeTrailProgress } from "@/lib/match-trails";
import { ADMIN_USER_ID } from "@/lib/admin";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIME_BUDGET_MS = 45_000;
const PAGE_SIZE = 30;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_500;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// computeTrailProgress already catches every per-trail error internally and
// never throws — it just logs and moves on — so a caller can't tell success
// from failure via try/catch. trail_match_checks is only written on the
// success path (see match-trails.ts), so its presence after the call IS the
// success signal: retry until it appears, up to MAX_ATTEMPTS, with a short
// backoff for transient connection drops to actually clear before retrying.
async function attemptTrailWithRetry(
  userId: string,
  trailId: string
): Promise<{ ok: boolean; matched: boolean }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await computeTrailProgress(userId, [trailId]);
    const { rows } = await query<{ matched: boolean }>(
      "SELECT matched FROM trail_match_checks WHERE user_id = $1 AND trail_id = $2",
      [userId, trailId]
    );
    if (rows.length > 0) return { ok: true, matched: rows[0].matched };
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[admin/rematch] Trail ${trailId} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, matched: false };
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

  const startedAt = Date.now();

  const { rows: candidates } = await query<{ id: string; name: string }>(
    `SELECT t.id, t.name
     FROM trails t
     WHERE NOT EXISTS (
       SELECT 1 FROM trail_match_checks c WHERE c.user_id = $1 AND c.trail_id = t.id
     )
     ORDER BY (t.category = 'national_trail') DESC, t.name ASC
     LIMIT $2`,
    [userId, PAGE_SIZE]
  );

  let checkedThisCall = 0;
  let matchedThisCall = 0;
  const stillFailing: typeof candidates = [];

  for (const trail of candidates) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trail.id);
    if (ok) {
      checkedThisCall++;
      if (matched) matchedThisCall++;
    } else {
      console.error(`[admin/rematch] Trail ${trail.name} failed all ${MAX_ATTEMPTS} attempts — deferred`);
      stillFailing.push(trail);
    }
  }

  // Come back to skipped trails before returning, if there's still budget —
  // a trail that failed because of a transient blip earlier in this call
  // may well succeed a few seconds later without needing a whole new call.
  for (const trail of stillFailing) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trail.id);
    if (ok) {
      checkedThisCall++;
      if (matched) matchedThisCall++;
    }
    // Still failing after this — left unchecked, picked up by a future call.
  }

  const { rows: [totals] } = await query<{ total: string; checked: string }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked`,
    [userId]
  );
  const totalTrails = parseInt(totals.total);
  const totalChecked = parseInt(totals.checked);
  const done = totalChecked >= totalTrails;

  logSyncEvent(userId, "admin_rematch_call", {
    triggeredBy: callerId,
    checkedThisCall,
    matchedThisCall,
    totalChecked,
    totalTrails,
    done,
  });

  return NextResponse.json({
    matchedTrails: matchedThisCall,
    checkedThisCall,
    totalChecked,
    totalTrails,
    done,
  });
}
