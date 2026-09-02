import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { CYCLING_ACTIVITY_TYPES } from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";

export const dynamic = "force-dynamic";

// See sync-engine.ts's NEARBY_TRAILS_BBOX_DEGREES / MAX_TRAILS_PER_FINISH_SYNC
// comment for the full story: ST_DWithin against trails.simplified_geometry
// (even materialized + GIST-indexed) still hits Postgres's statement
// timeout for a batch of activities checked against the full trails table
// — confirmed via direct reproduction. Plain geometry `&&` bbox overlap,
// applied per-activity via ST_Expand (pure bounding-box arithmetic, no
// buffer geometry computed), is what's actually fast. Capped for the same
// reason: a user with cycling activities spread nationwide can produce
// hundreds of real candidates, which is more than this route should try to
// process synchronously — anything beyond the cap stays unmatched for now
// and gets picked up by a later sync chunk or /admin rematch.
const NEARBY_TRAILS_BBOX_DEGREES = 0.003;
const MAX_TRAILS_PER_CALL = 40;

// Runs after the include_cycling preference is switched on. Every activity
// type is already stored locally regardless of that preference (see
// sync/activities and the webhook handler) — so there's nothing to fetch
// from Strava here. This just re-runs trail matching, scoped to trails near
// the user's already-stored cycling activities, so it counts them now.
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
        send("progress", { message: "Finding trails near your cycling activities…" });

        const { rows: affectedTrails } = await pool.query<{ id: string }>(
          `SELECT DISTINCT t.id
           FROM activities a
           JOIN trails t ON t.simplified_geometry && ST_Expand(a.geometry, ${NEARBY_TRAILS_BBOX_DEGREES})
           WHERE a.user_id = $1
             AND a.activity_type = ANY($2::text[])
             AND a.geometry IS NOT NULL`,
          [userId, Array.from(CYCLING_ACTIVITY_TYPES)]
        );
        const trailIds = affectedTrails.map((r) => r.id).slice(0, MAX_TRAILS_PER_CALL);

        send("matching", {
          message: trailIds.length > 0
            ? `Matching cycling activities to ${trailIds.length} trail${trailIds.length === 1 ? "" : "s"}…`
            : "No cycling activities found near any trail",
        });

        let matchedTrails = 0;
        if (trailIds.length > 0) {
          matchedTrails = await computeTrailProgress(userId, trailIds);
        }

        send("done", {
          matchedTrails,
          message: matchedTrails > 0
            ? `Done - ${matchedTrails} trail${matchedTrails === 1 ? "" : "s"} updated`
            : "Done - no trail matches found",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "An unexpected error occurred";
        console.error("[backfill-cycling] Fatal error:", err);
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
