import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type PoolClient } from "pg";
import { pool } from "@/lib/db";
import { hasBasicAccess } from "@/lib/subscription";
import { getSubscriptionStatus } from "@/lib/subscription-db";

export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Gap-fill is part of the "basic" feature set (trial + active), locked
  // once a trial lapses into grace_period — see the 2026-09-30 feature-
  // gating request. TrailActions.tsx gates the button itself; this is
  // defense-in-depth against a direct request.
  if (!hasBasicAccess(await getSubscriptionStatus(userId))) {
    return NextResponse.json(
      { error: "Subscribe to unlock this feature", locked: true },
      { status: 403 }
    );
  }

  const fillAll = new URL(req.url).searchParams.get("all") === "true";

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '55000'");

    const { rows: [trail] } = await client.query<{ id: string; is_multipart: boolean }>(
      "SELECT id, GeometryType(geometry) = 'MULTILINESTRING' AS is_multipart FROM trails WHERE slug = $1",
      [params.slug]
    );
    if (!trail) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // The gap-detection query below (ST_LineLocatePoint, ST_LineSubstring,
    // ST_StartPoint/EndPoint for loop detection) is built entirely around a
    // single continuous LineString parameterised 0..1 along its length.
    // ~63% of trails (749/1,181) are genuinely multi-part MultiLineStrings
    // with real breaks between sections — confirmed ST_LineMerge doesn't
    // collapse any of them into one line, so these aren't a storage
    // artifact, they're actual gaps in the trail's own official route data.
    // ST_LineLocatePoint outright errors on MultiLineString input
    // ("1st arg isn't a line"), so running the query anyway would surface
    // that raw Postgres error to the user. Failing clearly here instead of
    // attempting a fix: correctly detecting/filling gaps across disconnected
    // parts needs the algorithm reworked to handle each part's own 0..1
    // range plus the boundaries between parts, not a quick patch — a wrong
    // attempt risks silently "filling" a gap that's an intentional break in
    // the trail (e.g. a ferry crossing or road diversion the route excludes).
    if (trail.is_multipart) {
      return NextResponse.json(
        {
          error:
            "This trail's route data has multiple disconnected sections, which gap-filling doesn't support yet. You can still mark individual sections as walked manually on the map.",
        },
        { status: 422 }
      );
    }

    // Delete existing auto-fills so re-running always reflects current GPS data
    await client.query(
      "DELETE FROM user_trail_manual_segments WHERE user_id = $1 AND trail_id = $2 AND segment_type = 'auto_gap_fill'",
      [userId, trail.id]
    );

    // Find gaps < 500 m between completed sections.
    //
    // Each piece of completed_geometry is projected onto the trail line by
    // locating its own start/end points (ST_LineLocatePoint) — no upfront
    // ST_Union/ST_LineMerge. Merging first is what broke closed-loop trails
    // (e.g. Yew Tree Way): if two completed pieces are joined end-to-end at
    // the loop's closure point, ST_LineMerge welds them into one LineString
    // that quietly bridges any real gap elsewhere on the loop, so the "gaps"
    // step below never even sees two separate pieces to compare.
    //
    // Two loop-specific issues get handled explicitly:
    //  - `could_wrap`/`direct_len` check: on a closed loop, fraction 0 and 1
    //    are the same physical point, so ST_LineLocatePoint can't tell them
    //    apart — a piece approaching the closure point from the "1.0" side
    //    locates as 0. Detected by comparing each piece's real length against
    //    what its naive [lo,hi] reading implies; a mismatch means it actually
    //    runs from `hi` up to 1.0, not from `lo` to `hi`.
    //  - edge_start_gap/edge_end_gap: gaps at the very start or end of a
    //    (non-loop) trail were never checked at all — the original query only
    //    ever compared completed pieces to each other, never to the trail's
    //    own fraction-0/fraction-1 endpoints.
    const { rows: gaps } = await client.query<{ gap_from: number; gap_to: number; gap_m: number }>(
      `WITH trail_geom AS (
         SELECT geometry, ST_Equals(ST_StartPoint(geometry), ST_EndPoint(geometry)) AS is_loop
         FROM trails WHERE id = $2
       ),
       pieces AS (
         SELECT (ST_Dump(completed_geometry)).geom AS seg
         FROM user_trail_progress
         WHERE user_id = $1 AND trail_id = $2 AND completed_geometry IS NOT NULL
       ),
       candidates AS (
         SELECT
           seg,
           ST_Length(seg::geography) AS seg_len,
           LEAST(
             ST_LineLocatePoint(tg.geometry, ST_StartPoint(seg)),
             ST_LineLocatePoint(tg.geometry, ST_EndPoint(seg))
           ) AS lo,
           GREATEST(
             ST_LineLocatePoint(tg.geometry, ST_StartPoint(seg)),
             ST_LineLocatePoint(tg.geometry, ST_EndPoint(seg))
           ) AS hi,
           tg.geometry AS tgeom,
           tg.is_loop AS is_loop
         FROM pieces CROSS JOIN trail_geom tg
         WHERE ST_Length(seg::geography) > 0
       ),
       resolved AS (
         SELECT
           seg_len, lo, hi, tgeom,
           ST_Length(ST_LineSubstring(tgeom, lo, hi)::geography) AS direct_len,
           (is_loop AND lo < 0.0005) AS could_wrap
         FROM candidates
       ),
       located AS (
         SELECT
           CASE WHEN could_wrap AND ABS(direct_len - seg_len) > GREATEST(seg_len * 0.1, 25)
                THEN hi ELSE lo END AS frac_start,
           CASE WHEN could_wrap AND ABS(direct_len - seg_len) > GREATEST(seg_len * 0.1, 25)
                THEN 1.0 ELSE hi END AS frac_end
         FROM resolved
       ),
       ordered AS (
         SELECT frac_start, frac_end,
           ROW_NUMBER() OVER (ORDER BY frac_start) AS rn
         FROM located
         WHERE frac_end > frac_start + 0.000001
       ),
       bounds AS (
         SELECT MIN(rn) AS min_rn, MAX(rn) AS max_rn FROM ordered
       ),
       internal_gaps AS (
         SELECT a.frac_end AS gap_from, b.frac_start AS gap_to
         FROM ordered a
         JOIN ordered b ON b.rn = a.rn + 1
         WHERE b.frac_start > a.frac_end + 0.00001
       ),
       edge_start_gap AS (
         SELECT 0::double precision AS gap_from, o.frac_start AS gap_to
         FROM ordered o, bounds b, trail_geom tg
         WHERE o.rn = b.min_rn AND NOT tg.is_loop AND o.frac_start > 0.00001
       ),
       edge_end_gap AS (
         SELECT o.frac_end AS gap_from, 1::double precision AS gap_to
         FROM ordered o, bounds b, trail_geom tg
         WHERE o.rn = b.max_rn AND NOT tg.is_loop AND o.frac_end < 0.99999
       ),
       gaps AS (
         SELECT gap_from, gap_to FROM internal_gaps
         UNION ALL SELECT gap_from, gap_to FROM edge_start_gap
         UNION ALL SELECT gap_from, gap_to FROM edge_end_gap
       )
       SELECT
         g.gap_from,
         g.gap_to,
         ST_Length(ST_LineSubstring(tg.geometry, g.gap_from, g.gap_to)::geography) AS gap_m
       FROM gaps g CROSS JOIN trail_geom tg
       WHERE ST_Length(ST_LineSubstring(tg.geometry, g.gap_from, g.gap_to)::geography) ${fillAll ? "> 0.01" : "BETWEEN 0.01 AND 500"}
       ORDER BY g.gap_from`,
      [userId, trail.id]
    );

    // Insert each small gap as an auto_gap_fill segment
    for (const gap of gaps) {
      await client.query(
        `INSERT INTO user_trail_manual_segments
           (user_id, trail_id, segment_type, geometry, start_fraction, end_fraction, gap_length_m)
         SELECT $1, $2, 'auto_gap_fill',
                ST_LineSubstring(t.geometry, $3, $4), $3, $4, $5
         FROM trails t WHERE t.id = $2`,
        [userId, trail.id, gap.gap_from, gap.gap_to, gap.gap_m]
      );
    }

    const manualData = await getManualSegmentsData(client, userId, trail.id);
    return NextResponse.json({ filledCount: gaps.length, ...manualData });
  } catch (err) {
    console.error("[fill-gaps]", err);
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    client.release();
  }
}

async function getManualSegmentsData(
  client: PoolClient,
  userId: string,
  trailId: string
) {
  const [geoRes, listRes] = await Promise.all([
    client.query<{ manual_geojson: object | null }>(
      `SELECT ST_AsGeoJSON(ST_Collect(geometry))::json AS manual_geojson
       FROM user_trail_manual_segments WHERE user_id = $1 AND trail_id = $2`,
      [userId, trailId]
    ),
    client.query<{ id: string; segment_type: string; length_m: number; created_at: string }>(
      `SELECT id, segment_type,
              round(ST_Length(geometry::geography))::int AS length_m,
              created_at
       FROM user_trail_manual_segments
       WHERE user_id = $1 AND trail_id = $2
       ORDER BY CASE WHEN segment_type = 'manual' THEN 0 ELSE 1 END, created_at ASC`,
      [userId, trailId]
    ),
  ]);
  return {
    manualSegmentsGeoJson: geoRes.rows[0]?.manual_geojson ?? null,
    manualSegments: listRes.rows,
  };
}
