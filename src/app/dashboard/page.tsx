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
  const autoSync = searchParams?.autoSync === "true";

  let stats: UserStats | null = null;
  let stravaDescriptionUpdates = false;
  let stravaScope: string | null = null;
  let includeCycling = false;
  if (userId) {
    try {
      const result = await query<UserStats & { strava_description_updates: boolean; strava_scope: string | null; include_cycling: boolean }>(
        `SELECT u.last_synced_at,
                u.sync_status,
                u.strava_description_updates,
                u.strava_scope,
                u.include_cycling,
                COUNT(a.id)::text AS activity_count
         FROM users u
         LEFT JOIN activities a ON a.user_id = u.id
         WHERE u.id = $1
         GROUP BY u.last_synced_at, u.sync_status, u.strava_description_updates, u.strava_scope, u.include_cycling`,
        [userId]
      );
      stats = result.rows[0] ?? null;
      stravaDescriptionUpdates = result.rows[0]?.strava_description_updates ?? false;
      stravaScope = result.rows[0]?.strava_scope ?? null;
      includeCycling = result.rows[0]?.include_cycling ?? false;
    } catch (err) {
      console.error("[dashboard] Failed to load stats:", err);
    }
  }

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
      hasWriteScope={stravaScope?.includes("activity:write") ?? false}
      includeCycling={includeCycling}
    />
  );
}
