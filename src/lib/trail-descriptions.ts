import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";
import { formatDist, unitLabel, type DistanceUnit } from "@/lib/distance";

async function fetchWithTimeout(url: string, options: RequestInit, ms = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class StravaRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Strava rate limit hit — retry after ${retryAfterSeconds}s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Our own in-process RateLimiter is meant to stay under Strava's real limit,
// but it resets every function invocation and can't see requests from other
// recent invocations — so it can still under-count and let a real 429 through.
// Retry-After can be up to 15 minutes, which always exceeds Vercel's 60s
// function budget, so retrying in-process would just get the function killed
// mid-sleep with zero progress and no feedback. Fail fast instead and let the
// caller report a clean "rate limited, try again in N min" message.
async function fetchStrava(url: string, options: RequestInit): Promise<Response> {
  const res = await fetchWithTimeout(url, options);
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "900");
    throw new StravaRateLimitError(retryAfter);
  }
  return res;
}

const BUFFER_METRES = 50;

export interface TrailMatch {
  name: string;
  completed_distance: number;
  completion_percentage: number;
  total_distance: number;
  activity_trail_distance_m: number;
}

/**
 * Find which trails an activity overlaps (within 50 m) where the user has
 * recorded progress. Returns an empty array if the activity has no geometry.
 *
 * completed_distance/completion_percentage fold in manually-filled segments
 * (user_trail_manual_segments) on top of user_trail_progress's GPS-derived
 * figures — mirroring the same combination dashboard/page.tsx and
 * trail/[slug]/page.tsx already do at query time. user_trail_progress itself
 * intentionally stores GPS-only progress (computeTrailProgress never touches
 * manual segments), so any consumer that skips this combination under-reports
 * completion for trails with a manual fill.
 */
export async function getActivityTrailMatches(
  userId: string,
  activityDbId: string
): Promise<TrailMatch[]> {
  const { rows } = await pool.query<TrailMatch>(
    `SELECT t.name,
            LEAST(
              utp.completed_distance + COALESCE(ms.manual_m, 0),
              t.total_distance
            ) AS completed_distance,
            LEAST(
              CASE WHEN t.total_distance > 0
                   THEN (utp.completed_distance + COALESCE(ms.manual_m, 0)) / t.total_distance * 100
                   ELSE 0 END,
              100
            ) AS completion_percentage,
            t.total_distance,
            COALESCE(
              ST_Length(
                ST_Intersection(
                  a.geometry,
                  ST_Buffer(t.geometry::geography, $3)::geometry
                )::geography
              ),
              0
            ) AS activity_trail_distance_m
     FROM activities a
     JOIN trails t
       ON ST_DWithin(a.geometry::geography, t.geometry::geography, $3)
     JOIN user_trail_progress utp
       ON utp.trail_id = t.id AND utp.user_id = a.user_id
     LEFT JOIN (
       SELECT trail_id, user_id, SUM(ST_Length(geometry::geography)) AS manual_m
       FROM user_trail_manual_segments
       GROUP BY trail_id, user_id
     ) ms ON ms.trail_id = t.id AND ms.user_id = a.user_id
     WHERE a.id = $1
       AND a.user_id = $2
       AND a.geometry IS NOT NULL
       AND (utp.completed_distance + COALESCE(ms.manual_m, 0)) > 0
     ORDER BY completion_percentage DESC`,
    [activityDbId, userId, BUFFER_METRES]
  );
  return rows;
}

function getAppUrl(): string {
  if (process.env.APP_URL) {
    try { return new URL(process.env.APP_URL).host; } catch { /* fall through */ }
  }
  return "mytraillog.com";
}

// Strava's measurement_preference is only present on the *detailed* athlete
// representation (captured once, at OAuth connect — see auth/strava/callback).
// It can be NULL for users who connected before that existed, or if that
// fetch failed at the time. distance_unit is the dashboard's own km/mi
// toggle, persisted server-side specifically to serve as that fallback.
async function resolveDistanceUnit(userId: string): Promise<DistanceUnit> {
  const { rows } = await pool.query<{ measurement_preference: string | null; distance_unit: string | null }>(
    "SELECT measurement_preference, distance_unit FROM users WHERE id = $1",
    [userId]
  );
  const row = rows[0];
  if (row?.measurement_preference === "feet") return "mi";
  if (row?.measurement_preference === "meters") return "km";
  return row?.distance_unit === "mi" ? "mi" : "km";
}

