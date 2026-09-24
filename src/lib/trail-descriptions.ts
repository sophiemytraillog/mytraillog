import type { Pool } from "pg";
import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";
import { formatDist, unitLabel, type DistanceUnit } from "@/lib/distance";
import { logSyncEvent } from "@/lib/sync-log";
import { computeNewGroundExcludingActivity } from "@/lib/match-trails";

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

// Best-effort — called right before throwing ScopeError below, so a DB
// hiccup here should never mask the real error or block it propagating.
// See schema.sql's needs_reauth comment for the full root-cause writeup;
// cleared again on the user's next successful OAuth reconnect
// (strava/callback/route.ts), which always re-requests activity:write.
async function flagNeedsReauth(userId: string, dbPool: Pool): Promise<void> {
  await dbPool.query("UPDATE users SET needs_reauth = TRUE WHERE id = $1", [userId]).catch(() => {});
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
    super(`Strava rate limit hit - retry after ${retryAfterSeconds}s`);
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

// Same bbox-pre-filter trick already established in match-trails.ts (see
// STALE_CHECK_BBOX_DEGREES there) — plain geometry `&&` against
// simplified_geometry uses the GIST index; ST_DWithin against a
// non-simplified geometry::geography does not. ~300m margin, safely
// larger than BUFFER_METRES.
const CANDIDATE_BBOX_MARGIN_DEGREES = 0.003;

// Below this, reported "new ground" either isn't real (floating-point
// noise intrinsic to ST_Difference/ST_Length near buffer edges — genuinely
// overlapping coverage rarely cancels to exactly 0, landing a hair either
// side instead) or is real but too small
// for formatDist's one-decimal-place rounding to ever show as anything
// but "0.0" — either way a visible but meaningless "+0.0km/mi new trail"
// line. Reported on Dave Chase's and Amy Hodge's descriptions, 2026-08-21
// (Amy's case was the second kind: a genuine 2.6m of new ground, correctly
// above a naive >0 check, still displayed as "+0.0km"). 100m clears both
// failure modes with margin in either unit (0.05mi, the smallest distance
// that rounds to a non-zero "0.1" at one decimal place, is ~80m — the
// tighter constraint of the two units) and is still a trivial cutoff
// against real trail lengths of tens to hundreds of km.
export const NEW_GROUND_THRESHOLD_M = 100;

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
 * The candidate JOIN pre-filters trails via the indexed bbox `&&` check
 * against simplified_geometry before the precise ST_DWithin call, and that
 * precise call itself checks against simplified_geometry too, not the full
 * geometry — root-caused 2026-08-24 investigating why Paul Crowe's
 * description drain timed out at Vercel's 60s ceiling with zero progress,
 * even on activities with a single candidate trail: EXPLAIN ANALYZE showed
 * the bbox pre-filter correctly narrowing to a handful of candidate rows,
 * but ST_DWithin against those rows' full (non-simplified) geometry still
 * took ~2s per activity regardless — the cost is in each candidate
 * geometry's point count (thousands of vertices for a trail like South
 * West Coast Path), not the row count a bbox filter reduces. Checking
 * against simplified_geometry instead cut that to ~0.2s. Full t.geometry
 * is still used below for activity_trail_distance_m's ST_Intersection —
 * that only runs once per already-confirmed match, not once per candidate,
 * so its cost doesn't scale with how many trails get ruled out.
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
 * nothing earlier had") always goes through computeNewGroundExcludingActivity
 * — a real geometric computation, NOT activity_trail_distance_m (this
 * activity's raw overlap regardless of prior coverage) and NOT a
 * before/after delta of user_trail_progress.completed_distance either.
 *
 * A before/after snapshot delta (webhook and finishSync used to take one
 * around their own computeTrailProgress call, crediting the difference to
 * whichever activity triggered it) was cheaper — reusing computeTrailProgress's
 * own union instead of redoing it — but wrong whenever completed_distance
 * itself was stale going in: computeTrailProgress recomputes a trail's FULL
 * coverage from every matching activity, not just the new one, so if the
 * stored value was behind (a trail that hadn't been touched by the
 * staleness sweep in a while, an earlier partial failure, etc.) the delta
 * conflates "catching up on old activities' coverage" with "this activity's
 * own new ground" and credits it all to whichever activity happened to
 * trigger the recompute. Root-caused via Sophie Davis, 2026-09-13: her
 * "First Friday…" walk was reported as +1.3km new on Tandridge Border Path
 * and +1.4km on Greenwich Meridian Trail; a fresh recompute of each trail
 * with that walk excluded produced an identical total either way — the true
 * new-ground contribution was 0m on both, and the reported figures were
 * pure backlog catch-up from a stale stored completed_distance, not
 * anything her walk actually added. computeNewGroundExcludingActivity can't
 * be fooled this way because it never reads the stored completed_distance
 * at all — it derives new ground straight from the other activities that
 * exist in the database right now, every time, real-time write or deferred
 * alike. That used to be the fallback and was wrong every time after the
 * first for a related reason: root-caused via Dave Chase's second "already
 * covered this" report, 2026-08-21 — an activity written through the
 * automatic chain reported 907.8m new on South Downs Way when his other 506
 * nearby activities had already covered that exact stretch, true new ground
 * 0m.
 *
 * The per-trail loop below is HARD time-budgeted (ACTIVITY_NEW_GROUND_BUDGET_MS)
 * across ALL of an activity's candidate trails combined, not just each
 * trail's own internal statement_timeout. Root-caused 2026-08-26: Paul
 * Crowe's account has several spots he revisits constantly enough that
 * hundreds of his own activities cluster within meters of each other —
 * even one candidate trail's own new-ground query at such a spot can take
 * 50s+ despite recovering "safely" (falling back to 0) within its own 20s
 * cap, because Postgres's cancel handshake itself isn't instant. A softer
 * first attempt at this (checking elapsed time only BETWEEN trails, not
 * bounding each individual call) still let a single slow trail blow the
 * whole budget before the check ever got a chance to act — confirmed in
 * production repeatedly: every drain hop that landed on one of these
 * activities died before writeTrailDescription ever checkpointed it,
 * so the SAME doomed activity got re-picked forever, permanently blocking
 * everyone's backlog behind it in the round-robin queue, not just Paul's.
 *
 * This version races each individual computeNewGroundExcludingActivity
 * call against whatever budget remains, so no single trail — however slow
 * — can consume more than its fair share. The abandoned query keeps
 * running server-side until its own statement_timeout (see
 * match-trails.ts) fires independently; racing it here only bounds how
 * long THIS function waits on it, not the query's own lifetime.
 */
const ACTIVITY_NEW_GROUND_BUDGET_MS = 15_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

export async function getActivityTrailMatches(
  userId: string,
  activityDbId: string,
  dbPool: Pool = pool
): Promise<TrailMatch[]> {
  const { rows } = await dbPool.query<TrailMatchRow>(
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
       ON t.simplified_geometry && ST_Expand(a.geometry, ${CANDIDATE_BBOX_MARGIN_DEGREES})
       AND ST_DWithin(a.geometry::geography, t.simplified_geometry::geography, $3)
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

  const results: TrailMatch[] = [];
  const loopStartedAt = Date.now();
  for (const r of rows) {
    const remaining = ACTIVITY_NEW_GROUND_BUDGET_MS - (Date.now() - loopStartedAt);
    let newGround: number;
    if (remaining <= 0) {
      newGround = 0;
    } else {
      newGround = await withDeadline(
        computeNewGroundExcludingActivity(userId, activityDbId, r.trail_id, dbPool),
        remaining,
        0
      );
      if (Date.now() - loopStartedAt > ACTIVITY_NEW_GROUND_BUDGET_MS) {
        console.warn(
          `[trail-descriptions] Per-activity new-ground budget (${ACTIVITY_NEW_GROUND_BUDGET_MS}ms) exceeded for activity ${activityDbId} on trail ${r.trail_id} — falling back to 0 so the write can still complete on time`
        );
      }
    }
    results.push({ ...r, new_trail_distance_m: newGround });
  }
  return results;
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
    return m.new_trail_distance_m > NEW_GROUND_THRESHOLD_M
      ? `🥾 ${m.name}: +${newDist}${label} new trail (${totals})`
      : `🥾 ${m.name}: ${totals}`;
  });
  return `${lines.join("\n")}\n${getAppUrl()}`;
}

