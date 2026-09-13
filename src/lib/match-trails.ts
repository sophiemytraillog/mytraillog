import type { Pool } from "pg";
import { pool } from "@/lib/db";
import { CYCLING_ACTIVITY_TYPES } from "@/lib/strava";

const BUFFER_METRES = 50;
// ST_SimplifyPreserveTopology(geom, 0.001) can move points by up to ~111 m.
// Use a wider pre-filter so activities near the real trail aren't excluded by
// the simplified geometry cutting across headlands or tight coastal bends.
const SIMPLIFY_MARGIN = 200;

const MATCH_SQL = `
  WITH
  -- Union all activity buffers into one polygon so overlapping runs don't double-count.
  -- Uses simplified trail for the spatial filter only (performance) — NOT for geometry output.
  -- Pre-filter uses BUFFER_METRES + SIMPLIFY_MARGIN to account for simplification distortion;
  -- the actual 50 m buffer (ST_Buffer below) determines what counts as "on the trail".
  combined_buffer AS (
    SELECT
      ST_Union(ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry) AS geom,
      COUNT(DISTINCT a.id)  AS activity_count,
      MIN(a.start_date)     AS first_date,
      MAX(a.start_date)     AS last_date
    FROM (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
          FROM trails WHERE id = $2) t_simplified
    JOIN activities a
      ON  a.user_id = $1
      AND a.geometry IS NOT NULL
      -- All activity types are stored regardless of the include_cycling
      -- preference; it's applied here, at match time, instead.
      AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
      AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
  ),
  -- Intersect the merged buffer with the FULL detailed trail geometry so that
  -- stored completed sections follow the exact GPX path, not a simplified approximation.
  coverage AS (
    SELECT
      t.id             AS trail_id,
      t.total_distance,
      ST_CollectionExtract(
        ST_Intersection(t.geometry, cb.geom),
        2
      )                AS covered_geom,
      cb.activity_count,
      cb.first_date,
      cb.last_date
    FROM (SELECT id, total_distance, geometry
          FROM trails WHERE id = $2) t
    CROSS JOIN combined_buffer cb
    WHERE cb.geom IS NOT NULL AND cb.activity_count > 0
  )
  INSERT INTO user_trail_progress (
    user_id, trail_id,
    completed_distance, completion_percentage,
    completed_geometry,
    activity_count, first_activity_date, last_activity_date
  )
  SELECT
    $1, trail_id,
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN 0
         ELSE ST_Length(covered_geom::geography) END,
    LEAST(
      CASE WHEN total_distance > 0
           THEN ST_Length(covered_geom::geography) / total_distance * 100
           ELSE 0 END,
      100
    ),
    CASE WHEN covered_geom IS NULL OR ST_IsEmpty(covered_geom) THEN NULL
         ELSE ST_SetSRID(ST_Multi(covered_geom), 4326)::geometry(MultiLineString,4326) END,
    activity_count, first_date, last_date
  FROM coverage
  WHERE covered_geom IS NOT NULL AND NOT ST_IsEmpty(covered_geom)
  ON CONFLICT (user_id, trail_id) DO UPDATE SET
    completed_distance    = EXCLUDED.completed_distance,
    completion_percentage = EXCLUDED.completion_percentage,
    completed_geometry    = EXCLUDED.completed_geometry,
    activity_count        = EXCLUDED.activity_count,
    first_activity_date   = EXCLUDED.first_activity_date,
    last_activity_date    = EXCLUDED.last_activity_date,
    updated_at            = NOW()
  RETURNING trail_id`;

// Populates the description-update candidate cache (see schema.sql) for a
// trail that just got a coverage row. Same simplified-geometry pre-filter as
// combined_buffer above — a coarse candidate list is fine here because
// getActivityTrailMatches re-verifies the exact overlap at write time.
const ACTIVITY_MATCH_SQL = `
  INSERT INTO activity_trail_matches (activity_id, trail_id, user_id)
  SELECT DISTINCT a.id, $2::uuid, $1::uuid
  FROM activities a
  CROSS JOIN (SELECT ST_SimplifyPreserveTopology(geometry, 0.001) AS geometry
              FROM trails WHERE id = $2::uuid) t_simplified
  WHERE a.user_id = $1::uuid
    AND a.geometry IS NOT NULL
    AND ($3::boolean OR a.activity_type <> ALL($4::text[]))
    AND ST_DWithin(a.geometry::geography, t_simplified.geometry::geography, ${BUFFER_METRES + SIMPLIFY_MARGIN})
  ON CONFLICT (activity_id, trail_id) DO NOTHING`;

