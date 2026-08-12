import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { ADMIN_USER_ID } from "@/lib/admin";
import { generateInviteCode } from "@/lib/invite-codes";

async function insertUniqueCode(): Promise<string> {
  // Collision odds are astronomically small (32^6 keyspace), but a unique
  // violation is cheap to retry rather than trust to never happen.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      await query("INSERT INTO invite_codes (code) VALUES ($1)", [code]);
      return code;
    } catch (err: unknown) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") continue; // unique_violation — try another code
      throw err;
    }
  }
  throw new Error("Failed to generate a unique invite code after 5 attempts");
}

export async function POST() {
  const userId = cookies().get("strava_user_id")?.value;
  if (userId !== ADMIN_USER_ID) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const code = await insertUniqueCode();
  return NextResponse.json({ code });
}
