import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const homeUrl = new URL("/", request.url).href;

  if (error) {
    console.error("[strava/callback] Strava returned error:", error);
    return NextResponse.redirect(`${homeUrl}?error=access_denied`);
  }

  // Verify CSRF state
  const cookieStore = cookies();
  const storedState = cookieStore.get("strava_oauth_state")?.value;

  if (!state || !storedState || state !== storedState) {
    console.error("[strava/callback] State mismatch. Got:", state, "Expected:", storedState);
    return NextResponse.redirect(`${homeUrl}?error=invalid_state`);
  }

  if (!code) {
    console.error("[strava/callback] No code in callback");
    return NextResponse.redirect(`${homeUrl}?error=no_code`);
  }

  // Exchange authorisation code for tokens
  console.log("[strava/callback] Exchanging code for tokens...");
  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("[strava/callback] Token exchange failed:", tokenRes.status, body);
    return NextResponse.redirect(`${homeUrl}?error=token_exchange_failed`);
  }

  const data = await tokenRes.json();
  const athlete = data.athlete;
  console.log("[strava/callback] Token exchange OK. Athlete:", athlete?.firstname, athlete?.lastname);

  // measurement_preference ("feet"/"meters") only appears on the *detailed*
  // athlete representation — the summary object embedded in the token
  // exchange response above doesn't include it. Best-effort: a failure here
  // shouldn't block login, description writes just fall back to the
  // dashboard's km/mi toggle instead.
  let measurementPreference: string | null = null;
  try {
    const athleteRes = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (athleteRes.ok) {
      const detailed = await athleteRes.json();
      measurementPreference = detailed.measurement_preference ?? null;
    } else {
      console.warn("[strava/callback] Detailed athlete fetch failed:", athleteRes.status);
    }
  } catch (err) {
    console.warn("[strava/callback] Detailed athlete fetch errored:", err);
  }

  // A strava_id that's been deleted before (self-service delete, or the
  // trial-expiry grace_period cleanup — see account-deletion.ts) doesn't
  // get a second free trial on reconnect: their old row is gone, so
  // without this check the INSERT below would look exactly like a
  // brand-new signup. Cheap either way (one indexed PK lookup), and only
  // actually changes anything for the INSERT branch — see the comment
  // below on why the ON CONFLICT branch never touches these fields.
  const { rows: deletedRows } = await query<{ strava_id: string }>(
    "SELECT strava_id FROM deleted_users WHERE strava_id = $1",
    [athlete.id]
  );
  const isReturningDeletedUser = deletedRows.length > 0;
  if (isReturningDeletedUser) {
    console.log(`[strava/callback] Athlete ${athlete.id} previously deleted — no second trial, starting 'expired'`);
  }

  // subscription_status/trial_started_at/trial_ends_at only appear in the
  // INSERT column list, not the ON CONFLICT SET clause below — deliberate,
  // so a returning user reconnecting (token refresh, scope change, etc.)
  // never has their trial clock reset or their founding-tester 'active'
  // status touched. See schema.sql's trial-tracking comment (2026-09-02,
  // when the invite-code gate came off).
  //
  // trialFieldsSql is one of two fixed string constants chosen above, never
  // user input, so interpolating it directly here carries no injection risk
  // — needed because "no trial at all" (a bare 'expired', NULL, NULL) isn't
  // expressible as a placeholder value the same way as the normal
  // 'trial'/NOW()/+1-month case.
  const trialFieldsSql = isReturningDeletedUser
    ? "'expired', NULL, NULL"
    : "'trial', NOW(), NOW() + INTERVAL '1 month'";

  const upsertUserSql = `INSERT INTO users (
      strava_id, username, first_name, last_name, profile_image_url,
      strava_access_token, strava_refresh_token, strava_token_expires_at,
      strava_scope, measurement_preference,
      subscription_status, trial_started_at, trial_ends_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10,
      ${trialFieldsSql})
    ON CONFLICT (strava_id) DO UPDATE SET
      username                = EXCLUDED.username,
      first_name              = EXCLUDED.first_name,
      last_name               = EXCLUDED.last_name,
      profile_image_url       = EXCLUDED.profile_image_url,
      strava_access_token     = EXCLUDED.strava_access_token,
      strava_refresh_token    = EXCLUDED.strava_refresh_token,
      strava_token_expires_at = EXCLUDED.strava_token_expires_at,
      strava_scope            = EXCLUDED.strava_scope,
      measurement_preference  = EXCLUDED.measurement_preference,
      updated_at              = NOW()
    RETURNING id`;
  const upsertUserParams = [
    athlete.id,
    athlete.username,
    athlete.firstname,
    athlete.lastname,
    athlete.profile_medium ?? athlete.profile,
    data.access_token,
    data.refresh_token,
    data.expires_at,
    data.scope ?? null,
    measurementPreference,
  ];

  // No invite-code gate anymore (removed 2026-09-02, app approved for 999
  // users) — every Strava connect, new or returning, goes through the same
  // plain upsert.
  let dbUserId: string | null = null;
  try {
    const result = await query<{ id: string }>(upsertUserSql, upsertUserParams);
    dbUserId = result.rows[0]?.id ?? null;
    console.log("[strava/callback] User upserted. DB id:", dbUserId);
  } catch (err) {
    // Log but don't block the auth flow — user can still reach the dashboard
    console.error("[strava/callback] DB upsert failed:", err);
  }

  const response = NextResponse.redirect(new URL("/dashboard?autoSync=true", request.url));

  const secure = process.env.NODE_ENV === "production";
  const oneYear = 60 * 60 * 24 * 365;
  // Root cause of "I keep having to reconnect every visit" (2026-09-24):
  // with no `domain` set, a cookie is "host-only" — scoped to the EXACT
  // host that set it, so a cookie set while on www.mytraillog.com is
  // invisible on the bare apex mytraillog.com and vice versa. Vercel's own
  // domain redirect normally sends both to the same canonical host, but
  // that's not a guarantee for every entry point (a stale bookmark, a
  // shared link predating the redirect, a client that doesn't consistently
  // follow 301s) — any request that lands on the "wrong" host even once
  // sets or reads a cookie the other host can't see. The leading-dot
  // domain form shares the cookie across the apex and every subdomain
  // (still universally supported, RFC 2965-style). Production-only: a
  // cookie's Domain attribute must match the page's actual registrable
  // domain, so setting this while developing on localhost would silently
  // break cookies there entirely.
  const cookieOpts = {
    httpOnly: true,
    secure,
    path: "/",
    sameSite: "lax" as const,
    ...(secure ? { domain: ".mytraillog.com" } : {}),
  };

  // Minimal session cookie — DB user ID only (tokens stay in the database)
  if (dbUserId) {
    response.cookies.set("strava_user_id", dbUserId, { ...cookieOpts, maxAge: oneYear });
  }

  // Display-only cookie — name + avatar for the dashboard (not sensitive)
  response.cookies.set(
    "strava_athlete",
    JSON.stringify({
      id: athlete.id,
      firstname: athlete.firstname,
      lastname: athlete.lastname,
      username: athlete.username,
      profile: athlete.profile_medium ?? athlete.profile,
    }),
    { ...cookieOpts, maxAge: oneYear }
  );

  // Must match the domain/path this cookie was actually set with (see
  // /api/auth/strava's cookieOpts) — deleting without matching them leaves
  // the original domain-scoped cookie in place until its own 600s expiry,
  // since a browser only clears a cookie whose Domain+Path attributes
  // match exactly.
  response.cookies.delete({ name: "strava_oauth_state", path: "/", ...(secure ? { domain: ".mytraillog.com" } : {}) });

  return response;
}
