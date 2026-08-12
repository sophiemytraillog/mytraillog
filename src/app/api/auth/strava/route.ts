import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const homeUrl = new URL("/", request.url).href;

  // Invite code is optional here — a returning user reconnecting via this
  // same route has no code to send, and the callback skips the requirement
  // entirely once it sees their strava_id already has an account. For a
  // brand new visitor, though, catch an invalid/used code here rather than
  // sending them all the way through the Strava consent screen first.
  const inviteCode = request.nextUrl.searchParams.get("invite")?.trim().toUpperCase() || null;
  if (inviteCode) {
    const { rows } = await query(
      "SELECT 1 FROM invite_codes WHERE code = $1 AND used_by IS NULL",
      [inviteCode]
    );
    if (rows.length === 0) {
      return NextResponse.redirect(`${homeUrl}?error=invalid_invite`);
    }
  }

  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: "code",
    approval_prompt: "force",
    // profile:read_all is required for measurement_preference on the
    // detailed athlete object (GET /athlete) — without it Strava silently
    // returns the summary athlete (resource_state 2) with that field absent.
    scope: "activity:read_all,activity:write,profile:read_all",
    state,
  });

  const response = NextResponse.redirect(
    `https://www.strava.com/oauth/authorize?${params}`
  );

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
    sameSite: "lax" as const,
  };

  response.cookies.set("strava_oauth_state", state, cookieOpts);

  // Carried through Strava's redirect via cookie (not the OAuth `state`
  // param, which is already spoken for as the CSRF token) so the callback
  // can re-validate and atomically claim it once we know the athlete id.
  if (inviteCode) {
    response.cookies.set("strava_invite_code", inviteCode, cookieOpts);
  }

  return response;
}
