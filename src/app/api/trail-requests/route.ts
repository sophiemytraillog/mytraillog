import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";

export async function POST(request: NextRequest) {
  const userId = cookies().get("strava_user_id")?.value ?? null;

  const body = await request.json();
  const trailName = typeof body.trail_name === "string" ? body.trail_name.trim() : "";
  if (!trailName) {
    return NextResponse.json({ error: "Trail name is required" }, { status: 400 });
  }

  const region = typeof body.region === "string" && body.region.trim() ? body.region.trim() : null;
  const url    = typeof body.url    === "string" && body.url.trim()    ? body.url.trim()    : null;
  const notes  = typeof body.notes  === "string" && body.notes.trim()  ? body.notes.trim()  : null;

  await query(
    `INSERT INTO trail_requests (user_id, trail_name, region, url, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, trailName, region, url, notes]
  );

  let requesterName = "Unknown user";
  if (userId) {
    const { rows } = await query<{ first_name: string; last_name: string }>(
      "SELECT first_name, last_name FROM users WHERE id = $1",
      [userId]
    );
    if (rows[0]) requesterName = `${rows[0].first_name} ${rows[0].last_name}`;
  }

  await sendNotificationEmail(`New trail request: ${trailName}`, [
    `Trail: ${trailName}`,
    `Region: ${region ?? "(not given)"}`,
    `Link: ${url ?? "(not given)"}`,
    `Notes: ${notes ?? "(none)"}`,
    `Requested by: ${requesterName}`,
  ]);

  return NextResponse.json({ ok: true });
}
