import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { strava_description_updates, description_mode, include_cycling, distance_unit, contact_email } = body;

  if (strava_description_updates !== undefined) {
    if (typeof strava_description_updates !== "boolean") {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET strava_description_updates = $1 WHERE id = $2",
      [strava_description_updates, userId]
    );
  }

  if (description_mode !== undefined) {
    if (!["full", "new_only", "new_with_totals"].includes(description_mode)) {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET description_mode = $1 WHERE id = $2",
      [description_mode, userId]
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

  if (contact_email !== undefined) {
    // Same regex used client-side by /activate and the dashboard settings
    // field — simple sanity check, not full RFC 5322 validation. Strava
    // never gives us an athlete's email, so this is the only address on
    // file for trial reminders/expiry notices (see trial-lifecycle.ts) —
    // reused by both the pre-dashboard activation gate and this later
    // "update it" settings field, per the 2026-09-16 request (item 1).
    if (typeof contact_email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    await query(
      "UPDATE users SET contact_email = $1 WHERE id = $2",
      [contact_email.trim(), userId]
    );
  }

  return NextResponse.json({ ok: true });
}
