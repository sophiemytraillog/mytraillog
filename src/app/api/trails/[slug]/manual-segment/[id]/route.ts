import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string; id: string } }
) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const client = await pool.connect();
  try {
    const { rows: [trail] } = await client.query<{ id: string }>(
      "SELECT id FROM trails WHERE slug = $1",
      [params.slug]
    );
    if (!trail) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await client.query(
      "DELETE FROM user_trail_manual_segments WHERE id = $1 AND user_id = $2 AND trail_id = $3",
      [params.id, userId, trail.id]
    );

    const [geoRes, listRes] = await Promise.all([
      client.query<{ manual_geojson: object | null }>(
        `SELECT ST_AsGeoJSON(ST_Collect(geometry))::json AS manual_geojson
         FROM user_trail_manual_segments WHERE user_id = $1 AND trail_id = $2`,
        [userId, trail.id]
      ),
      client.query<{ id: string; segment_type: string; length_m: number; created_at: string }>(
        `SELECT id, segment_type,
                round(ST_Length(geometry::geography))::int AS length_m,
                created_at
         FROM user_trail_manual_segments
         WHERE user_id = $1 AND trail_id = $2
         ORDER BY CASE WHEN segment_type = 'manual' THEN 0 ELSE 1 END, created_at ASC`,
        [userId, trail.id]
      ),
    ]);

    return NextResponse.json({
      manualSegmentsGeoJson: geoRes.rows[0]?.manual_geojson ?? null,
      manualSegments: listRes.rows,
    });
  } finally {
    client.release();
  }
}
