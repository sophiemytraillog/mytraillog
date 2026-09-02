import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type PoolClient } from "pg";
import { pool } from "@/lib/db";
import { hasBasicAccess } from "@/lib/subscription";
import { getSubscriptionStatus } from "@/lib/subscription-db";

export async function POST(
  req: Request,
  { params }: { params: { slug: string } }
) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Same basic-feature gate as fill-gaps/route.ts — see its comment.
  if (!hasBasicAccess(await getSubscriptionStatus(userId))) {
    return NextResponse.json(
      { error: "Subscribe to unlock this feature", locked: true },
      { status: 403 }
    );
  }

  let pointA: [number, number], pointB: [number, number];
  try {
    const body = await req.json();
    pointA = body.pointA;
    pointB = body.pointB;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const [lonA, latA] = pointA;
  const [lonB, latB] = pointB;

  if (
    !Number.isFinite(lonA) || !Number.isFinite(latA) ||
    !Number.isFinite(lonB) || !Number.isFinite(latB) ||
    Math.abs(lonA) > 180 || Math.abs(latA) > 90 ||
    Math.abs(lonB) > 180 || Math.abs(latB) > 90
  ) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15000'");

    const { rows: [trail] } = await client.query<{ id: string }>(
      "SELECT id FROM trails WHERE slug = $1",
      [params.slug]
    );
    if (!trail) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Locate both clicked points on the trail, extract the subsegment between them
    const { rows } = await client.query<{ id: string }>(
      `WITH fracs AS (
         SELECT
           LEAST(
             ST_LineLocatePoint(t.geometry, ST_SetSRID(ST_Point($3, $4), 4326)),
             ST_LineLocatePoint(t.geometry, ST_SetSRID(ST_Point($5, $6), 4326))
           ) AS frac_start,
           GREATEST(
             ST_LineLocatePoint(t.geometry, ST_SetSRID(ST_Point($3, $4), 4326)),
             ST_LineLocatePoint(t.geometry, ST_SetSRID(ST_Point($5, $6), 4326))
           ) AS frac_end,
           t.geometry
         FROM trails t WHERE t.id = $2
       )
       INSERT INTO user_trail_manual_segments
         (user_id, trail_id, segment_type, geometry, start_fraction, end_fraction)
       SELECT $1, $2, 'manual',
              ST_LineSubstring(f.geometry, f.frac_start, f.frac_end),
              f.frac_start, f.frac_end
       FROM fracs f
       WHERE f.frac_end - f.frac_start > 0.000001
       RETURNING id`,
      [userId, trail.id, lonA, latA, lonB, latB]
    );

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Points are too close together - click further apart on the trail" },
        { status: 422 }
      );
    }

    const manualData = await getManualSegmentsData(client, userId, trail.id);
    return NextResponse.json({ segmentId: rows[0].id, ...manualData });
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
