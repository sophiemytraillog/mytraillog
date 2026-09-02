import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { waitUntil } from "@vercel/functions";
import { runSyncChunk, finishSync } from "@/lib/sync-engine";
import { pool } from "@/lib/db";
import { logSyncEvent } from "@/lib/sync-log";
import { triggerMatchChain } from "@/lib/match-chain";
import { triggerDescriptionChain } from "@/lib/description-chain";

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
          // Tell the client to continue immediately — it closes this
          // EventSource and opens a fresh one for the next chunk right
          // away (see SyncButton's "partial" handler), so it never waits
          // on what happens after this point.
          send("partial", {
            fetched: result.fetched,
            saved: result.saved,
            message: `Syncing… ${result.fetched} fetched, ${result.saved} saved so far`,
          });

          // Run matching for whatever THIS chunk saved, not just on the
          // final "complete" chunk — still within this same function
          // invocation (bounded by the overall 60s ceiling either way), but
          // after send() so it doesn't delay the client's next chunk.
          // Root cause of matches silently going missing for multi-chunk
          // syncs: newDbIds only ever held the CURRENT chunk's activities
          // (each chunk is a fresh runSyncChunk() call with its own
          // in-memory array, nothing persisted across chunks). Only calling
          // finishSync on "complete" meant every activity saved by an
          // earlier chunk that never got revisited — e.g. because the
          // browser tab closed mid-sync — was saved to the DB but never
          // matched against any trail. Matching every chunk, partial or
          // not, makes each chunk's activities count on their own, so a
          // sync that never reaches "complete" still leaves the user with
          // real matches for whatever did get fetched, instead of zero.
          await finishSync(userId, result.newDbIds).catch((err) => {
            console.error("[sync/activities] finishSync on partial chunk failed:", err);
          });
          return;
        }

        if (result.status === "rate_limited" || result.status === "error" || result.status === "subscription_required") {
          send("error", { message: result.message });
          return;
        }

        // status === "complete" with nothing new saved — there is nothing
        // for trail matching to do (finishSync itself would no-op on an
        // empty newDbIds anyway), so skip it and the whole-account
        // verification query entirely rather than pay for work with no
        // possible effect.
        //
        // Root cause of the "hangs on updating trail progress" reports
        // (Sophie, then Glen): SyncButton's "done" handler was closing the
        // EventSource immediately on receipt, before the "matched" event
        // this route sends afterward — server-side matching was never
        // actually slow, "matched" just silently never arrived, since
        // send()'s own try/catch swallows a write to an already-closed
        // connection as a normal disconnect. Fixed on the client too (it
        // now waits for "matched"/"error" to close), but sending "done"
        // and "matched" here as one synchronous pair — no `await` between
        // them — is extra insurance for this specific path: nothing yields
        // back to the event loop in between, so there's no window for a
        // client-side close to land before the server's already sent both.
        if (result.saved === 0) {
          send("done", {
            fetched: result.fetched,
            saved: result.saved,
            message: "Sync complete - already up to date",
          });
          send("matched", { matchedTrails: 0, message: "Sync complete - already up to date" });
          // Nothing new to match from THIS sync, but a previous sync could
          // still have left deferred trails unchecked (finishSync's own
          // inline pass is capped — see MAX_TRAILS_PER_FINISH_SYNC) — catch
          // those up now via the same background chain as below, rather
          // than only ever resuming when the user happens to have new
          // activities to sync.
          waitUntil(triggerMatchChain(userId));
          // Same idea for the description backlog — a previous sync/webhook
          // could have left activities with confirmed trail matches but no
          // description written (see description-chain.ts).
          waitUntil(triggerDescriptionChain(userId, "sync"));
          return;
        }

        // matching/description-writing runs after the client has been
        // notified, so it won't block the "done" UI update.
        send("done", {
          fetched: result.fetched,
          saved: result.saved,
          message: `Sync complete - ${result.saved} activit${result.saved === 1 ? "y" : "ies"} saved`,
        });

        const { matchedTrails } = await finishSync(userId, result.newDbIds);

        // Whole-account verification, not just this chunk: a user whose
        // activities all have geometry but ended up with zero trail
        // matches anywhere is worth flagging for review, even though it
        // can legitimately happen (their routes genuinely don't overlap
        // any trail in the database).
        try {
          const { rows: [counts] } = await pool.query<{ geom_count: string; match_count: string }>(
            `SELECT
               (SELECT COUNT(*) FROM activities WHERE user_id = $1 AND geometry IS NOT NULL) AS geom_count,
               (SELECT COUNT(*) FROM user_trail_progress WHERE user_id = $1) AS match_count`,
            [userId]
          );
          if (parseInt(counts.geom_count) > 0 && parseInt(counts.match_count) === 0) {
            logSyncEvent(userId, "sync_anomaly", {
              reason: "account_has_geometry_but_zero_trail_matches",
              activitiesWithGeometry: parseInt(counts.geom_count),
            });
          }
        } catch (err) {
          console.error("[sync/activities] Post-sync verification query failed:", err);
        }

        // Sent once trail matching (and description writes) have actually
        // landed in the DB — the client waits for this before refreshing the
        // dashboard, otherwise it re-reads stats mid-match and shows stale
        // stat cards right after a sync that visibly said "done".
        send("matched", {
          matchedTrails,
          message: "Trail progress updated",
        });

        // finishSync's own inline pass just matched the first
        // MAX_TRAILS_PER_FINISH_SYNC trails nearby this sync's activities —
        // continue through whatever's left of the full ~1,181-trail catalog
        // in the background, independent of this connection. waitUntil()
        // keeps this request's function invocation alive long enough to
        // dispatch (not run) the first chained hop, same pattern as the
        // Strava webhook's handleNewActivity — closing this tab right now
        // doesn't stop it.
        waitUntil(triggerMatchChain(userId));
        // Trail matching that lands here (or later, as the chain above
        // continues) can make activities newly eligible for a description
        // write — catch those up in the background too, same pattern.
        waitUntil(triggerDescriptionChain(userId, "sync"));
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
