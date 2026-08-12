import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
  StravaRateLimitError,
  type DescriptionMode,
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

// Strava's rate limit is enforced per-application across every user combined
// (see StravaRateLimitError) — this backlog scan is the one feature that can
// burn through it fastest, so it gets its own fixed daily share rather than
// competing with normal syncs/webhooks/new-activity processing for whatever's
// left. 250 updates/day ≈ 500 calls/day (GET+PUT per update), leaving the
// remaining ~1,500 of the app's ~2,000/day quota free for everything else.
const DAILY_UPDATE_BUDGET = 250;

// Reserves one attempt against the app-wide daily backfill budget, paced
// evenly across the day (via an elapsed-fraction ceiling) rather than
// spendable in one burst — otherwise the first user to click "Update
// historical descriptions" each day could burn the whole thing in minutes.
// Atomic: the conditional UPDATE means concurrent requests can't both
// reserve past the ceiling.
async function reserveBackfillSlot(): Promise<boolean> {
  const now = new Date();
  const startOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fractionOfDayElapsed = (now.getTime() - startOfDayUTC) / (24 * 60 * 60 * 1000);
  const allowedSoFar = Math.max(1, Math.floor(DAILY_UPDATE_BUDGET * fractionOfDayElapsed));

  const { rows } = await pool.query<{ calls_used: number }>(
    `INSERT INTO backfill_api_usage (usage_date, calls_used) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (usage_date) DO UPDATE
       SET calls_used = backfill_api_usage.calls_used + 1
       WHERE backfill_api_usage.calls_used < $1
     RETURNING calls_used`,
    [allowedSoFar]
  );
  return rows.length > 0;
}

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

        const { rows: [userPrefs] } = await pool.query<{ description_mode: DescriptionMode }>(
          "SELECT description_mode FROM users WHERE id = $1",
          [userId]
        );
        const mode: DescriptionMode = userPrefs?.description_mode ?? "full";

        // Candidate activities come straight from the activity_trail_matches
        // cache (populated by computeTrailProgress — see match-trails.ts) instead
        // of re-running spatial queries against every matched trail on every
        // request. That recompute used to take 5+ minutes for power users and
        // blew Vercel's 60s cap before a single description could be written.
        // Oldest first — so each run makes progress on historical backfill
        // rather than re-checking recent activities that are already updated.
        const { rows: activities } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
          `SELECT DISTINCT a.id, a.strava_activity_id, a.name
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
              const remaining = total - i;
              send("done", {
                total,
                updated,
                errors,
                remaining,
                message: `Updated ${updated} of ${i} checked — ${remaining} remaining. Run again to continue.`,
              });
              return;
            }

            // Stop gracefully if the Strava rate limit is exhausted — writeTrailDescription
            // uses 2 slots per activity. Blocking here for 900 s would kill the function.
            const waitMs = limiter.msUntilCapacity(2);
            if (waitMs > 0) {
              const mins = Math.ceil(waitMs / 60_000);
              const remaining = total - i;
              send("done", {
                total,
                updated,
                errors,
                remaining,
                message: `Updated ${updated} of ${i} checked — ${remaining} remaining. Strava rate limit reached, run again in ~${mins} min to continue.`,
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
              // new_trail_distance_m is derived from this activity's own
              // (permanent) start_date, so this result can never change
              // later — safe to pre-filter here and skip the Strava-calling
              // path (and its backfill-budget cost) entirely for anything
              // new_only/new_with_totals would end up writing nothing for.
              const relevantMatches = mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > 0);

              if (relevantMatches.length === 0) {
                console.log(`[update-descriptions] Skipping ${i + 1}/${total} — no trail match: ${act.name}`);
                // activity_trail_matches is a coarse candidate list (simplified
                // trail geometry) — this activity was either a false positive
                // there, or (new_only/new_with_totals) matched but covered no
                // new ground. Mark it checked anyway so it doesn't keep
                // reappearing at the front of the queue on every future run,
                // blocking progress on the rest of the backlog.
                await pool.query(
                  "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
                  [act.id]
                ).catch(() => {});
                continue;
              }

              // Only real Strava-calling attempts count against the daily
              // backfill budget — checking for a match above is DB-only.
              if (!(await reserveBackfillSlot())) {
                const remaining = total - i;
                send("done", {
                  total,
                  updated,
                  errors,
                  remaining,
                  message: `Updated ${updated} of ${i} checked — ${remaining} remaining. Daily backfill pacing limit reached — more opens up gradually through the day. Run again later.`,
                });
                return;
              }

              console.log(`[update-descriptions] Updating ${i + 1}/${total}: ${act.name}`);
              const wasUpdated = await writeTrailDescription(
                userId,
                act.id,
                parseInt(act.strava_activity_id),
                matches,
                mode,
                0,
                limiter
              );

              if (wasUpdated) {
                updated++;
                send("progress", {
                  current: i + 1,
                  total,
                  updated,
                  message: `Updated: ${act.name} (${relevantMatches.length} trail${relevantMatches.length !== 1 ? "s" : ""})`,
                });
              }
            } catch (err) {
              if (err instanceof StravaRateLimitError) {
                // Our own limiter thought there was capacity, but Strava disagreed
                // (it resets every invocation and can't see other recent runs).
                // Stop cleanly instead of retrying — this activity's checkpoint
                // wasn't written, so the next run picks it back up.
                const mins = Math.ceil(err.retryAfterSeconds / 60);
                const remaining = total - i;
                send("done", {
                  total,
                  updated,
                  errors,
                  remaining,
                  message: `Updated ${updated} of ${i} checked — ${remaining} remaining. Strava rate limit reached, run again in ~${mins} min to continue.`,
                });
                return;
              }

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
          remaining: 0,
          message: `Done — updated ${updated} activit${updated !== 1 ? "ies" : "y"}, nothing left to check`,
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
