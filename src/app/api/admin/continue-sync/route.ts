import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { ADMIN_USER_ID } from "@/lib/admin";
import { CHAIN_DISPATCH_ORIGIN } from "@/lib/chain-origin";
import { logSyncEvent } from "@/lib/sync-log";

export const dynamic = "force-dynamic";

// Backs /admin's "Re-run sync" button (ResyncButton.tsx). Starts a fresh
// background sync chain (hop 0) for one user by calling
// /api/internal/continue-sync, the same endpoint the chain uses for its
// own hops. That endpoint needs CRON_SECRET, which the browser can't send,
// so this admin-only route makes the call server-side.
//
// Unlike "Kick user" (one bounded round, looped from the browser), this
// hands the whole sync to the background chain and returns as soon as the
// first hop acknowledges — useful for a user stuck mid-sync.
export async function POST(request: NextRequest) {
  const callerId = cookies().get("strava_user_id")?.value;
  if (callerId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const userId = typeof body?.userId === "string" ? body.userId : null;
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE id = $1", [userId]);
  if (rows.length === 0) {
    return NextResponse.json({ error: "No such user" }, { status: 404 });
  }

  const secret = process.env.CRON_SECRET;
  let res: Response;
  try {
    res = await fetch(new URL("/api/internal/continue-sync", CHAIN_DISPATCH_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ userId, hop: 0 }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(`[admin/continue-sync] Dispatch failed for user ${userId}:`, err);
    return NextResponse.json({ error: "Could not reach continue-sync" }, { status: 502 });
  }

  logSyncEvent(userId, "admin_continue_sync_call", { triggeredBy: callerId, status: res.status });

  if (!res.ok) {
    return NextResponse.json({ error: `continue-sync returned HTTP ${res.status}` }, { status: 502 });
  }
  return NextResponse.json({ accepted: true });
}
