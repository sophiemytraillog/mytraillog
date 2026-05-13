import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
} from "@/lib/trail-descriptions";

export const dynamic = "force-dynamic";

// Sliding-window rate limiter: tracks each Strava API call and blocks until
// there is budget remaining in the current 15-minute window.
class RateLimiter {
  private readonly windowMs = 15 * 60 * 1000;
  private readonly maxRequests: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      // Wait until the oldest request falls out of the window
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 50;
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
}

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "true";
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
      // Send a keepalive comment immediately so the browser's EventSource
      // establishes the connection before any slow DB operations start.
      // Without this, a slow initial query causes a "Connection error" in the
      // client because the connection closes before any SSE data is received.
      controller.enqueue(encoder.encode(": keep-alive\n\n"));

      const send = (event: string, data: object) => {
        if (request.signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* client disconnected */ }
      };

      try {
        // Single query: join activities to trails the user has started via a
        // spatial proximity check. Replaces the old per-trail loop which ran one
        // ST_DWithin scan per trail (slow for users with many started trails).
        // Step 1: trails the user has started.
        const { rows: userTrails } = await pool.query<{ trail_id: string }>(
          `SELECT trail_id FROM user_trail_progress
           WHERE user_id = $1 AND completion_percentage > 0`,
          [userId]
        );

        // Step 2: for each trail, find nearby unupdated activities.
        // Queries activities with geometry-based ST_DWithin (no ::geography cast)
        // so the GIST index on activities.geometry is used — geography casts bypass it.
        // 0.001 degrees ≈ 90m at UK latitudes, a safe over-estimate of 50m.
        const matchedIds = new Set<string>();
        for (const { trail_id } of userTrails) {
          const client = await pool.connect();
          try {
            await client.query("SET statement_timeout = '10000'");
            const { rows } = await client.query<{ id: string }>(
              `SELECT a.id
               FROM activities a
               WHERE a.user_id = $1
                 AND a.geometry IS NOT NULL
                 AND (a.strava_description_updated = FALSE OR $3)
                 AND ST_DWithin(
                   a.geometry,
                   (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) FROM trails WHERE id = $2),
                   0.001
                 )`,
              [userId, trail_id, force]
            );
            for (const { id } of rows) matchedIds.add(id);
          } catch (err) {
            console.warn(`[update-descriptions] Spatial query for trail ${trail_id} failed:`, err);
          } finally {
            client.release();
          }
        }

        // Step 3: fetch details for matched activity IDs only.
        let activities: Array<{ id: string; strava_activity_id: string; name: string }> = [];
        if (matchedIds.size > 0) {
          const { rows } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
            `SELECT id, strava_activity_id::text AS strava_activity_id, name
             FROM activities WHERE id = ANY($1::uuid[]) ORDER BY start_date DESC`,
            [Array.from(matchedIds)]
          );
          activities = rows;
        }

        const total = activities.length;
        send("start", { total, message: `Checking ${total} activities near your trails…` });

        const limiter = new RateLimiter(100);
        let updated = 0;
        let errors = 0;

        for (let i = 0; i < activities.length; i++) {
          if (request.signal.aborted) break;

          const act = activities[i];

          send("progress", {
            current: i + 1,
            total,
            updated,
            message: `Checking ${i + 1} of ${total}: ${act.name}`,
          });

          try {
            const matches = await getActivityTrailMatches(userId, act.id);

            if (matches.length === 0) {
              console.log(`[update-descriptions] Skipping ${i + 1}/${total} — no trail match: ${act.name}`);
              continue;
            }

            console.log(`[update-descriptions] Updating ${i + 1}/${total}: ${act.name}`);
            const wasUpdated = await writeTrailDescription(
              userId,
              act.id,
              parseInt(act.strava_activity_id),
              matches,
              0,
              limiter
            );

            if (wasUpdated) {
              updated++;
              send("progress", {
                current: i + 1,
                total,
                updated,
                message: `Updated: ${act.name} (${matches.length} trail${matches.length !== 1 ? "s" : ""})`,
              });
            }
          } catch (err) {
            errors++;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[update-descriptions] Activity ${act.id}:`, message);

            if (err instanceof ScopeError) {
              send("scope_error", { message });
              break;
            }
          }
        }

        send("done", {
          total,
          updated,
          errors,
          message: `Done — updated ${updated} activit${updated !== 1 ? "ies" : "y"}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error";
        console.error("[update-descriptions] Fatal:", err);
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
