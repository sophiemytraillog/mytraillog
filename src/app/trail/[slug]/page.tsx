import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { query, pool } from "@/lib/db";
import { CYCLING_ACTIVITY_TYPES } from "@/lib/strava";
import { hasBasicAccess } from "@/lib/subscription";
import TrailActions, { type ManualSegment } from "./TrailActions";
import TrailStats from "./TrailStats";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TrailDetail {
  id: string;
  name: string;
  slug: string;
  region: string;
  description: string | null;
  total_distance: number;
  trail_geojson: object;
  completed_distance: number | null;
  completion_percentage: number | null;
  activity_count: number | null;
  first_activity_date: Date | null;
  last_activity_date: Date | null;
  completed_geojson: object | null;
}

interface ActivityRow {
  id: string;
  name: string;
  activity_type: string;
  start_date: Date;
  activity_distance_m: number;
  strava_activity_id: string;
  trail_contribution_m: number;
  activity_trail_geojson: object | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// ── Page ───────────────────────────────────────────────────────────────────────

export default async function TrailDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) redirect("/");

  const [trailResult, userPrefsResult] = await Promise.all([
    query<TrailDetail>(
      `SELECT
         t.id, t.name, t.slug, t.region, t.description, t.total_distance,
         ST_AsGeoJSON(t.geometry)::json          AS trail_geojson,
         utp.completed_distance,
         utp.completion_percentage,
         utp.activity_count,
         utp.first_activity_date,
         utp.last_activity_date,
         ST_AsGeoJSON(utp.completed_geometry)::json AS completed_geojson
       FROM trails t
       LEFT JOIN user_trail_progress utp
         ON utp.trail_id = t.id AND utp.user_id = $1
       WHERE t.slug = $2`,
      [userId, params.slug]
    ),
    query<{ include_cycling: boolean; subscription_status: string }>(
      "SELECT include_cycling, subscription_status FROM users WHERE id = $1",
      [userId]
    ),
  ]);

  if (trailResult.rows.length === 0) notFound();
  const trail = trailResult.rows[0];
  const includeCycling = userPrefsResult.rows[0]?.include_cycling ?? false;
  // Gap-fill/mark-complete/manual-segment are basic-tier features (trial +
  // active) — locked once a trial lapses into grace_period. See the
  // 2026-09-30 feature-gating request; TrailActions.tsx does the actual
  // rendering, the API routes it calls do the real enforcement.
  const basicAccess = hasBasicAccess(userPrefsResult.rows[0]?.subscription_status);

  const [manualGeoResult, manualListResult] = await Promise.all([
    query<{ manual_geojson: object | null; manual_distance_m: number }>(
      `SELECT ST_AsGeoJSON(ST_Collect(geometry))::json AS manual_geojson,
              COALESCE(SUM(ST_Length(geometry::geography)), 0) AS manual_distance_m
       FROM user_trail_manual_segments
       WHERE user_id = $1 AND trail_id = $2`,
      [userId, trail.id]
    ),
    query<ManualSegment>(
      `SELECT id, segment_type,
              round(ST_Length(geometry::geography))::int AS length_m,
              created_at
       FROM user_trail_manual_segments
       WHERE user_id = $1 AND trail_id = $2
       ORDER BY CASE WHEN segment_type = 'manual' THEN 0 ELSE 1 END, created_at ASC`,
      [userId, trail.id]
    ),
  ]);

  const manualGeoJson = manualGeoResult.rows[0]?.manual_geojson ?? null;
  const manualSegments = manualListResult.rows;
  const manualDistanceM = manualGeoResult.rows[0]?.manual_distance_m ?? 0;

  let activities: ActivityRow[] = [];
  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '30000'");
    const actResult = await client.query<ActivityRow>(
      `SELECT
         a.id,
         a.name,
         a.activity_type,
         a.start_date,
         a.distance                              AS activity_distance_m,
         a.strava_activity_id::text              AS strava_activity_id,
         round(
           ST_Length(
             ST_CollectionExtract(
               ST_Intersection(
                 ST_SimplifyPreserveTopology(t.geometry, 0.001),
                 ST_Buffer(a.geometry::geography, 50)::geometry
               ),
               2
             )::geography
           )
         )::int                                  AS trail_contribution_m,
         ST_AsGeoJSON(
           ST_CollectionExtract(
             ST_Intersection(
               a.geometry,
               ST_Buffer(t.geometry::geography, 50)::geometry
             ),
             2
           )
         )::json                                 AS activity_trail_geojson
       FROM activities a
       CROSS JOIN (SELECT geometry FROM trails WHERE slug = $2) t
       WHERE a.user_id = $1
         AND a.geometry IS NOT NULL
         AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
         AND ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
       ORDER BY a.start_date DESC`,
      [userId, params.slug, includeCycling, Array.from(CYCLING_ACTIVITY_TYPES)]
    );
    activities = actResult.rows;
  } catch (err) {
    console.error("[trail/detail] Activity contributions query failed:", err);
  } finally {
    client.release();
  }

  const effectiveCompletedM = Math.min(
    (trail.completed_distance ?? 0) + manualDistanceM,
    trail.total_distance
  );
  const pct = trail.total_distance > 0
    ? Math.min(Math.round((effectiveCompletedM / trail.total_distance) * 100), 100)
    : 0;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="px-5 py-4 flex items-center gap-3 border-b border-[#E5DED4]">
        <Link
          href="/dashboard"
          className="flex items-center gap-1.5 text-[#C4652A]/70 hover:text-[#C4652A] text-sm transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
          </svg>
          Dashboard
        </Link>
        <span className="text-[#8A7F72]/50">·</span>
        <span className="text-[#2C2520] text-sm font-medium truncate">{trail.name}</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/strava/api_logo_pwrdBy_strava_horiz_orange.svg"
          alt="Powered by Strava"
          className="ml-auto shrink-0"
          style={{ height: "20px", width: "auto" }}
        />
      </nav>

      <div className="flex-1 px-5 pb-12 max-w-2xl mx-auto w-full">

        <TrailActions
          trailSlug={trail.slug}
          trailGeoJson={trail.trail_geojson}
          completedGeoJson={trail.completed_geojson}
          initialManualGeoJson={manualGeoJson}
          initialManualSegments={manualSegments}
          hasProgress={pct > 0}
          activities={activities}
          hasBasicAccess={basicAccess}
        >
          {/* Trail header */}
          <div className="mb-5 mt-5">
            <h1 className="text-2xl font-bold text-[#2C2520] tracking-tight">{trail.name}</h1>
            <p className="text-[#8A7F72] text-sm mt-0.5">{trail.region}</p>
          </div>

          <TrailStats
            completedM={effectiveCompletedM}
            totalDistM={trail.total_distance}
            activityCount={trail.activity_count ?? 0}
            pct={pct}
            activities={activities}
          />
        </TrailActions>
      </div>

      {/* Footer */}
      <footer className="border-t border-[#E5DED4] py-4 px-5">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <Link href="/dashboard" className="text-xs text-[#8A7F72] hover:text-[#2C2520] transition-colors">
            My Trail Log
          </Link>
          <div className="flex items-center gap-4 text-[#8A7F72]/60 text-xs">
            <Link href="/privacy" className="hover:text-[#8A7F72] transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-[#8A7F72] transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

