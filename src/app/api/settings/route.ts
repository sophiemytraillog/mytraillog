import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { strava_description_updates, include_cycling, distance_unit } = body;

  if (strava_description_updates !== undefined) {
    if (typeof strava_description_updates !== "boolean") {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET strava_description_updates = $1 WHERE id = $2",
      [strava_description_updates, userId]
    );
  }

  if (include_cycling !== undefined) {
    if (typeof include_cycling !== "boolean") {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET include_cycling = $1 WHERE id = $2",
      [include_cycling, userId]
    );
  }

  if (distance_unit !== undefined) {
    if (distance_unit !== "km" && distance_unit !== "mi") {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET distance_unit = $1 WHERE id = $2",
      [distance_unit, userId]
    );
  }

  return NextResponse.json({ ok: true });
}