/**
 * Appends, refreshes, or strips the My Trail Log block on a Strava activity.
 *
 * @param userId          Our DB user UUID
 * @param activityDbId    Our DB activity UUID
 * @param stravaActivityId Strava's numeric activity ID
 * @param matches         Pre-fetched trail matches (call getActivityTrailMatches first)
 * @param mode            'full' writes every matched trail. 'new_only'/'new_with_totals'
 *                        only include trails with new_trail_distance_m > NEW_GROUND_THRESHOLD_M
 *                        — if none qualify, any existing block is REMOVED entirely rather than
 *                        left in place (a stale block from an earlier write, e.g. before this
 *                        activity's new ground dropped below threshold or before a mode switch,
 *                        must not linger forever just because there's nothing new to report now).
 * @param delayMs         Optional delay before making Strava API calls
 * @returns true if the description was changed (written or stripped), false if it was already
 *          correct as-is — either way, strava_description_updated is set on any normal return;
 *          only a thrown error leaves it unset for a caller's own retry bookkeeping.
 */
export async function writeTrailDescription(
  userId: string,
  activityDbId: string,
  stravaActivityId: number,
  matches: TrailMatch[],
  mode: DescriptionMode = "full",
  delayMs = 0,
  rateLimiter?: { waitForSlot(): Promise<void> },
  dbPool: Pool = pool
): Promise<boolean> {
  const relevantMatches =
    mode === "full" ? matches : matches.filter((m) => m.new_trail_distance_m > NEW_GROUND_THRESHOLD_M);

  if (delayMs > 0) {
    await new Promise<void>((r) => setTimeout(r, delayMs));
  }

  const token = await getValidAccessToken(userId);
  const unit = await resolveDistanceUnit(userId);

  // Always fetch the current description, even when relevantMatches is
  // empty — that's the only way to know whether a stale block needs
  // stripping. Previously this returned early right here, before any
  // Strava call, whenever relevantMatches was empty; the cost of that
  // shortcut was never noticing a block that needed removing (Dave Chase,
  // 2026-08-21: new_only mode, an activity whose new ground had dropped to
  // 0m under the NEW_GROUND_THRESHOLD_M fix still carried a full trail
  // block, because nothing ever re-checked it once written).
  if (rateLimiter) await rateLimiter.waitForSlot();
  const getRes = await fetchStrava(
    `https://www.strava.com/api/v3/activities/${stravaActivityId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!getRes.ok) {
    if (getRes.status === 403 || getRes.status === 401) {
      await flagNeedsReauth(userId, dbPool);
      throw new ScopeError(
        `Strava returned ${getRes.status} - reconnect your account to grant activity:write permission.`
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

  // No relevant matches under this mode -> nothing to append; the block
  // (if any existed) simply isn't rebuilt, so baseDesc IS the result.
  const newDesc =
    relevantMatches.length > 0
      ? baseDesc
        ? `${baseDesc}\n\n${buildTrailBlock(relevantMatches, unit, mode)}`
        : buildTrailBlock(relevantMatches, unit, mode)
      : baseDesc;

  if (newDesc === currentDesc.trimEnd()) {
    // Confirmed correct as-is — whether that's "has the right block" or
    // "correctly has no block" — so this activity is genuinely done, not
    // ambiguous. Checkpoint it here too, not just on the write path below:
    // every caller used to skip calling this function entirely (and skip
    // checkpointing) whenever it pre-computed zero relevant matches, which
    // is exactly how a stale block was able to survive indefinitely — see
    // the callers in sync-engine.ts, trail-descriptions.ts's
    // processDescriptionBatch, and update-descriptions/route.ts, all of
    // which now call this unconditionally instead of pre-filtering.
    await dbPool.query(
      `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
      [activityDbId]
    ).catch(() => {});
    return false;
  }

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
      await flagNeedsReauth(userId, dbPool);
      throw new ScopeError(
        `Strava returned ${putRes.status} - reconnect your account to grant activity:write permission.`
      );
    }
    const body = await putRes.text();
    throw new Error(`PUT /activities/${stravaActivityId} failed: HTTP ${putRes.status}: ${body.slice(0, 200)}`);
  }

  await dbPool.query(
    `UPDATE activities SET strava_description_updated = TRUE WHERE id = $1`,
    [activityDbId]
  );
  console.log(
    relevantMatches.length > 0
      ? `[descriptions] Updated activity ${stravaActivityId}: ${relevantMatches.length} trail(s) (mode: ${mode}) — activityDbId ${activityDbId}`
      : `[descriptions] Stripped stale trail block from activity ${stravaActivityId} (mode: ${mode}, no relevant new ground) — activityDbId ${activityDbId}`
  );
  return true;
}

