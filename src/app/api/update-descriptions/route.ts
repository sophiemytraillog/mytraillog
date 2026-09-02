import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { hasPremiumAccess } from "@/lib/subscription";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  recordDescriptionUpdateFailure,
  reserveBackfillSlot,
  RateLimiter,
  ScopeError,
  StravaRateLimitError,
  NEW_GROUND_THRESHOLD_M,
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

// reserveBackfillSlot and RateLimiter live in trail-descriptions.ts now,
// shared with the automatic background chain and the daily cron sweep — see
// processDescriptionBatch there. This route keeps its own SSE-streaming loop
// (per-activity progress events the manual "Update historical activity
// descriptions" button needs) rather than calling that shared batch function
// directly, but reserveBackfillSlot's DB row means the daily budget is still
// correctly shared across every caller regardless.

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

        // Historical description backfill is paid-only (2026-09-30 feature
        // gating) — unlike sync/matching/new-activity descriptions, trial
        // users don't get this one. UpdateDescriptionsButton.tsx gates the
        // UI itself so this route is never normally called without premium
        // access; this is defense-in-depth against a direct request.
        const { rows: [statusRow] } = await pool.query<{ subscription_status: string }>(
          "SELECT subscription_status FROM users WHERE id = $1",
          [userId]
        );
        if (!statusRow || !hasPremiumAccess(statusRow.subscription_status)) {
          send("error", { message: "Historical descriptions are a premium feature - subscribe to unlock" });
          return;
        }

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
        // Newest first, same as processDescriptionBatch's automatic chain —
        // kept consistent with that query rather than leaving this route as a
        // second, differently-ordered copy of the same backlog scan. Was
        // oldest-first; a user clicking this and expecting their most recent
        // activity to be covered shouldn't have to wait behind years of
        // untouched history first.
        const { rows: activities } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
          `SELECT DISTINCT a.id, a.strava_activity_id, a.name
           FROM activities a
           JOIN activity_trail_matches atm ON atm.activity_id = a.id
           WHERE a.user_id = $1
             AND ($2 OR a.strava_description_updated = FALSE)
           ORDER BY a.strava_activity_id DESC`,
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
                message: `Updated ${updated} of ${i} checked - ${remaining} remaining. Run again to continue.`,
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
                message: `Updated ${updated} of ${i} checked - ${remaining} remaining. Strava rate limit reached, run again in ~${mins} min to continue.`,
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

              // matches.length === 0 is ambiguous — getActivityTrailMatches
              // only returns a trail once user_trail_progress has a real row
              // for it, so this can mean either "activity_trail_matches was
              // a false positive" (coarse simplified-geometry candidate) or
              // "matching hasn't landed a progress row for this activity's
              // trails yet". Confirmed on Amy's account: marking this
              // checked closed the door on ever writing a real description
              // once matching did catch up, permanently — this backlog scan
              // can't rediscover an activity once it's flagged done. Leave
              // it false and move on to the next candidate; a future run of
              // this same scan will re-check it once matching has finished.
              if (matches.length === 0) {
                console.log(`[update-descriptions] Skipping ${i + 1}/${total} for now — no confirmed trail match yet: ${act.name}`);
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
                  message: `Updated ${updated} of ${i} checked - ${remaining} remaining. Daily backfill pacing limit reached - more opens up gradually through the day. Run again later.`,
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
                // wasUpdated now also covers "stripped a stale block down
                // to nothing relevant" (mode filtering left zero trails),
                // not just "wrote N trails" — recompute here purely for
                // this progress message, same filter writeTrailDescription
                // applies internally.
                const relevantCount = (mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > NEW_GROUND_THRESHOLD_M)).length;
                send("progress", {
                  current: i + 1,
                  total,
                  updated,
                  message: relevantCount > 0
                    ? `Updated: ${act.name} (${relevantCount} trail${relevantCount !== 1 ? "s" : ""})`
                    : `Cleared stale trail info: ${act.name}`,
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
                  message: `Updated ${updated} of ${i} checked - ${remaining} remaining. Strava rate limit reached, run again in ~${mins} min to continue.`,
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

              // Generic failure — most commonly Strava itself erroring on
              // this specific activity (confirmed: a persistent 500 on
              // GET, reproducible every attempt, not transient). Bounded
              // retry so a permanently-broken activity can't sit at the
              // front of the backlog query forever, blocking every future
              // run from ever reaching real progress.
              const { giveUp, attempts } = await recordDescriptionUpdateFailure(userId, act.id);
              if (giveUp) {
                console.warn(
                  `[update-descriptions] Giving up on ${act.id} after ${attempts} failed attempts — marking checked`
                );
                await pool.query(
                  "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
                  [act.id]
                ).catch(() => {});
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
          message: `Done - updated ${updated} activit${updated !== 1 ? "ies" : "y"}, nothing left to check`,
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
