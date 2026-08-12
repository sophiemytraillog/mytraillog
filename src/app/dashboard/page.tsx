import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import DashboardClient, { type TrailRow } from "./DashboardClient";

interface Athlete {
  id: number;
  firstname: string;
  lastname: string;
  username: string;
  profile: string;
}

interface UserStats {
  last_synced_at: Date | null;
  sync_status: string;
  activity_count: string;
}

// A sync that's been sitting in "syncing" with no heartbeat for this long
// has almost certainly been abandoned client-side (browser tab closed,
// navigated away, backgrounded on mobile) partway through a multi-chunk
// sync — there's no server-side process that would still be running after
// this much silence. Comfortably longer than one chunk's ~45s budget plus
// margin for Strava API latency, short enough that a genuinely still-active
// sync's own next heartbeat (after every fetched page) resets the clock
// well before this fires.
const STALE_SYNC_THRESHOLD_MINUTES = 3;

export default async function Dashboard({
  searchParams,
}: {
  searchParams?: { autoSync?: string };
}) {
  const cookieStore = cookies();
  const athleteCookie = cookieStore.get("strava_athlete");
  const userId = cookieStore.get("strava_user_id")?.value;

  if (!athleteCookie) redirect("/");

  const athlete: Athlete = JSON.parse(athleteCookie.value);
  const requestedAutoSync = searchParams?.autoSync === "true";

  let stats: UserStats | null = null;
  let stravaDescriptionUpdates = false;
  let descriptionMode: "full" | "new_only" | "new_with_totals" = "full";
  let stravaScope: string | null = null;
  let includeCycling = false;
  let staleSync = false;
  if (userId) {
    try {
      const result = await query<
        UserStats & {
          strava_description_updates: boolean;
          description_mode: "full" | "new_only" | "new_with_totals";
          strava_scope: string | null;
          include_cycling: boolean;
          stale_sync: boolean;
        }
      >(
        `SELECT u.last_synced_at,
                u.sync_status,
                u.strava_description_updates,
                u.description_mode,
                u.strava_scope,
                u.include_cycling,
                (u.sync_status = 'syncing'
                  AND u.sync_progress_at < NOW() - INTERVAL '${STALE_SYNC_THRESHOLD_MINUTES} minutes'
                ) AS stale_sync,
                COUNT(a.id)::text AS activity_count
         FROM users u
         LEFT JOIN activities a ON a.user_id = u.id
         WHERE u.id = $1
         GROUP BY u.last_synced_at, u.sync_status, u.strava_description_updates,
                  u.description_mode, u.strava_scope, u.include_cycling, u.sync_progress_at`,
        [userId]
      );
      stats = result.rows[0] ?? null;
      stravaDescriptionUpdates = result.rows[0]?.strava_description_updates ?? false;
      descriptionMode = result.rows[0]?.description_mode ?? "full";
      stravaScope = result.rows[0]?.strava_scope ?? null;
      includeCycling = result.rows[0]?.include_cycling ?? false;
      staleSync = result.rows[0]?.stale_sync ?? false;
    } catch (err) {
      console.error("[dashboard] Failed to load stats:", err);
    }
  }

  // Self-heal nudge: resume automatically on this visit if the last sync
  // attempt looks abandoned, exactly as if the user had clicked "Sync
  // Activities" themselves — runSyncChunk resumes from wherever the stored
  // activities' MIN/MAX(start_date) bounds left off, so this is always safe
  // to re-fire, never re-fetches from scratch.
  const autoSync = requestedAutoSync || staleSync;

  const activityCount = parseInt(stats?.activity_count ?? "0");

  let trails: TrailRow[] = [];
  if (userId) {
    try {
      const trailResult = await query<TrailRow>(
        `SELECT
           t.id,
           t.slug,
           t.name,
           t.region,
           t.total_distance,
           t.parent_trail_id,
           LEAST(
             CASE WHEN t.total_distance > 0
               THEN (COALESCE(utp.completed_distance, 0) + COALESCE(ms.manual_m, 0))
                    / t.total_distance * 100
               ELSE COALESCE(utp.completion_percentage, 0) END,
             100
           )                                                                         AS completion_percentage,
           LEAST(
             COALESCE(utp.completed_distance, 0) + COALESCE(ms.manual_m, 0),
             t.total_distance
           )                                                                         AS completed_distance,
           utp.activity_count,
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(t.geometry, 0.005))::json        AS trail_geojson,
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(utp.completed_geometry, 0.005))::json AS completed_geojson,
           COALESCE(t.category, 'national_trail')                                   AS category
         FROM trails t
         LEFT JOIN user_trail_progress utp
           ON utp.trail_id = t.id AND utp.user_id = $1
         LEFT JOIN (
           SELECT trail_id, SUM(ST_Length(geometry::geography)) AS manual_m
           FROM user_trail_manual_segments
           WHERE user_id = $1
           GROUP BY trail_id
         ) ms ON ms.trail_id = t.id
         ORDER BY
           completion_percentage DESC,
           t.name ASC`,
        [userId]
      );
      trails = trailResult.rows;
    } catch (err) {
      console.error("[dashboard] Failed to load trail progress:", err);
    }
  }

  return (
    <DashboardClient
      athlete={athlete}
      stats={stats}
      trails={trails}
      activityCount={activityCount}
      autoSync={autoSync}
      stravaDescriptionUpdates={stravaDescriptionUpdates}
      descriptionMode={descriptionMode}
      hasWriteScope={stravaScope?.includes("activity:write") ?? false}
      includeCycling={includeCycling}
    />
  );
}
