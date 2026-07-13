import { pool } from "@/lib/db";
import {
  getValidAccessToken,
  decodePolylineToWKT,
  ALL_TRACKED_ACTIVITY_TYPES,
} from "@/lib/strava";
import { computeTrailProgress } from "@/lib/match-trails";
import {
  getActivityTrailMatches,
  writeTrailDescription,
  ScopeError,
} from "@/lib/trail-descriptions";

const PER_PAGE = 30;
const PAGE_DELAY_MS = 2000;

// Vercel Hobby plan hard-caps function duration at 60s — this can't be
// raised without a plan upgrade. Default budget leaves margin for the final
// DB write and SSE close within that ceiling.
const DEFAULT_BUDGET_MS = 45_000;

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  start_date: string;
  map?: { summary_polyline?: string | null };
}

export interface SyncProgress {
  fetched: number;
  saved: number;
  message: string;
}

export type SyncChunkResult =
  | { status: "complete"; fetched: number; saved: number; newDbIds: string[] }
  | { status: "partial"; fetched: number; saved: number; newDbIds: string[] }
  | { status: "rate_limited"; message: string }
  | { status: "error"; message: string };

/**
 * Fetches and stores up to `budgetMs` worth of a user's Strava activity
 * history, resuming from wherever the last chunk left off (derived from
 * MIN/MAX(start_date) of what's already stored — no separate cursor needed).
 * Returns "partial" if the time budget was hit before both passes finished;
 * callers (the SSE route, the dashboard self-heal nudge, the cron sweep) are
 * expected to call this again later to continue. Only on "complete" does
 * sync_status flip to 'complete' and last_synced_at update.
 */
export async function runSyncChunk(
  userId: string,
  opts: { budgetMs?: number; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal } = {}
): Promise<SyncChunkResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > budgetMs;
  const aborted = () => signal?.aborted ?? false;

  let fetched = 0;
  let saved = 0;
  const newDbIds: string[] = [];

  try {
    const accessToken = await getValidAccessToken(userId);

    const savePage = async (activities: StravaActivity[]): Promise<number> => {
      let pageNew = 0;
      for (const activity of activities) {
        const type = activity.sport_type || activity.type;
        if (!ALL_TRACKED_ACTIVITY_TYPES.has(type)) continue;
        const wkt = decodePolylineToWKT(activity.map?.summary_polyline);
        const result = await pool.query<{ id: string }>(
          `INSERT INTO activities (
             user_id, strava_activity_id, name, activity_type,
             distance, moving_time, start_date, polyline, geometry
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
             ST_GeomFromText($9, 4326))
           ON CONFLICT (strava_activity_id) DO NOTHING
           RETURNING id`,
          [
            userId, activity.id, activity.name, type,
            activity.distance, activity.moving_time, activity.start_date,
            activity.map?.summary_polyline ?? null, wkt,
          ]
        );
        if ((result.rowCount ?? 0) > 0) { pageNew++; newDbIds.push(result.rows[0].id); }
      }
      return pageNew;
    };

    const fetchPage = async (params: Record<string, string | number>) => {
      const url = new URL("https://www.strava.com/api/v3/athlete/activities");
      url.searchParams.set("per_page", String(PER_PAGE));
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 429) return "rate_limited" as const;
      if (!res.ok) throw new Error(`Strava API error ${res.status}: ${await res.text()}`);
      return res.json() as Promise<StravaActivity[]>;
    };

    const heartbeat = () =>
      pool.query("UPDATE users SET sync_progress_at = NOW() WHERE id = $1", [userId]).catch(() => {});

    const boundsRow = await pool.query<{ after_unix: string; before_unix: string; count: string }>(
      `SELECT EXTRACT(EPOCH FROM MAX(start_date))::bigint AS after_unix,
              EXTRACT(EPOCH FROM MIN(start_date))::bigint AS before_unix,
              COUNT(*)::text AS count
       FROM activities WHERE user_id = $1`,
      [userId]
    );
    const existingCount = parseInt(boundsRow.rows[0]?.count ?? "0");
    const afterUnix: number | null = boundsRow.rows[0]?.after_unix ? parseInt(boundsRow.rows[0].after_unix) : null;
    const beforeUnix: number | null = boundsRow.rows[0]?.before_unix ? parseInt(boundsRow.rows[0].before_unix) : null;

    await pool.query(
      "UPDATE users SET sync_status = 'syncing', sync_progress_at = NOW() WHERE id = $1",
      [userId]
    );
    onProgress({ fetched: 0, saved: 0, message: existingCount > 0 ? "Checking for new activities…" : "Starting sync…" });

    // ── Forward pass: activities newer than what we have ──────────────────
    // Skipped on a first-ever sync (afterUnix === null): with no "after" bound,
    // Strava returns activities newest-first starting from page 1, so this loop
    // would walk the user's ENTIRE history — duplicating the backward pass below.
    if (afterUnix !== null) {
      for (let page = 1; ; page++) {
        if (aborted()) return { status: "partial", fetched, saved, newDbIds };
        if (overBudget()) return { status: "partial", fetched, saved, newDbIds };
        if (page > 1) await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

        const activities = await fetchPage({ page, after: afterUnix });
        if (activities === "rate_limited") {
          await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
          return { status: "rate_limited", message: "Strava rate limit reached. Please try again in a few minutes." };
        }
        if (activities.length === 0) break;

        fetched += activities.length;
        saved += await savePage(activities);
        await heartbeat();
        onProgress({ fetched, saved, message: `Syncing… ${fetched} fetched, ${saved} saved` });
        if (activities.length < PER_PAGE) break;
      }
    }

    // ── Backward pass: fill any gap older than the oldest activity we have ─
    let cursor = beforeUnix !== null ? beforeUnix - 1 : null;
    if (cursor !== null || existingCount === 0) {
      onProgress({ fetched, saved, message: "Checking for older activities…" });
      while (true) {
        if (aborted()) return { status: "partial", fetched, saved, newDbIds };
        if (overBudget()) return { status: "partial", fetched, saved, newDbIds };
        await new Promise<void>((r) => setTimeout(r, PAGE_DELAY_MS));

        const params: Record<string, string | number> = {};
        if (cursor !== null) params.before = cursor;
        const activities = await fetchPage(params);
        if (activities === "rate_limited") {
          await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
          return { status: "rate_limited", message: "Strava rate limit reached. Please try again in a few minutes." };
        }
        if (activities.length === 0) break;

        fetched += activities.length;
        saved += await savePage(activities);
        await heartbeat();
        onProgress({ fetched, saved, message: `Backfilling… ${fetched} fetched, ${saved} saved` });

        const oldest = activities[activities.length - 1].start_date;
        cursor = Math.floor(new Date(oldest).getTime() / 1000) - 1;
        if (activities.length < PER_PAGE) break;
      }
    }

    await pool.query(
      `UPDATE users SET sync_status = 'complete', last_synced_at = NOW() WHERE id = $1`,
      [userId]
    );
    return { status: "complete", fetched, saved, newDbIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    console.error("[sync-engine] runSyncChunk error:", err);
    await pool.query("UPDATE users SET sync_status = 'error' WHERE id = $1", [userId]).catch(() => {});
    return { status: "error", message };
  }
}

