import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { type PoolClient } from "pg";
import { pool } from "@/lib/db";
import { hasBasicAccess } from "@/lib/subscription";
import { getSubscriptionStatus } from "@/lib/subscription-db";

export const maxDuration = 60;

export async function POST(
  _req: Request,
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

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '30000'");

    const { rows: [trail] } = await client.query<{ id: string }>(
      "SELECT id FROM trails WHERE slug = $1",
      [params.slug]
    );
    if (!trail) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Replace any existing full-trail completion segment, then insert fresh.
    await client.query(
      `DELETE FROM user_trail_manual_segments
       WHERE user_id = $1 AND trail_id = $2
         AND start_fraction = 0 AND end_fraction = 1`,
      [userId, trail.id]
    );
    await client.query(
      `INSERT INTO user_trail_manual_segments
         (user_id, trail_id, segment_type, geometry, start_fraction, end_fraction, gap_length_m)
       SELECT $1, $2, 'manual', t.geometry, 0, 1,
              round(ST_Length(t.geometry::geography))::int
       FROM trails t WHERE t.id = $2`,
      [userId, trail.id]
    );

    const manualData = await getManualSegmentsData(client, userId, trail.id);
    return NextResponse.json(manualData);
  } catch (err) {
    // Previously unhandled: any failure here (e.g. the MultiLineString/
    // LineString column-type mismatch that broke this for Centenary Way
    // and ~63% of trails — see schema.sql) propagated as a raw exception,
    // which Next.js's App Router turns into an empty/non-JSON response —
    // exactly what produced the client's "Unexpected end of JSON input"
    // rather than a real error message.
    console.error("[mark-complete]", err);
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
