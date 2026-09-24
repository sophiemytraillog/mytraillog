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

  const secure = process.env.NODE_ENV === "production";
  const cookieOpts = {
    httpOnly: true,
    secure,
    maxAge: 600,
    path: "/",
    sameSite: "lax" as const,
    // See callback/route.ts's cookieOpts comment for why this is here —
    // same domain-mismatch root cause applies to this cookie too: if the
    // OAuth flow starts on a non-canonical host, a host-only state cookie
    // set here wouldn't be visible when Strava redirects back to
    // STRAVA_REDIRECT_URI's fixed host, failing CSRF verification.
    ...(secure ? { domain: ".mytraillog.com" } : {}),
  };

  response.cookies.set("strava_oauth_state", state, cookieOpts);

  return response;
}
