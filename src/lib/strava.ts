import polyline from "@mapbox/polyline";
import { query } from "./db";

export const SYNC_ACTIVITY_TYPES = new Set(["Run", "TrailRun", "Walk", "Hike"]);
export const CYCLING_ACTIVITY_TYPES = new Set(["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"]);
// Every activity type the app ever stores — independent of the include_cycling
// preference, which only controls what counts toward trail matching, not what
// gets saved. Keeps re-syncs from needing to hit Strava again when the
// preference changes.
export const ALL_TRACKED_ACTIVITY_TYPES = new Set([
  ...Array.from(SYNC_ACTIVITY_TYPES),
  ...Array.from(CYCLING_ACTIVITY_TYPES),
]);

// ── Token management ─────────────────────────────────────────────────────────

export async function getValidAccessToken(userId: string, forceRefresh = false): Promise<string> {
  const { rows } = await query<{
    strava_access_token: string;
    strava_refresh_token: string;
    strava_token_expires_at: Date;
  }>(
    `SELECT strava_access_token, strava_refresh_token, strava_token_expires_at
     FROM users WHERE id = $1`,
    [userId]
  );

  if (!rows[0]) throw new Error(`User ${userId} not found`);

  const { strava_access_token, strava_refresh_token, strava_token_expires_at } =
    rows[0];

  // Still valid for more than 5 minutes — use as-is, UNLESS the caller
  // explicitly wants a guaranteed-fresh one regardless (2026-09-25):
  // trail-descriptions.ts's fetchStravaWithReauthRetry passes forceRefresh
  // after a 401/403, to rule out a stale-token race (two concurrent
  // description writes both reading the same soon-to-expire token, one
  // refreshing it and invalidating the other's copy mid-flight) before
  // concluding the grant itself is actually gone.
  if (!forceRefresh && new Date(strava_token_expires_at).getTime() > Date.now() + 5 * 60_000) {
    return strava_access_token;
  }

  console.log("[strava] Token expiring soon, refreshing…");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: strava_refresh_token,
    }),
    signal: ac.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const tokens = await res.json();

  await query(
    `UPDATE users
     SET strava_access_token     = $1,
         strava_refresh_token    = $2,
         strava_token_expires_at = to_timestamp($3),
         updated_at              = NOW()
     WHERE id = $4`,
    [tokens.access_token, tokens.refresh_token, tokens.expires_at, userId]
  );

  console.log("[strava] Token refreshed OK");
  return tokens.access_token;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Strava's `map.summary_polyline` can come back empty even when the
 * activity genuinely has a GPS track — confirmed directly against Strava's
 * API for a short activity where summary_polyline was "" but the detailed
 * `polyline` field (only present on GET /activities/{id}, not the
 * /athlete/activities list endpoint) was fully populated. Falls back to the
 * full-resolution polyline whenever the summary one is missing/empty; a
 * no-op wherever only the list endpoint's summary is available at all.
 */
export function selectPolyline(
  map?: { summary_polyline?: string | null; polyline?: string | null } | null
): string | null {
  return map?.summary_polyline || map?.polyline || null;
}

/**
 * Decodes a Strava summary_polyline into a WKT LineString suitable for
 * ST_GeomFromText($n, 4326).  Returns null if the input is blank or decodes
 * to fewer than 2 points.
 *
 * Strava polylines use Google's format: [lat, lng] pairs.
 * PostGIS WKT uses longitude-first (x, y), so we swap the axes.
 */
export function decodePolylineToWKT(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  try {
    const coords = polyline.decode(encoded); // [[lat, lng], …]
    if (coords.length < 2) return null;
    const pts = coords.map(([lat, lng]) => `${lng} ${lat}`).join(", ");
    return `LINESTRING(${pts})`;
  } catch {
    return null;
  }
}