// Bbox pre-filter margin for nearby_others_capped below — plain geometry
// `&&` against a static column uses the GIST index (idx_activities_geometry);
// the precise ST_Intersects/ST_Buffer check that follows does not. ~111 m,
// safely wider than BUFFER_METRES so nothing that could actually overlap is
// excluded before the accurate check runs.
const NEARBY_OTHER_BBOX_MARGIN_DEGREES = 0.001;

/**
 * Isolates ONE activity's true unique contribution to a trail's coverage —
 * used by trail-descriptions.ts's getActivityTrailMatches for every
 * real-time and deferred description write alike (see the history below for
 * why real-time no longer takes a shortcut here).
 *
 * That fallback used to just report the activity's whole raw overlap with
 * the trail as "new ground" — correct only the first time a route is ever
 * run, wrong every time after. Root-caused via Dave Chase's second report,
 * 2026-08-21: "Giving it some welly" was written through the new automatic
 * chain and reported 907.8m new on South Downs Way; his other 506 activities
 * near that trail already covered the exact same stretch, so the true
 * new-ground contribution was 0m.
 *
 * Computes coverage from every OTHER activity relevant to THIS activity's
 * specific trail overlap (not near the trail as a whole, and — see below —
 * not just near this activity's whole raw path either) and subtracts it from
 * this activity's own trail overlap directly. Root cause this replaces
 * (2026-08-22): the previous version unioned every other activity within
 * range of the ENTIRE trail — correct, but on a long trail (South West Coast
 * Path, 1,014 km) a busy account's full activity history near that trail
 * (Sophie Davis: 22) all had to be re-unioned for every single description
 * write, however far from THIS activity they actually were. That union
 * routinely exceeded both the 20s statement_timeout below and, cascading
 * from there, the Vercel request's own 60s ceiling — confirmed in production
 * logs timing out inside this function for Sophie's "Morning Run".
 *
 * "Relevant to this activity's trail overlap" means: does the OTHER
 * activity's own buffer actually touch the specific stretch of trail THIS
 * activity covers (`this_coverage`) — not "is the other activity anywhere
 * near this activity's whole raw GPS path." Changed from the latter
 * (2026-09-13): a long, roundabout activity's raw path can pass within
 * range of hundreds of a user's OTHER activities that have nothing to do
 * with the trail stretch in question — e.g. everything near their front
 * door — which, combined with NEARBY_OTHERS_LIMIT below, could crowd the
 * genuinely relevant (often much older) activities that actually cover this
 * trail stretch out of the capped candidate list entirely. Root-caused via
 * Sophie Davis, 2026-09-13: her "First Friday…" walk was reported as adding
 * 1.3 km of new ground on Tandridge Border Path and 1.4 km on Greenwich
 * Meridian Trail; a full, activity-count-unconstrained recompute of each
 * trail with that walk excluded produced an IDENTICAL total to including it
 * — proving the true new-ground contribution was 0m on both. Scoping the
 * "other activities" candidate set to this activity's actual trail overlap
 * geometry, rather than its whole raw path, fixed both: her Cook's Pond loop
 * stretch of Tandridge is touched by 62 of her activities going back to
 * 2016, and her Greenwich Meridian Trail stretch (she lives right on it) by
 * 1,605 — recency-capped lists scoped to the WHOLE walk's path were pulling
 * in unrelated nearby activities and pushing the relevant ones off the end.
 *
 * NEARBY_OTHERS_LIMIT caps that candidate set for the case an even-narrower
 * scoping to this activity's overlap alone doesn't fully bound: a stretch of
 * trail so popular that even ITS OWN touching-activity count runs into the
 * thousands (Greenwich Meridian Trail above: 1,605). Verified empirically
 * against that exact case rather than assumed: 400 was the smallest limit
 * that converged to the correct 0m; 500 is used here for margin. Ordering by
 * recency (not distance — an extra ST_Distance sort over hundreds of rows
 * would reintroduce the same cost this is avoiding) before capping is an
 * arbitrary but reasonable tie-break.
 *
 * Wrapped in the same statement_timeout safety net as before — a timeout or
 * any other failure here returns 0 (safe: undercounts a genuinely-new
 * stretch rather than repeating the original bug of overcounting old
 * ground) instead of throwing and losing the whole description write.
 */
