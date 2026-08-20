import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getMatchProgress } from "@/lib/match-trails";

export const dynamic = "force-dynamic";

// Read-only — two COUNT queries, no matching work. Trail matching itself
// now runs server-side regardless of whether anyone's looking (see
// match-chain.ts); this just lets TrailMatchProgress poll for something to
// show on screen without being the thing driving the work.
export async function GET() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { totalChecked, totalTrails } = await getMatchProgress(userId);
  return NextResponse.json({ totalChecked, totalTrails, done: totalChecked >= totalTrails });
}
