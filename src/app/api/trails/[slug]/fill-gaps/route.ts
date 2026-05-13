import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type PoolClient } from "pg";
import { pool } from "@/lib/db";

export async function POST(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const fillAll = new URL(req.url).searchParams.get("all") === "true";

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '30000'");

    const { rows: [trail] } = await client.query<{ id: string }>(
      "SELECT id FROM trails WHERE slug = $1",
      [params.slug]
    );
    if (!trail) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Delete existing auto-fills so re-running always reflects current GPS data
    await client.query(
      "DELETE FROM user_trail_manual_segments WHERE user_id = $1 AND trail_id = $2 AND segment_type = 'auto_gap_fill'",
      [userId, trail.id]
    );

    // Find gaps < 500 m between completed sections
    const { rows: gaps } = await client.query<{ gap_from: number; gap_to: number; gap_m: number }>(
      `WITH trail_geom AS (
         SELECT geometry FROM trails WHERE id = $2
       ),
       merged_segs AS (
         SELECT (ST_Dump(ST_LineMerge(ST_Union(completed_geometry::geometry)))).geom AS seg
         FROM user_trail_progress
         WHERE user_id = $1 AND trail_id = $2 AND completed_geometry IS NOT NULL
       ),
       located AS (
         SELECT
           LEAST(
             ST_LineLocatePoint(tg.geometry, ST_StartPoint(ms.seg)),
             ST_LineLocatePoint(tg.geometry, ST_EndPoint(ms.seg))
           ) AS frac_start,
           GREATEST(
             ST_LineLocatePoint(tg.geometry, ST_StartPoint(ms.seg)),
             ST_LineLocatePoint(tg.geometry, ST_EndPoint(ms.seg))
           ) AS frac_end
         FROM merged_segs ms CROSS JOIN trail_geom tg
       ),
       ordered AS (
         SELECT frac_start, frac_end,
           ROW_NUMBER() OVER (ORDER BY frac_start) AS rn
         FROM located
         WHERE frac_end > frac_start + 0.000001
       ),
       gaps AS (
         SELECT a.frac_end AS gap_from, b.frac_start AS gap_to
         FROM ordered a
         JOIN ordered b ON b.rn = a.rn + 1
         WHERE b.frac_start > a.frac_end + 0.00001
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