/**
 * Runs after a sync chunk reaches "complete": scopes trail matching to
 * trails near the newly-saved activities (not the whole trails table — see
 * computeTrailProgress), then writes Strava descriptions for matched
 * activities if the user has opted in. Safe to call multiple times.
 */
export async function finishSync(
  userId: string,
  newDbIds: string[]
): Promise<{ matchedTrails: number; descUpdated: number }> {
  let matchedTrails = 0;
  let descUpdated = 0;

  if (newDbIds.length === 0) return { matchedTrails, descUpdated };

  try {
    const { rows: nearbyTrails } = await pool.query<{ id: string }>(
      `SELECT DISTINCT t.id
       FROM trails t
       JOIN activities a ON ST_DWithin(a.geometry::geography, t.geometry::geography, 50)
       WHERE a.id = ANY($1::uuid[]) AND a.geometry IS NOT NULL`,
      [newDbIds]
    );
    const trailIds = nearbyTrails.map((r) => r.id);
    if (trailIds.length > 0) {
      matchedTrails = await computeTrailProgress(userId, trailIds);
    }
  } catch (err) {
    console.error("[sync-engine] finishSync matching error:", err);
  }

  const { rows: [userPrefs] } = await pool.query<{ strava_description_updates: boolean }>(
    "SELECT strava_description_updates FROM users WHERE id = $1",
    [userId]
  );
  if (userPrefs?.strava_description_updates) {
    const { rows: toUpdate } = await pool.query<{ id: string; strava_activity_id: string }>(
      `SELECT id, strava_activity_id::text
       FROM activities
       WHERE id = ANY($1::uuid[])
         AND geometry IS NOT NULL
         AND strava_description_updated = FALSE`,
      [newDbIds]
    );
    for (const act of toUpdate) {
      try {
        const matches = await getActivityTrailMatches(userId, act.id);
        if (matches.length > 0) {
          const updated = await writeTrailDescription(userId, act.id, parseInt(act.strava_activity_id), matches);
          if (updated) descUpdated++;
        }
      } catch (err) {
        if (err instanceof ScopeError) {
          console.warn("[sync-engine] Scope error updating description — skipping:", err.message);
          break;
        }
        console.error("[sync-engine] Description update error:", err);
      }
    }
  }

  return { matchedTrails, descUpdated };
}
