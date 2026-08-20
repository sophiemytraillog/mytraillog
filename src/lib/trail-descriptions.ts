import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";
import { formatDist, unitLabel, type DistanceUnit } from "@/lib/distance";
import { logSyncEvent } from "@/lib/sync-log";

// Matches the "3 attempts" convention already used elsewhere for transient
// failures (see match-trails.ts) — enough to ride out a genuine blip, not so
// many that a permanently-broken activity burns a lot of budget before
// callers give up on it.
const MAX_DESCRIPTION_UPDATE_ATTEMPTS = 3;

/**
 * Call from a catch block after writeTrailDescription throws anything other
 * than ScopeError/StravaRateLimitError (those are handled separately by
 * every caller — a scope error needs the user to reconnect, a rate limit
 * needs to stop the whole run, neither is "this one activity is broken").
 * Increments this activity's failure counter and reports whether the caller
 * should give up and mark it checked. Confirmed necessary in practice: Strava
 * returning a persistent 500 for GET on a specific activity (not transient —
 * reproduced repeatedly against the same handful of activities on Rosie's
 * account) would otherwise never set strava_description_updated, so it sits
 * at the front of update-descriptions' backlog query forever and every
 * future run re-attempts the same doomed activities before making any real
 * progress through the rest of the backlog.
 */
export async function recordDescriptionUpdateFailure(
  userId: string,
  activityDbId: string
): Promise<{ giveUp: boolean; attempts: number }> {
  const { rows } = await pool.query<{ description_update_attempts: number }>(
    `UPDATE activities SET description_update_attempts = description_update_attempts + 1
     WHERE id = $1 RETURNING description_update_attempts`,
    [activityDbId]
  );
  const attempts = rows[0]?.description_update_attempts ?? MAX_DESCRIPTION_UPDATE_ATTEMPTS;
  const giveUp = attempts >= MAX_DESCRIPTION_UPDATE_ATTEMPTS;
  if (giveUp) {
    logSyncEvent(userId, "description_update_abandoned", { activityId: activityDbId, attempts });
  }
  return { giveUp, attempts };
}

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

// ── Shared batch processor ──────────────────────────────────────────────────
//
// Strava's rate limit is enforced per-application across every user combined
// — this backlog scan is the one feature that can burn through it fastest,
// so it gets its own fixed daily share rather than competing with normal
// syncs/webhooks for whatever's left. 250 updates/day ≈ 500 calls/day
// (GET+PUT per update), leaving the remaining ~1,500 of the app's ~2,000/day
// quota free for everything else.
const DAILY_UPDATE_BUDGET = 250;

// Reserves one attempt against the app-wide daily backfill budget, paced
// evenly across the day (via an elapsed-fraction ceiling) rather than
// spendable in one burst. Atomic: the conditional UPDATE means concurrent
// callers — the manual button, the background chain, and the cron sweep can
// all be reserving slots at once — can't collectively reserve past the
// ceiling.
export async function reserveBackfillSlot(): Promise<boolean> {
  const now = new Date();
  const startOfDayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fractionOfDayElapsed = (now.getTime() - startOfDayUTC) / (24 * 60 * 60 * 1000);
  const allowedSoFar = Math.max(1, Math.floor(DAILY_UPDATE_BUDGET * fractionOfDayElapsed));

  const { rows } = await pool.query<{ calls_used: number }>(
    `INSERT INTO backfill_api_usage (usage_date, calls_used) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (usage_date) DO UPDATE
       SET calls_used = backfill_api_usage.calls_used + 1
       WHERE backfill_api_usage.calls_used < $1
     RETURNING calls_used`,
    [allowedSoFar]
  );
  return rows.length > 0;
}

// Sliding-window rate limiter: tracks each Strava API call and blocks until
// there is budget remaining in the current 15-minute window. Per-invocation
// only, doesn't persist across separate function calls — reserveBackfillSlot's
// DB row is what actually enforces the shared daily cap across every caller;
// this is just a courtesy throttle within a single batch.
export class RateLimiter {
  private readonly windowMs = 15 * 60 * 1000;
  private readonly maxRequests: number;
  private timestamps: number[] = [];

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 50;
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }

  // Returns ms until n slots are available (0 = capacity available now).
  msUntilCapacity(n = 1): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length + n <= this.maxRequests) return 0;
    return this.windowMs - (now - this.timestamps[0]) + 50;
  }
}

