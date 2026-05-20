import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:read_all,activity:write",
    state,
  });

  const response = NextResponse.redirect(
    `https://www.strava.com/oauth/authorize?${params}`
  );

  response.cookies.set("strava_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
    sameSite: "lax",
  });

  return response;
}
