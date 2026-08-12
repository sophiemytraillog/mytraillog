import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query, pool } from "@/lib/db";

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

  const upsertUserSql = `INSERT INTO users (
      strava_id, username, first_name, last_name, profile_image_url,
      strava_access_token, strava_refresh_token, strava_token_expires_at,
      strava_scope, measurement_preference
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10)
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

  // Invite codes are only a gate for brand-new accounts — a returning
  // tester reconnecting (token refresh, scope change, etc.) already has a
  // strava_id on file and skips the requirement entirely.
  const existingUser = await query<{ id: string }>(
    "SELECT id FROM users WHERE strava_id = $1",
    [athlete.id]
  );
  const isNewUser = existingUser.rows.length === 0;

  let dbUserId: string | null = null;

  if (isNewUser) {
    const inviteCode = cookieStore.get("strava_invite_code")?.value ?? null;

    if (!inviteCode) {
      console.warn("[strava/callback] New user with no invite code, rejecting:", athlete.id);
      return NextResponse.redirect(`${homeUrl}?error=invalid_invite`);
    }

    // Claim the code and create the account in one transaction: SELECT ...
    // FOR UPDATE blocks a second concurrent claim of the same code until
    // this commits, and re-checks used_by IS NULL once unblocked — so two
    // people racing on the same code can't both get an account out of it.
    const client = await pool.connect();
    let codeValid = false;
    try {
      await client.query("BEGIN");
      const codeResult = await client.query(
        "SELECT code FROM invite_codes WHERE code = $1 AND used_by IS NULL FOR UPDATE",
        [inviteCode]
      );
      codeValid = codeResult.rows.length > 0;

      if (codeValid) {
        const result = await client.query<{ id: string }>(upsertUserSql, upsertUserParams);
        dbUserId = result.rows[0]?.id ?? null;
        if (dbUserId) {
          await client.query(
            "UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2",
            [dbUserId, inviteCode]
          );
        }
      }
      await client.query(codeValid ? "COMMIT" : "ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[strava/callback] New-user signup transaction failed:", err);
    } finally {
      client.release();
    }

    if (!codeValid) {
      console.warn("[strava/callback] Invite code invalid or already used:", inviteCode);
      return NextResponse.redirect(`${homeUrl}?error=invalid_invite`);
    }
    console.log("[strava/callback] New user created via invite code. DB id:", dbUserId);
  } else {
    try {
      const result = await query<{ id: string }>(upsertUserSql, upsertUserParams);
      dbUserId = result.rows[0]?.id ?? null;
      console.log("[strava/callback] Returning user upserted. DB id:", dbUserId);
    } catch (err) {
      // Log but don't block the auth flow — user can still reach the dashboard
      console.error("[strava/callback] DB upsert failed:", err);
    }
  }

  const response = NextResponse.redirect(new URL("/dashboard?autoSync=true", request.url));

  const secure = process.env.NODE_ENV === "production";
  const oneYear = 60 * 60 * 24 * 365;
  const cookieOpts = { httpOnly: true, secure, path: "/", sameSite: "lax" as const };

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

  response.cookies.delete("strava_oauth_state");
  response.cookies.delete("strava_invite_code");

  return response;
}
