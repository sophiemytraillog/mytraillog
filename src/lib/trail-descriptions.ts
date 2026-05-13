import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";

async function fetchWithTimeout(url: string, options: RequestInit, ms = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Fetch with automatic retry on 429 — waits Retry-After (default 15 min) then retries once.
async function fetchStrava(url: string, options: RequestInit): Promise<Response> {
  const res = await fetchWithTimeout(url, options);
  if (res.status !== 429) return res;
  const retryAfter = parseInt(res.headers.get("Retry-After") ?? "900");
  await new Promise<void>((r) => setTimeout(r, retryAfter * 1000));
  return fetchWithTimeout(url, options);
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
 * recorded progress.  Returns an empty array if the activity has no geometry.
 */
export async function getActivityTrailMatches(
  userId: string,
  activityDbId: string
): Promise<TrailMatch[]> {
  const { rows } = await pool.query<TrailMatch>(
    `SELECT t.name,
            utp.completed_distance,
            utp.completion_percentage,
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
     WHERE a.id = $1
       AND a.user_id = $2
       AND a.geometry IS NOT NULL
       AND utp.completion_percentage > 0
     ORDER BY utp.completion_percentage DESC`,
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

function buildTrailBlock(matches: TrailMatch[]): string {
  const lines = matches.map((m) => {
    const actKm = (m.activity_trail_distance_m / 1000).toFixed(1);
    const completedKm = (m.completed_distance / 1000).toFixed(1);
    const totalKm = (m.total_distance / 1000).toFixed(1);
    const pct = Math.round(m.completion_percentage);
    return `${m.name}: ${actKm}km (${pct}% · ${completedKm}km / ${totalKm}km)`;
  });
  return `\n\n${lines.join("\n")}\n${getAppUrl()}`;
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

  // Strip any existing My Trail Log block — handles old format (with 🥾 header) and new format (trail lines + mytraillog.com)
  const baseDesc = currentDesc
    .replace(/\n\n🥾 My Trail Log[\s\S]*$/, "")
    .replace(/\n\n(?:[^\n]+: \d+\.\d+km[^\n]*\n)+mytraillog\.com[^\n]*$/, "")
    .trimEnd();
  const newDesc = baseDesc + buildTrailBlock(matches);

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