// No leading/trailing blank lines here — separation from any existing
// description text is the caller's job (writeTrailDescription), since only
// it knows whether there's anything to separate from.
function buildTrailBlock(matches: TrailMatch[], unit: DistanceUnit): string {
  const label = unitLabel(unit);
  const lines = matches.map((m) => {
    const actDist = formatDist(m.activity_trail_distance_m, unit);
    const completedDist = formatDist(m.completed_distance, unit);
    const totalDist = formatDist(m.total_distance, unit);
    const pct = Math.round(m.completion_percentage);
    return `🥾 ${m.name}: ${actDist}${label} (${pct}% total · ${completedDist}/${totalDist}${label})`;
  });
  return `${lines.join("\n")}\n${getAppUrl()}`;
}

/**
 * Appends (or refreshes) the My Trail Log block on a Strava activity.
 *
 * @param userId          Our DB user UUID
 * @param activityDbId    Our DB activity UUID
 * @param stravaActivityId Strava's numeric activity ID
 * @param matches         Pre-fetched trail matches (call getActivityTrailMatches first)
 * @param delayMs         Optional delay before making Strava API calls
 * @returns true if the description was updated, false if no changes were needed
 */
export async function writeTrailDescription(
  userId: string,
  activityDbId: string,
  stravaActivityId: number,
  matches: TrailMatch[],
  delayMs = 0,
  rateLimiter?: { waitForSlot(): Promise<void> }
): Promise<boolean> {
  if (matches.length === 0) return false;

  if (delayMs > 0) {
    await new Promise<void>((r) => setTimeout(r, delayMs));
  }

  const token = await getValidAccessToken(userId);
  const unit = await resolveDistanceUnit(userId);

  if (rateLimiter) await rateLimiter.waitForSlot();
  const getRes = await fetchStrava(
    `https://www.strava.com/api/v3/activities/${stravaActivityId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!getRes.ok) {
    if (getRes.status === 403 || getRes.status === 401) {
      throw new ScopeError(
        `Strava returned ${getRes.status} — reconnect your account to grant activity:write permission.`
      );
    }
    throw new Error(`GET /activities/${stravaActivityId} failed: HTTP ${getRes.status}`);
  }
  const activity = await getRes.json();
  const currentDesc: string = activity.description ?? "";

  // Strip any existing My Trail Log block — handles old format (with 🥾
  // header) and current format (trail lines + mytraillog.com). Matches
  // either km or mi so switching units doesn't leave a stale block behind.
  // The leading "\n\n" is optional so this also matches a block written
  // with nothing before it (activity had no description at the time).
  const baseDesc = currentDesc
    .replace(/(?:\n\n)?🥾 My Trail Log[\s\S]*$/, "")
    .replace(/(?:\n\n)?(?:[^\n]+: \d+\.\d+(?:km|mi)[^\n]*\n)+mytraillog\.\S+[^\n]*$/, "")
    .trimEnd();
  const trailBlock = buildTrailBlock(matches, unit);
  // Exactly one blank line of separation when there's existing text to
  // separate from; no leading blank lines at all when there isn't.
  const newDesc = baseDesc ? `${baseDesc}\n\n${trailBlock}` : trailBlock;

  if (newDesc === currentDesc.trimEnd()) return false;

  if (rateLimiter) await rateLimiter.waitForSlot();
  const putRes = await fetchStrava(
    `https://www.strava.com/api/v3/activities/${stravaActivityId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: newDesc }),
    }
  );
  if (!putRes.ok) {
    if (putRes.status === 403 || putRes.status === 401) {
      throw new ScopeError(
        `Strava returned ${putRes.status} — reconnect your account to grant activity:write permission.`
      );
    }
    const body = await putRes.text();
    throw new Error(`PUT /activities/${stravaActivityId} failed: HTTP ${putRes.status}: ${body.slice(0, 200)}`);
  }

  await pool.query(
    `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
    [activityDbId]
  );
  console.log(
    `[descriptions] Updated activity ${stravaActivityId}: ${matches.length} trail(s) — activityDbId ${activityDbId}`
  );
  return true;
}

export class ScopeError extends Error {
  readonly isScopeError = true;
}
