import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import {
  getValidAccessToken,
  decodePolylineToWKT,
  CYCLING_ACTIVITY_TYPES,
} from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";

export const dynamic = "force-dynamic";

const PER_PAGE = 30;

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
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // Client disconnected
        }
      };

      let fetched = 0;
      let saved = 0;

      try {
        const accessToken = await getValidAccessToken(userId);

        const fetchPage = async (params: Record<string, string | number>) => {
          const url = new URL("https://www.strava.com/api/v3/athlete/activities");
          url.searchParams.set("per_page", String(PER_PAGE));
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (res.status === 429) {
            send("error", { message: "Strava rate limit reached. Please try again in a few minutes." });
            return null;
          }
          if (!res.ok) throw new Error(`Strava API error ${res.status}: ${await res.text()}`);
          return res.json() as Promise<StravaActivity[]>;
        };

        send("progress", { fetched: 0, saved: 0, message: "Fetching cycling activities from Strava…" });

        // Walk backward through all Strava history using cursor-based pagination.
        // Always fetch page=1 and advance the `before` timestamp — same pattern as
        // the main sync backward pass. Mixing `page` + `before` skips batches.
        let cursor: number | null = null;
        while (true) {
          if (request.signal.aborted) break;
          if (cursor !== null) await new Promise<void>((r) => setTimeout(r, 500));

          const params: Record<string, string | number> = {};
          if (cursor !== null) params.before = cursor;
          const activities = await fetchPage(params);
          if (activities === null) return;
          if (activities.length === 0) break;

          for (const activity of activities) {
            const type = activity.sport_type || activity.type;
            if (!CYCLING_ACTIVITY_TYPES.has(type)) continue;
            fetched++;
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
            if ((result.rowCount ?? 0) > 0) saved++;
          }

          send("progress", { fetched, saved, message: `Scanning… ${fetched} cycling activities found, ${saved} new` });

          const oldest = activities[activities.length - 1].start_date;
          cursor = Math.floor(new Date(oldest).getTime() / 1000) - 1;
          if (activities.length < PER_PAGE) break;
        }

        // Find only the trails that have at least one cycling activity nearby,
        // then re-match just those — avoids re-scanning every trail in the DB.
        const { rows: affectedTrails } = await pool.query<{ id: string }>(
          `SELECT DISTINCT t.id
           FROM trails t
           JOIN activities a ON ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
           WHERE a.user_id = $1
             AND a.activity_type = ANY($2::text[])
             AND a.geometry IS NOT NULL`,
          [userId, Array.from(CYCLING_ACTIVITY_TYPES)]
        );
        const trailIds = affectedTrails.map(r => r.id);

        send("matching", {
          message: trailIds.length > 0
            ? `Matching cycling activities to ${trailIds.length} trail${trailIds.length === 1 ? "" : "s"}…`
            : "No trail matches found",
        });

        let matchedTrails = 0;
        if (trailIds.length > 0) {
          try {
            matchedTrails = await computeTrailProgress(userId, trailIds);
          } catch (err) {
            console.error("[backfill-cycling] Trail matching error:", err);
          }
        }

        send("done", {
          fetched,
          saved,
          matchedTrails,
          message: saved > 0
            ? `Done — ${saved} cycling activit${saved === 1 ? "y" : "ies"} added`
            : "Done — no new cycling activities found",
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