const NEARBY_OTHERS_LIMIT = 500;
export async function computeNewGroundExcludingActivity(
  userId: string,
  activityId: string,
  trailId: string,
  dbPool: Pool = pool
): Promise<number> {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    // Aligned with trail-descriptions.ts's ACTIVITY_NEW_GROUND_BUDGET_MS
    // (2026-08-26): that caller now abandons its wait on this call after
    // 15s regardless, via a race — this query keeps running server-side
    // past that point either way, so a shorter cap here just means the
    // abandoned query itself gets cleaned up sooner instead of lingering.
    await client.query("SET LOCAL statement_timeout = '15000'");
    const { rows: [row] } = await client.query<{ new_ground_m: number }>(
      `WITH this_activity AS (
         SELECT geometry FROM activities WHERE id = $3 AND user_id = $1
       ),
       this_coverage AS (
         SELECT ST_CollectionExtract(
           ST_Intersection(t.geometry, ST_Buffer(a.geometry::geography, ${BUFFER_METRES})::geometry),
           2
         ) AS geom
         FROM this_activity a
         CROSS JOIN (SELECT geometry FROM trails WHERE id = $2) t
       ),
       -- Other activities whose OWN buffer actually touches the specific
       -- trail stretch this activity covers — not every activity near the
       -- trail as a whole, and not just activities near this activity's
       -- whole raw path (see doc comment above for why that distinction
       -- matters). Capped at NEARBY_OTHERS_LIMIT for the rare stretch
       -- popular enough on its own to need it.
       nearby_others_capped AS (
         SELECT o.geometry
         FROM activities o, this_coverage tc
         WHERE o.user_id = $1
           AND o.id != $3
           AND o.geometry IS NOT NULL
           AND o.geometry && ST_Expand(tc.geom, ${NEARBY_OTHER_BBOX_MARGIN_DEGREES})
           AND ST_Intersects(ST_Buffer(o.geometry::geography, ${BUFFER_METRES})::geometry, tc.geom)
         ORDER BY o.start_date DESC
         LIMIT ${NEARBY_OTHERS_LIMIT}
       ),
       nearby_others AS (
         SELECT ST_Union(ST_Buffer(geometry::geography, ${BUFFER_METRES})::geometry) AS geom
         FROM nearby_others_capped
       )
       SELECT COALESCE(
         ST_Length(
           ST_Difference(
             tc.geom,
             COALESCE(no.geom, ST_GeomFromText('GEOMETRYCOLLECTION EMPTY', 4326))
           )::geography
         ),
         0
       ) AS new_ground_m
       FROM this_coverage tc
       CROSS JOIN nearby_others no`,
      [userId, trailId, activityId]
    );
    await client.query("COMMIT");
    return Math.max(0, row?.new_ground_m ?? 0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[match-trails] computeNewGroundExcludingActivity failed for activity ${activityId}, trail ${trailId}:`,
      err
    );
    return 0;
  } finally {
    client.release();
  }
}

export async function computeTrailProgress(
  userId: string,
  trailIds?: string[],
  dbPool: Pool = pool
): Promise<number> {
  const { rows: [userPrefs] } = await dbPool.query<{ include_cycling: boolean }>(
    "SELECT include_cycling FROM users WHERE id = $1",
    [userId]
  );
  const includeCycling = userPrefs?.include_cycling ?? false;
  const cyclingTypes = Array.from(CYCLING_ACTIVITY_TYPES);

  const { rows: trails } = trailIds && trailIds.length > 0
    ? await dbPool.query<{ id: string }>(
        "SELECT id FROM trails WHERE id = ANY($1::uuid[]) ORDER BY name",
        [trailIds]
      )
    : await dbPool.query<{ id: string }>("SELECT id FROM trails ORDER BY name");

  let matched = 0;

  for (const trail of trails) {
    const client = await dbPool.connect();
    // Remove any listener left over from a previous iteration (pool reuses client objects).
    client.removeAllListeners("error");
    client.on("error", (err) => {
      console.error(`[match-trails] Client error on trail ${trail.id}:`, err.message);
    });
    try {
      // Wrap in an explicit transaction so SET LOCAL is pinned to the same
      // backend connection through Supabase's transaction-mode pooler.
      // Without BEGIN, SET LOCAL fires on backend A and MATCH_SQL runs on
      // backend B (which still has the global 2-minute cap).
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '180000'"); // 3 min
      const result = await client.query<{ trail_id: string }>(MATCH_SQL, [
        userId,
        trail.id,
        includeCycling,
        cyclingTypes,
      ]);
      await client.query("COMMIT");

      const wasMatched = (result.rowCount ?? 0) > 0;
      if (wasMatched) {
        matched++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL statement_timeout = '180000'"); // 3 min — some trails (e.g. South West Coast Path) are huge
          await client.query(ACTIVITY_MATCH_SQL, [userId, trail.id, includeCycling, cyclingTypes]);
          await client.query(
            "UPDATE user_trail_progress SET activity_matches_computed_at = NOW() WHERE user_id = $1 AND trail_id = $2",
            [userId, trail.id]
          );
          await client.query("COMMIT");
        } catch (err) {
          console.error(`[match-trails] activity_trail_matches for trail ${trail.id} failed:`, err);
          await client.query("ROLLBACK").catch(() => {});
        }
      }

      // Record that this pair was actually attempted, regardless of outcome
      // — a legitimate zero-overlap trail never gets a user_trail_progress
      // row (see MATCH_SQL's WHERE covered_geom IS NOT NULL), so without
      // this a full-account sweep can't tell "checked, no match" apart from
      // "never checked" and would needlessly recheck it forever. Best-effort:
      // a failure here shouldn't undo the matching work that just succeeded.
      await dbPool.query(
        `INSERT INTO trail_match_checks (user_id, trail_id, matched)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, trail_id) DO UPDATE SET matched = EXCLUDED.matched, checked_at = NOW()`,
        [userId, trail.id, wasMatched]
      ).catch((err) => {
        console.error(`[match-trails] Failed to record trail_match_checks for trail ${trail.id}:`, err.message);
      });
    } catch (err) {
      console.error(`[match-trails] Trail ${trail.id} failed:`, err);
      await client.query("ROLLBACK").catch(() => {});
      // Deliberately NOT checkpointed — this trail genuinely wasn't
      // processed, so it should be retried on the next sweep rather than
      // silently treated as done.
    } finally {
      client.release();
    }
  }

  return matched;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const BATCH_MAX_ATTEMPTS = 3;
const BATCH_RETRY_DELAY_MS = 1_500;

// computeTrailProgress already catches every per-trail error internally and
// never throws — it just logs and moves on — so a caller can't tell success
// from failure via try/catch. trail_match_checks is only written on the
// success path above, so its presence after the call IS the success signal:
// retry until it appears, up to BATCH_MAX_ATTEMPTS, with a short backoff for
// transient connection drops to actually clear before retrying.
async function attemptTrailWithRetry(
  userId: string,
  trailId: string,
  dbPool: Pool
): Promise<{ ok: boolean; matched: boolean }> {
  for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
    await computeTrailProgress(userId, [trailId], dbPool);
    const { rows } = await dbPool.query<{ matched: boolean }>(
      "SELECT matched FROM trail_match_checks WHERE user_id = $1 AND trail_id = $2",
      [userId, trailId]
    );
    if (rows.length > 0) return { ok: true, matched: rows[0].matched };
    if (attempt < BATCH_MAX_ATTEMPTS) await sleep(BATCH_RETRY_DELAY_MS);
  }
  return { ok: false, matched: false };
}

export interface MatchBatchResult {
  checkedThisBatch: number;
  matchedThisBatch: number;
  totalChecked: number;
  totalTrails: number;
  done: boolean;
  // True if any trail in this batch failed every attempt — a signal to the
  // caller (specifically the drain hop) that the connection pool may be
  // under pressure and it's worth backing off before dispatching the next
  // hop, rather than immediately hammering again.
  hadFailures: boolean;
}

// Same bbox tolerance as sync-engine.ts's NEARBY_TRAILS_BBOX_DEGREES —
// see that file's comment for why plain geometry `&&` against
// simplified_geometry (not ST_DWithin/::geography) is what actually uses
// the GIST index here.
// Exported (2026-08-31) so match-chain.ts's pickNextMatchDrainCandidate can
// use the identical staleness condition when deciding who's eligible for
// the drain — see the comment there for why that consistency matters.
export const STALE_CHECK_BBOX_DEGREES = 0.003;

// Processes up to `limit` trails for one user, National Trails first (the
// ~20 of 1,181 users actually look for). "Needs checking" means either
// never checked, OR checked before an activity that's now spatially near
// it was added — see the STALE clause below for why that second case is
// essential, not an edge case.
//
// Root cause of the recurring "activities clearly overlap this trail but
// completed_distance/completion_percentage sit at zero" reports (David,
// Paul, and now Chris Rance's South Downs Way, 2026-08-19): every one of
// this table's readers — this function, the old duplicated versions in
// admin/rematch and the cron sweep — treated trail_match_checks as a
// permanent, one-time verdict. It isn't. A trail legitimately gets
// matched=false when it's checked before the relevant activity has synced
// yet (confirmed for Chris: all 23 activities that overlap South Downs Way
// were inserted 22-29 minutes AFTER a rematch pass had already checked it
// and moved on) — sync and matching sweeps run concurrently by design (the
// dashboard's own TrailMatchProgress starts sweeping immediately, not
// waiting for an in-flight sync to finish), so this isn't a rare race, it's
// an expected outcome that nothing ever revisited. The STALE clause below
// re-surfaces exactly those trails: NOT "recheck everything whenever
// anything changes" (which would re-run the expensive MATCH_SQL union
// against all ~1,180 trails every single sync, for every user), but "only
// this trail, only if a new activity landed within its own bbox" — the
// same cheap, indexed `&&` pre-filter finishSync already uses to find
// candidates for brand-new activities, just applied to already-checked
// trails too instead of only ever-unchecked ones.
export async function matchNextBatch(
  userId: string,
  limit: number,
  timeBudgetMs?: number,
  dbPool: Pool = pool
): Promise<MatchBatchResult> {
  const startedAt = Date.now();

  const { rows: candidates } = await dbPool.query<{ id: string }>(
    `SELECT t.id
     FROM trails t
     LEFT JOIN trail_match_checks c ON c.user_id = $1 AND c.trail_id = t.id
     WHERE c.trail_id IS NULL
        OR EXISTS (
          SELECT 1 FROM activities a
          WHERE a.user_id = $1
            AND a.geometry IS NOT NULL
            AND a.created_at > c.checked_at
            AND t.simplified_geometry && ST_Expand(a.geometry, ${STALE_CHECK_BBOX_DEGREES})
        )
     ORDER BY (t.category = 'national_trail') DESC, t.name ASC
     LIMIT $2`,
    [userId, limit]
  );

  let checkedThisBatch = 0;
  let matchedThisBatch = 0;
  const stillFailing: string[] = [];

  for (const trail of candidates) {
    if (timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trail.id, dbPool);
    if (ok) {
      checkedThisBatch++;
      if (matched) matchedThisBatch++;
    } else {
      stillFailing.push(trail.id);
    }
  }

  // Same pattern as computeTrailProgress's own caller loops elsewhere: a
  // trail that failed because of a transient blip earlier in this call may
  // well succeed a few seconds later, worth one more try before giving up
  // for this call.
  let stillFailingAfterRetry = 0;
  for (const trailId of stillFailing) {
    if (timeBudgetMs !== undefined && Date.now() - startedAt > timeBudgetMs) break;
    const { ok, matched } = await attemptTrailWithRetry(userId, trailId, dbPool);
    if (ok) {
      checkedThisBatch++;
      if (matched) matchedThisBatch++;
    } else {
      stillFailingAfterRetry++;
    }
  }

  const { rows: [totals] } = await dbPool.query<{ total: string; checked: string }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked`,
    [userId]
  );
  const totalTrails = parseInt(totals.total);
  const totalChecked = parseInt(totals.checked);

  return {
    checkedThisBatch,
    matchedThisBatch,
    totalChecked,
    totalTrails,
    done: totalChecked >= totalTrails,
    hadFailures: stillFailingAfterRetry > 0,
  };
}

export async function getMatchProgress(userId: string): Promise<{ totalChecked: number; totalTrails: number }> {
  const { rows: [totals] } = await pool.query<{ total: string; checked: string }>(
    `SELECT
       (SELECT COUNT(*) FROM trails) AS total,
       (SELECT COUNT(*) FROM trail_match_checks WHERE user_id = $1) AS checked`,
    [userId]
  );
  return { totalTrails: parseInt(totals.total), totalChecked: parseInt(totals.checked) };
}
