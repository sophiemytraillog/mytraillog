import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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

  return response;
}
