import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";

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

    // Single statement, not a separate SELECT-then-UPDATE: a CTE captures
    // the pre-update value alongside the write itself, so there's no race
    // between reading "was this already set" and setting it. previous_email
    // NULL means this PATCH is what just completed the /activate gate (the
    // FIRST time this user ever provided a contact_email) — that, not the
    // Strava OAuth step, is when the 2026-09-16 request wants the "new
    // signup" notification fired, since only now do we actually have
    // something to email them at. A later edit via the dashboard settings
    // field (previous_email already non-null) doesn't re-fire it.
    const { rows } = await query<{
      first_name: string | null;
      last_name: string | null;
      trial_started_at: Date | null;
      created_at: Date;
      previous_email: string | null;
    }>(
      `WITH old AS (SELECT contact_email FROM users WHERE id = $2)
       UPDATE users SET contact_email = $1
       WHERE id = $2
       RETURNING first_name, last_name, trial_started_at, created_at,
         (SELECT contact_email FROM old) AS previous_email`,
      [contact_email.trim(), userId]
    );

    const user = rows[0];
    if (user && user.previous_email === null) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Unknown";
      const connectedAt = (user.trial_started_at ?? user.created_at).toISOString();
      await sendNotificationEmail(`New signup: ${name}`, [
        `Name: ${name}`,
        `Email: ${contact_email.trim()}`,
        `Connected: ${connectedAt}`,
      ]);
    }
  }

  return NextResponse.json({ ok: true });
}
