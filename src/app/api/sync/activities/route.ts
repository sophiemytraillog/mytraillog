import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";

export const dynamic = "force-dynamic";
// Vercel Hobby plan hard-caps function duration at 60s — this cannot be
// raised without a plan upgrade, and vercel.json enforces the same value.
// A single request only ever runs one bounded sync-engine chunk; large
// histories finish over several chunks, driven by SyncButton's auto-continue
// on the "partial" event (see src/app/dashboard/SyncButton.tsx).
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const userId = cookies().get("strava_user_id")?.value;

  if (!userId) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ message: "Not authenticated" })}\n\n`,
      { status: 401, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        if (request.signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Client already disconnected — stop silently
        }
      };

      try {
        const result = await runSyncChunk(userId, {
          signal: request.signal,
          onProgress: (p) => send("progress", p),
        });

        if (result.status === "partial") {
          send("partial", {
            fetched: result.fetched,
            saved: result.saved,
            message: `Syncing… ${result.fetched} fetched, ${result.saved} saved so far`,
          });
          return;
        }

        if (result.status === "rate_limited" || result.status === "error") {
          send("error", { message: result.message });
          return;
        }

        // status === "complete" — matching/description-writing runs after the
        // client has been notified, so it won't block the "done" UI update.
        send("done", {
          fetched: result.fetched,
          saved: result.saved,
          message: `Sync complete — ${result.saved} activit${result.saved === 1 ? "y" : "ies"} saved`,
        });

        const { matchedTrails } = await finishSync(userId, result.newDbIds);

        // Sent once trail matching (and description writes) have actually
        // landed in the DB — the client waits for this before refreshing the
        // dashboard, otherwise it re-reads stats mid-match and shows stale
        // stat cards right after a sync that visibly said "done".
        send("matched", {
          matchedTrails,
          message: "Trail progress updated",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "An unexpected error occurred";
        console.error("[sync/activities] Fatal error:", err);
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx/proxy buffering
    },
  });
}
