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

export type DescriptionMode = "full" | "new_only" | "new_with_totals";

interface TrailMatchRow {
  trail_id: string;
  name: string;
  completed_distance: number;
  completion_percentage: number;
  total_distance: number;
  activity_trail_distance_m: number;
}

export interface TrailMatch extends TrailMatchRow {
  new_trail_distance_m: number;
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
 *
 * new_trail_distance_m ("how much of the trail did THIS activity add that
 * nothing earlier had") is NOT computed here via geometry — an earlier
 * version tried ST_Union-ing every one of a user's prior activities near a
 * trail per matched-activity call, and confirmed directly against
 * production (Sophie's account, Greenwich Meridian Trail) that it can run
 * for minutes and starve the connection pool. computeTrailProgress already
 * does that expensive union once, as part of normal matching, so we reuse
 * ITS output instead of redoing it: newGroundByTrailId is a
 * before/after-snapshot of user_trail_progress.completed_distance built by
 * the caller around its (already-happening) computeTrailProgress call — see
 * snapshotTrailProgress in match-trails.ts. Falls back to this activity's
 * own raw trail overlap (activity_trail_distance_m, cheap — a single
 * intersection, no cross-activity union) when no snapshot is available,
 * which is the case for the historical backfill catch-up
 * (update-descriptions route) processing activities matched long before
 * this feature existed — an approximation (assumes the whole activity is
 * new ground, overcounting on a repeated route) rather than the real thing,
 * but bounded and cheap, unlike the geometric approach.
 */
export async function getActivityTrailMatches(
  userId: string,
  activityDbId: string,
  newGroundByTrailId?: Map<string, number>
): Promise<TrailMatch[]> {
  const { rows } = await pool.query<TrailMatchRow>(
    `SELECT t.id AS trail_id,
            t.name,
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
  return rows.map((r) => ({
    ...r,
    new_trail_distance_m: newGroundByTrailId?.get(r.trail_id) ?? r.activity_trail_distance_m,
  }));
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
//
// Callers are expected to have already filtered `matches` down to whatever
// this mode should actually report (see writeTrailDescription) — "full"
// still shows every matched trail (with or without new ground), while
// "new_only"/"new_with_totals" are only ever called with trails that did
// have new ground, so their branches don't need a no-new-ground fallback.
function buildTrailBlock(matches: TrailMatch[], unit: DistanceUnit, mode: DescriptionMode): string {
  const label = unitLabel(unit);
  const lines = matches.map((m) => {
    const newDist = formatDist(m.new_trail_distance_m, unit);
    const completedDist = formatDist(m.completed_distance, unit);
    const totalDist = formatDist(m.total_distance, unit);
    const pct = Math.round(m.completion_percentage);
    const totals = `${pct}% total · ${completedDist}/${totalDist}${label}`;

    if (mode === "new_only") {
      return `🥾 ${m.name}: +${newDist}${label} new trail`;
    }
    if (mode === "new_with_totals") {
      return `🥾 ${m.name}: +${newDist}${label} new trail (${totals})`;
    }
    // mode === "full"
    return m.new_trail_distance_m > 0
      ? `🥾 ${m.name}: +${newDist}${label} new trail (${totals})`
      : `🥾 ${m.name}: ${totals}`;
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
 * @param mode            'full' writes every matched trail; 'new_only'/'new_with_totals'
 *                        only write trails with new_trail_distance_m > 0 — with none,
 *                        this returns false before making any Strava API calls at all.
 * @param delayMs         Optional delay before making Strava API calls
 * @returns true if the description was updated, false if no changes were needed
 */
export async function writeTrailDescription(
  userId: string,
  activityDbId: string,
  stravaActivityId: number,
  matches: TrailMatch[],
  mode: DescriptionMode = "full",
  delayMs = 0,
  rateLimiter?: { waitForSlot(): Promise<void> }
): Promise<boolean> {
  const relevantMatches =
    mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > 0);
  if (relevantMatches.length === 0) return false;

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

  // Strip every existing My Trail Log block, wherever it sits in the
  // description — not just one anchored to the end. Some users run other
  // apps (e.g. summitbag, Wandrer) that also append to the same
  // description; once a third-party app's text ends up after one of our
  // blocks, an end-anchored strip can never find that block again on later
  // runs, leaving it permanently orphaned mid-description while a fresh
  // block keeps getting appended after the other app's text. Matching
  // globally finds every occurrence regardless of position. Handles the
  // legacy "🥾 My Trail Log" header format, the legacy per-trail-line
  // format ("Name: D.Dkm (P% total · C/Tkm)"), all three current
  // description_mode formats ("Name: P% total · C/Tkm", "Name: +D.Dkm new
  // trail", "Name: +D.Dkm new trail (P% total · C/Tkm)", either km or mi),
  // and tolerates the odd "mytraillog . com" spacing/trailing characters
  // seen in older writes. A description written under one mode is found and
  // replaced the same way even after the user switches modes. Any
  // blank-line gaps left behind by removed blocks get collapsed before
  // re-appending one fresh block.
  const baseDesc = currentDesc
    .replace(/🥾 My Trail Log[\s\S]*?(?=\r?\n\r?\n|$)/g, "")
    .replace(
      /(?:[^\n]+:\s*(?:\+?\d+(?:\.\d+)?\s*(?:km|mi)(?:\s*new trail)?(?:\s*\([^\n]*\))?|\d+%\s*total\s*·\s*\d+(?:\.\d+)?\/\d+(?:\.\d+)?\s*(?:km|mi))\n)+mytraillog\s*\.?\s*com[^\n]*\n?/gi,
      ""
    )
    .replace(/[ \t]*(?:\r?\n){2,}/g, "\n\n")
    .trim();
  const trailBlock = buildTrailBlock(relevantMatches, unit, mode);
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
    `[descriptions] Updated activity ${stravaActivityId}: ${relevantMatches.length} trail(s) (mode: ${mode}) — activityDbId ${activityDbId}`
  );
  return true;
}

export class ScopeError extends Error {
  readonly isScopeError = true;
}
