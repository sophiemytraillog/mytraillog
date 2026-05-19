import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import {
  getValidAccessToken,
  decodePolylineToWKT,
  SYNC_ACTIVITY_TYPES,
  CYCLING_ACTIVITY_TYPES,
} from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
} from "@/lib/trail-descriptions";

export const dynamic = "force-dynamic";

const PER_PAGE = 30;
const PAGE_DELAY_MS = 2000;

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  start_date: string;
  map?: { summary_polyline?: string | null };
}

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
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
            )
          );
        } catch {
          // Client already disconnected — stop silently
        }
      };

      let fetched = 0;
      let saved = 0;

      try {
        const accessToken = await getValidAccessToken(userId);

        const { rows: [userPrefs] } = await pool.query<{ include_cycling: boolean; strava_description_updates: boolean }>(
          "SELECT include_cycling, strava_description_updates FROM users WHERE id = $1",
          [userId]
        );
        const allowedTypes = userPrefs?.include_cycling
          ? new Set([...Array.from(SYNC_ACTIVITY_TYPES), ...Array.from(CYCLING_ACTIVITY_TYPES)])
          : SYNC_ACTIVITY_TYPES;
        console.log("[sync] Got valid access token");

        // Saves a page of Strava activities; returns how many were newly inserted.
        // onNew is called with the Strava activity ID for each newly saved activity.
        const savePage = async (activities: StravaActivity[], onNew?: (id: number) => void): Promise<number> => {
          let pageNew = 0;
          for (const activity of activities) {
            const type = activity.sport_type || activity.type;
            if (!allowedTypes.has(type)) {
              console.log(`[sync]   SKIP "${activity.name}" — type "${type}"`);
              continue;
            }
            const wkt = decodePolylineToWKT(activity.map?.summary_polyline);
            const result = await pool.query(
              `INSERT INTO activities (
                 user_id, strava_activity_id, name, activity_type,
                 distance, moving_time, start_date, polyline, geometry
               ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
                 ST_GeomFromText($9, 4326))
               ON CONFLICT (strava_activity_id) DO NOTHING`,
              [
                userId, activity.id, activity.name, type,
                activity.distance, activity.moving_time, activity.start_date,
                activity.map?.summary_polyline ?? null, wkt,
              ]
            );
            if ((result.rowCount ?? 0) > 0) { pageNew++; onNew?.(activity.id); }
          }
          return pageNew;
        };

        const fetchPage = async (params: Record<string, string | number>) => {
          const url = new URL("https://www.strava.com/api/v3/athlete/activities");
          url.searchParams.set("per_page", String(PER_PAGE));
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
          console.log(`[sync] GET ${url.toString()}`);
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          console.log(`[sync] → HTTP ${res.status}`);
          if (res.status === 429) {
            send("error", { message: "Strava rate limit reached. Please try again in a few minutes." });
            await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
            return null; // signal rate-limit abort
          }
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`Strava API error ${res.status}: ${body}`);
          }
          return res.json() as Promise<StravaActivity[]>;
        };

        // Anchors for forward and backward passes
        const boundsRow = await pool.query<{ after_unix: string; before_unix: string; count: string }>(
          `SELECT EXTRACT(EPOCH FROM MAX(start_date))::bigint AS after_unix,
                  EXTRACT(EPOCH FROM MIN(start_date))::bigint AS before_unix,
                  COUNT(*)::text AS count
           FROM activities WHERE user_id = $1`,
          [userId]
        );
        const existingCount = parseInt(boundsRow.rows[0]?.count ?? "0");
        const afterUnix: number | null  = boundsRow.rows[0]?.after_unix  ? parseInt(boundsRow.rows[0].after_unix)  : null;
        const beforeUnix: number | null = boundsRow.rows[0]?.before_unix ? parseInt(boundsRow.rows[0].before_unix) : null;

        console.log(`[sync] DB has ${existingCount} activities.`,
          afterUnix  ? `Newest: ${new Date(afterUnix  * 1000).toISOString()}` : "empty",
          beforeUnix ? `Oldest: ${new Date(beforeUnix * 1000).toISOString()}` : ""
        );

        await pool.query("UPDATE users SET sync_status = 'syncing' WHERE id = $1", [userId]);

        send("progress", {
          fetched: 0, saved: 0,
          message: existingCount > 0 ? "Checking for new activities…" : "Starting sync…",
        });

        // ── Forward pass: activities newer than what we have ──────────────────
        for (let page = 1; ; page++) {
          if (request.signal.aborted) break;
          if (page > 1) await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

          const activities = await fetchPage(afterUnix !== null ? { page, after: afterUnix } : { page });
          if (activities === null) return; // rate-limited
          if (activities.length === 0) break;

          fetched += activities.length;
          saved += await savePage(activities);
          send("progress", { fetched, saved, message: `Syncing… ${fetched} fetched, ${saved} saved` });
          if (activities.length < PER_PAGE) break;
        }

        // ── Backward pass: fill any gap older than the oldest activity we have ─
        // Runs on first-ever sync (beforeUnix=null triggers a full walk) and whenever
        // the initial sync was interrupted before reaching the oldest Strava activities.
        let cursor = beforeUnix !== null ? beforeUnix - 1 : null;
        if (cursor !== null || existingCount === 0) {
          send("progress", { fetched, saved, message: "Checking for older activities…" });
          // For a totally empty DB, do a full backwards walk with no before limit on first page
          let firstBack = true;
          while (true) {
            if (request.signal.aborted) break;
            await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

            const params: Record<string, string | number> = {};
            if (cursor !== null) params.before = cursor;
            const activities = await fetchPage(params);
            if (activities === null) return;
            if (activities.length === 0) break;

              fetched += activities.length;
            saved += await savePage(activities);
            send("progress", { fetched, saved, message: `Backfilling… ${fetched} fetched, ${saved} saved` });

            // Advance cursor to just before the oldest activity on this page
            const oldest = activities[activities.length - 1].start_date;
            cursor = Math.floor(new Date(oldest).getTime() / 1000) - 1;
            if (activities.length < PER_PAGE) break;
          }
        }

        console.log(`[sync] All passes complete. fetched=${fetched} saved=${saved}`);

        // Notify the client and mark complete now — trail matching runs after so
        // the spinner doesn't block the user while it processes.
        await pool.query(
          `UPDATE users
           SET sync_status    = 'complete',
               last_synced_at = NOW()
           WHERE id = $1`,
          [userId]
        );

        send("done", {
          fetched,
          saved,
          message: `Sync complete — ${saved} activit${saved === 1 ? "y" : "ies"} saved`,
        });

        // Trail matching — runs after the client has been notified and closed the
        // connection, so it won't block the UI.
        let matchedTrails = 0;
        try {
          matchedTrails = await computeTrailProgress(userId);
        } catch (matchErr) {
          console.error("[sync/activities] Trail matching error:", matchErr);
        }

        // Description updates — likewise runs in the background after done.
        let descUpdated = 0;
        if (userPrefs?.strava_description_updates) {
          const { rows: toUpdate } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
            `SELECT id, strava_activity_id::text, name
             FROM activities
             WHERE user_id = $1
               AND geometry IS NOT NULL
               AND strava_description_updated = FALSE
             ORDER BY start_date DESC`,
            [userId]
          );
          if (toUpdate.length > 0) {
            for (const act of toUpdate) {
              try {
                const matches = await getActivityTrailMatches(userId, act.id);
                if (matches.length > 0) {
                  const updated = await writeTrailDescription(userId, act.id, parseInt(act.strava_activity_id), matches);
                  if (updated) descUpdated++;
                }
              } catch (err) {
                if (err instanceof ScopeError) {
                  console.warn("[sync] Scope error updating description — skipping remaining:", err.message);
                  break;
                }
                console.error("[sync] Description update error:", err);
              }
            }
          }
          console.log(`[sync] Description updates complete: ${descUpdated} updated`);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "An unexpected error occurred";
        console.error("[sync/activities] Fatal error:", err);

        await pool
          .query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId])
          .catch(() => {});

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