export interface DescriptionBatchResult {
  checkedThisBatch: number;
  updatedThisBatch: number;
  errorsThisBatch: number;
  remaining: number;
  done: boolean;
  budgetExhausted: boolean;
}

// One bounded batch of the description backlog for a single user — same
// discovery query and per-activity handling as the manual "Update historical
// activity descriptions" button (/api/update-descriptions), factored out
// here so that route, the automatic background chain (description-chain.ts),
// and the daily cron sweep all share one implementation instead of three
// copies of the budget/rate-limit/retry logic drifting apart.
//
// Logs one aggregated sync_log event per call — deliberately not one per
// write, which could be up to 250/day — so "is this actually running" is a
// queryable fact instead of the console-only blind spot this backlog used to
// be stuck with (root-caused 2026-08-20: activities sat with confirmed trail
// matches for days because nothing but a manual button ever wrote their
// descriptions, and there was no durable record of that ever happening).
export async function processDescriptionBatch(
  userId: string,
  timeBudgetMs: number,
  triggeredBy: string
): Promise<DescriptionBatchResult> {
  const startedAt = Date.now();

  const { rows: [userPrefs] } = await pool.query<{
    strava_description_updates: boolean;
    description_mode: DescriptionMode;
  }>(
    "SELECT strava_description_updates, description_mode FROM users WHERE id = $1",
    [userId]
  );
  if (!userPrefs?.strava_description_updates) {
    return { checkedThisBatch: 0, updatedThisBatch: 0, errorsThisBatch: 0, remaining: 0, done: true, budgetExhausted: false };
  }
  const mode: DescriptionMode = userPrefs.description_mode ?? "full";

  const { rows: activities } = await pool.query<{ id: string; strava_activity_id: string; name: string }>(
    `SELECT DISTINCT a.id, a.strava_activity_id, a.name
     FROM activities a
     JOIN activity_trail_matches atm ON atm.activity_id = a.id
     WHERE a.user_id = $1 AND a.strava_description_updated = FALSE
     ORDER BY a.strava_activity_id ASC`,
    [userId]
  );

  const limiter = new RateLimiter(100);
  let checkedThisBatch = 0;
  let updatedThisBatch = 0;
  let errorsThisBatch = 0;
  let budgetExhausted = false;

  for (let i = 0; i < activities.length; i++) {
    if (Date.now() - startedAt > timeBudgetMs) break;

    // Strava rate limit reached this run — stop cleanly, a later call
    // (chain hop, cron, or the manual button) resumes from here.
    if (limiter.msUntilCapacity(2) > 0) break;

    const act = activities[i];
    checkedThisBatch++;

    try {
      const matches = await getActivityTrailMatches(userId, act.id);

      // Ambiguous — could be a false-positive candidate (the loose
      // backfill-candidate insert) or matching genuinely hasn't landed a
      // confirmed progress row yet. Leave unchecked either way so a later
      // call can pick it back up once it's real.
      if (matches.length === 0) continue;

      const relevantMatches = mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > 0);
      if (relevantMatches.length === 0) {
        await pool.query(
          "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
          [act.id]
        ).catch(() => {});
        continue;
      }

      if (!(await reserveBackfillSlot())) {
        budgetExhausted = true;
        break;
      }

      const wasUpdated = await writeTrailDescription(
        userId, act.id, parseInt(act.strava_activity_id), matches, mode, 0, limiter
      );
      if (wasUpdated) updatedThisBatch++;
    } catch (err) {
      if (err instanceof StravaRateLimitError) break;

      errorsThisBatch++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[description-batch] Activity ${act.id}:`, message);

      if (err instanceof ScopeError) break;

      const { giveUp } = await recordDescriptionUpdateFailure(userId, act.id).catch(() => ({ giveUp: false }));
      if (giveUp) {
        await pool.query(
          "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
          [act.id]
        ).catch(() => {});
      }
    }
  }

  const remaining = activities.length - checkedThisBatch;
  const done = checkedThisBatch >= activities.length;

  logSyncEvent(userId, "description_batch", {
    triggeredBy,
    checkedThisBatch,
    updatedThisBatch,
    errorsThisBatch,
    remaining,
    done,
    budgetExhausted,
  });

  return { checkedThisBatch, updatedThisBatch, errorsThisBatch, remaining, done, budgetExhausted };
}

export class ScopeError extends Error {
  readonly isScopeError = true;
}
