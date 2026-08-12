import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";

  if (!code) {
    return NextResponse.json({ valid: false });
  }

  const { rows } = await query(
    "SELECT 1 FROM invite_codes WHERE code = $1 AND used_by IS NULL",
    [code]
  );

  return NextResponse.json({ valid: rows.length > 0 });
}
