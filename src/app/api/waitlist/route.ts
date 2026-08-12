import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  const result = await query<{ id: string }>(
    `INSERT INTO waitlist (email) VALUES ($1)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email]
  );

  // Only notify on a genuinely new signup — ON CONFLICT DO NOTHING means a
  // repeat submission of the same email returns zero rows here.
  if (result.rows.length > 0) {
    await sendNotificationEmail("New waitlist signup", [`Email: ${email}`]);
  }

  return NextResponse.json({ ok: true });
}