// ── Shared batch processor ──────────────────────────────────────────────────
//
// Strava's rate limit is enforced per-application across every user combined
// — this backlog scan is the one feature that can burn through it fastest,
// so it gets its own fixed daily share rather than competing with normal
// syncs/webhooks for whatever's left. Raised 250 -> 750, 2026-08-21 (see git
// history for that reasoning). Raised 750 -> 2,000, 2026-09-04, to match
// Strava's updated per-app daily rate limit — 2,000 updates/day = 4,000
// calls/day (GET+PUT per update), leaving normal day-to-day usage (syncs +
// webhooks, historically 100-300 calls/day) plenty of headroom within the
// new ceiling while cutting backlog drain time further.
const DAILY_UPDATE_BUDGET = 2000;

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
  // Mirrors match-trails.ts's MatchBatchResult.hadFailures — lets the drain
  // hop back off before its next dispatch when this batch hit real errors,
  // instead of immediately hammering the pool again.
  hadErrors: boolean;
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
  triggeredBy: string,
  dbPool: Pool = pool
): Promise<DescriptionBatchResult> {
  const startedAt = Date.now();

  const { rows: [userPrefs] } = await dbPool.query<{
    strava_description_updates: boolean;
    description_mode: DescriptionMode;
  }>(
    "SELECT strava_description_updates, description_mode FROM users WHERE id = $1",
    [userId]
  );
  if (!userPrefs?.strava_description_updates) {
    return { checkedThisBatch: 0, updatedThisBatch: 0, errorsThisBatch: 0, remaining: 0, done: true, budgetExhausted: false, hadErrors: false };
  }
  const mode: DescriptionMode = userPrefs.description_mode ?? "full";

  // Newest first — the activity that just triggered this call (a fresh
  // webhook delivery or sync) needs its description written within
  // minutes, not queued behind however much historical backlog exists.
  // Previously oldest-first: reasonable for the manual backlog button in
  // isolation, but once the SAME query started driving the automatic
  // real-time chain too, a large historical backlog (Sophie: ~1,957
  // pending) meant this week's activities sat at the back of the queue
  // behind years of old ones. Newest-first fixes both: recent activities
  // get written almost immediately, and the historical backlog still
  // drains in the background behind them, just no longer blocking them.
  const { rows: activities } = await dbPool.query<{ id: string; strava_activity_id: string; name: string }>(
    `SELECT DISTINCT a.id, a.strava_activity_id, a.name
     FROM activities a
     JOIN activity_trail_matches atm ON atm.activity_id = a.id
     WHERE a.user_id = $1 AND a.strava_description_updated = FALSE
     ORDER BY a.strava_activity_id DESC`,
    [userId]
  );

  // Computed once per call, not per activity — whether this user's trail
  // matching has fully caught up (every trail has a trail_match_checks
  // row). Determines what a zero-real-match result below actually means:
  // see the comment at that check.
  const { rows: [matchStatus] } = await dbPool.query<{ matching_complete: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM trails t
       WHERE NOT EXISTS (
         SELECT 1 FROM trail_match_checks c WHERE c.user_id = $1 AND c.trail_id = t.id
       )
     ) AS matching_complete`,
    [userId]
  );
  const matchingComplete = matchStatus?.matching_complete ?? false;

  const limiter = new RateLimiter(100);
  let checkedThisBatch = 0;
  let updatedThisBatch = 0;
  let errorsThisBatch = 0;
  let budgetExhausted = false;

  for (let i = 0; i < activities.length; i++) {
    // Stop with a safety margin, not right at the wire — an activity can
    // take up to ACTIVITY_NEW_GROUND_BUDGET_MS (15s) just for its new-ground
    // computation before it even reaches Strava's API, so starting one with
    // less than that much budget left risks the SAME class of problem this
    // margin exists to prevent (2026-08-26): stopping cleanly here, with
    // time to spare, lets the caller (runBacklogDrainHop) dispatch the next
    // hop promptly instead of racing an activity that has no real chance of
    // finishing before this function's own ceiling.
    if (timeBudgetMs - (Date.now() - startedAt) < ACTIVITY_NEW_GROUND_BUDGET_MS) break;

    // Strava rate limit reached this run — stop cleanly, a later call
    // (chain hop, cron, or the manual button) resumes from here.
    if (limiter.msUntilCapacity(2) > 0) break;

    const act = activities[i];
    checkedThisBatch++;

    try {
      const matches = await getActivityTrailMatches(userId, act.id, dbPool);

      if (matches.length === 0) {
        // Root cause of a 2026-08-29 stall confirmed on Luke Barton-Davis's
        // account (structural, not account-specific — see the investigation
        // that led here): this candidate came from activity_trail_matches'
        // loose/coarse bbox pre-filter, but the precise check above found
        // zero real overlap. The query above has no cursor and always
        // re-fetches every not-yet-written candidate newest-first, so a
        // confirmed-false candidate left eligible forever gets
        // re-examined on EVERY future call — Luke had 139 of them sitting
        // in front of 164 genuine unwritten matches, so every run burned
        // its whole time budget re-litigating the same false positives and
        // never reached the real ones: 5 days, ~50 checks/run, 0 writes.
        //
        // Only safe to retire once matching is fully caught up for this
        // user, though: while trail_match_checks is still incomplete, a
        // zero-match result here might still be pending rather than
        // permanently false — matching could land a real one later. Once
        // every trail has been checked, there's no "later" left to wait
        // for, so a zero-match result is definitively permanent, same as
        // writeTrailDescription's own "nothing relevant to write" paths
        // below already retire an activity by setting this flag.
        if (matchingComplete) {
          await dbPool.query(
            "UPDATE activities SET strava_description_updated = TRUE WHERE id = $1",
            [act.id]
          );
        }
        continue;
      }

      if (!(await reserveBackfillSlot())) {
        budgetExhausted = true;
        break;
      }

      // writeTrailDescription itself now decides whether a confirmed match
      // with no relevant new ground (under new_only/new_with_totals) means
      // stripping a stale block down to nothing, leaving it untouched, or
      // writing a fresh one — and checkpoints strava_description_updated
      // on any normal completion either way, so there's nothing left for
      // this caller to pre-filter or branch on.
      const wasUpdated = await writeTrailDescription(
        userId, act.id, parseInt(act.strava_activity_id), matches, mode, 0, limiter, dbPool
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
        await dbPool.query(
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

  return { checkedThisBatch, updatedThisBatch, errorsThisBatch, remaining, done, budgetExhausted, hadErrors: errorsThisBatch > 0 };
}

export class ScopeError extends Error {
  readonly isScopeError = true;
}
