import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
} from "@/lib/trail-descriptions";

export const dynamic = "force-dynamic";
// Vercel Hobby plan hard-caps function duration at 60s — this cannot be
// raised without a plan upgrade, and vercel.json enforces the same value.
// The rate limiter and the time budget below both exit gracefully well
// before that on any single run; the client picks up where it left off on
// the next run because progress is checkpointed in the DB
// (activities.strava_description_updated), not in memory.
export const maxDuration = 60;
// Leaves margin for the discovery query, the final SSE write, and the
// stream close within the 60s ceiling.
const TIME_BUDGET_MS = 45_000;

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

  // Returns ms until n slots are available (0 = capacity available now).
  msUntilCapacity(n = 1): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length + n <= this.maxRequests) return 0;
    return this.windowMs - (now - this.timestamps[0]) + 50;
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
        const startedAt = Date.now();

        // Candidate activities come straight from the activity_trail_matches
        // cache (populated by computeTrailProgress — see match-trails.ts) instead
        // of re-running spatial queries against every matched trail on every
        // request. That recompute used to take 5+ minutes for power users and
        // blew Vercel's 60s cap before a single description could be written.
        // Oldest first — so each run makes progress on historical backfill
        // rather than re-checking recent activities that are already updated.
        const { rows: activities } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
          `SELECT DISTINCT a.id, a.strava_activity_id::text AS strava_activity_id, a.name
           FROM activities a
           JOIN activity_trail_matches atm ON atm.activity_id = a.id
           WHERE a.user_id = $1
             AND ($2 OR a.strava_description_updated = FALSE)
           ORDER BY a.strava_activity_id ASC`,
          [userId, force]
        );

        const total = activities.length;
        send("start", { total, message: `Found ${total} activities near your trails…` });

        const limiter = new RateLimiter(100);
        let updated = 0;
        let errors = 0;

        // Keepalive during the loop — prevents the connection going idle when
        // processing activities that have no trail matches (no progress events sent).
        const loopKeepalive = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch {}
        }, 10_000);

        try {
          for (let i = 0; i < activities.length; i++) {
            if (request.signal.aborted) break;

            // Stop well within Vercel's 60s ceiling and checkpoint — each activity
            // that gets updated already flips strava_description_updated, so the
            // next run's discovery query naturally picks up from here.
            if (Date.now() - startedAt > TIME_BUDGET_MS) {
              send("done", {
                total,
                updated,
                errors,
                message: `Time budget reached — ${updated} updated so far (${i} of ${total} checked). Run again to continue.`,
              });
              return;
            }

            // Stop gracefully if the Strava rate limit is exhausted — writeTrailDescription
            // uses 2 slots per activity. Blocking here for 900 s would kill the function.
            const waitMs = limiter.msUntilCapacity(2);
            if (waitMs > 0) {
              const mins = Math.ceil(waitMs / 60_000);
              send("done", {
                total,
                updated,
                errors,
                message: `Rate limit reached — ${updated} updated so far. Run again in ~${mins} min to continue.`,
              });
              return;
            }

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
                return;
              }
            }
          }
        } finally {
          clearInterval(loopKeepalive);
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
