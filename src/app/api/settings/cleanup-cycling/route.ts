import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { CYCLING_ACTIVITY_TYPES } from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";

export const dynamic = "force-dynamic";

// Mirrors backfill-cycling/route.ts, run after include_cycling flips OFF
// instead of on. activity_trail_matches rows created while cycling was
// counted (either by this same toggle turning it on, or by the daily
// match-drain sweep) never get revisited once the preference changes —
// nothing else in the app deletes activity_trail_matches — so a cycling
// activity that was a trail's only coverage leaves that row pointing at a
// (user, trail) pair with no user_trail_progress: exactly the "orphaned
// pair" the health check's #5b flags. Root cause of the Luke Davis / Coast
// to Coast Trail case, 2026-09-08.
export async function GET() {
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
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Client already disconnected
        }
      };

      try {
        send("progress", { message: "Removing cycling activity matches…" });

        // DELETE...RETURNING in one statement, not SELECT-then-DELETE — no
        // window where a concurrent match-drain hop could insert a row
        // between the two.
        const { rows: removed } = await pool.query<{ trail_id: string }>(
          `DELETE FROM activity_trail_matches atm
           USING activities a
           WHERE atm.activity_id = a.id
             AND atm.user_id = $1
             AND a.activity_type = ANY($2::text[])
           RETURNING atm.trail_id`,
          [userId, Array.from(CYCLING_ACTIVITY_TYPES)]
        );

        const trailIds = Array.from(new Set(removed.map((r) => r.trail_id)));

        if (trailIds.length === 0) {
          send("done", { updatedTrails: 0, message: "Done - no cycling matches to remove" });
          return;
        }

        send("matching", {
          message: `Recomputing progress for ${trailIds.length} trail${trailIds.length === 1 ? "" : "s"}…`,
        });

        // Re-runs the same MATCH_SQL used everywhere else, now with
        // include_cycling already false — so it recalculates each affected
        // trail's coverage from non-cycling activities only, and re-inserts
        // activity_trail_matches for any that still genuinely overlap.
        const matchedTrails = await computeTrailProgress(userId, trailIds);

        send("done", {
          updatedTrails: matchedTrails,
          message: `Done - ${trailIds.length} trail${trailIds.length === 1 ? "" : "s"} cleaned up`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "An unexpected error occurred";
        console.error("[cleanup-cycling] Fatal error:", err);
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
      "X-Accel-Buffering": "no",
    },
  });
}
