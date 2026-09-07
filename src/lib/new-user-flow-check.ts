// Read-only(ish) diagnostic sweep of every stage a new user's account
// actually passes through — database connectivity, the Strava API itself,
// syncing, trail matching, description writes, the overnight drain
// schedulers, and known failure patterns. Built 2026-09-07 to answer one
// question on demand: "if someone signed up right now, would every step of
// their pipeline actually work?" — without needing to create a real test
// account to find out.
//
// "Read-only(ish)": steps 3-5 deliberately exercise the REAL pipeline
// against REAL existing users/activities/trails rather than mocking
// anything, since a mock would only prove the mock works. Step 4
// (matching) genuinely writes — matchNextBatch upserts trail_match_checks/
// user_trail_progress for whichever trail it picks, exactly like a real
// background sweep would. That's intentional and safe: it's the same
// idempotent computation the production system runs on its own, on an
// existing account, so running it once more here can only freshen a check,
// never corrupt anything. Step 5 only ever GETs an activity's description
// from Strava — never PUTs.
//
// Shared by both callers rather than living directly in a route handler:
// /api/internal/test-new-user-flow (GET, CRON_SECRET-authenticated, for
// external monitoring) and /api/admin/test-new-user-flow (POST, admin-
// cookie-authenticated, for the dashboard's "System Health" button) need
// the exact same underlying checks, just gated by two different auth
// mechanisms — CRON_SECRET must never reach the browser, so the dashboard
// button can't call the CRON_SECRET route directly.
import { pool } from "@/lib/db";
import { getValidAccessToken } from "@/lib/strava";
import { matchNextBatch } from "@/lib/match-trails";
import { logSyncEvent } from "@/lib/sync-log";
import { ADMIN_USER_ID } from "@/lib/admin";

export type StepStatus = "pass" | "warn" | "fail";

export interface DiagnosticStep {
  name: string;
  status: StepStatus;
  summary: string;
  details: Record<string, unknown>;
  tookMs: number;
}

export interface DiagnosticReport {
  healthy: boolean; // true only if every step is "pass"
  ranAt: string;
  tookMs: number;
  steps: DiagnosticStep[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; tookMs: number }> {
  const startedAt = Date.now();
  const result = await fn();
  return { result, tookMs: Date.now() - startedAt };
}

function fail(name: string, tookMs: number, err: unknown): DiagnosticStep {
  return {
    name,
    status: "fail",
    summary: err instanceof Error ? err.message : String(err),
    details: {},
    tookMs,
  };
}

async function fetchWithTimeout(url: string, options: RequestInit, ms = 15_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── 1. DATABASE ──────────────────────────────────────────────────────────
// Above this many concurrent connections on the shared Supabase project,
// this session's own investigation (2026-09-04/07: Luke Davis's stuck sync,
// then the matchBatchPool bug) repeatedly saw real "timeout exceeded when
// trying to connect" failures — not a documented Supabase hard limit, just
// the empirical point past which contention started actually breaking
// things in practice on this project.
const DB_CONNECTION_WARN_THRESHOLD = 15;

async function checkDatabase(): Promise<DiagnosticStep> {
  const name = "database";
  try {
    const { result, tookMs } = await timed(async () => {
      await pool.query("SELECT 1");
      const { rows } = await pool.query<{ active: string; total: string }>(
        `SELECT count(*) FILTER (WHERE state = 'active') AS active, count(*) AS total
         FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'postgres'`
      );
      return {
        dbActiveConnections: parseInt(rows[0].active),
        dbTotalConnections: parseInt(rows[0].total),
        // This process's own local pool state — a best-effort signal only;
        // meaningful on a long-lived instance (local dev, a warm Fluid
        // Compute invocation), close to meaningless on a genuinely cold
        // one-shot serverless invocation where the pool was just created.
        localPoolTotal: pool.totalCount,
        localPoolIdle: pool.idleCount,
        localPoolWaiting: pool.waitingCount,
      };
    });

    const warn = result.dbTotalConnections >= DB_CONNECTION_WARN_THRESHOLD || result.localPoolWaiting > 0;
    return {
      name,
      status: warn ? "warn" : "pass",
      summary: warn
        ? `Connected, but ${result.dbTotalConnections} total DB connection(s) open (>= ${DB_CONNECTION_WARN_THRESHOLD}) — watch for pool contention`
        : `Connected — ${result.dbTotalConnections} total DB connection(s), ${result.dbActiveConnections} active`,
      details: result,
      tookMs,
    };
  } catch (err) {
    return fail(name, 0, err);
  }
}

// ── 2. STRAVA API ────────────────────────────────────────────────────────
// The webhook subscription is APP-level (client_id/client_secret query
// params), not tied to any one user's OAuth token — this is the same
// GET /push_subscriptions call used to originally register the webhook,
// re-run here purely as a read. Also doubles as the reachability check and
// the source of the X-RateLimit-* headers Strava attaches to every
// response, which is the only place today's usage-vs-limit numbers can
// come from — nothing in this app persists Strava's own counters
// independently (backfill_api_usage tracks only this app's SELF-IMPOSED
// description-backlog share, not the account-wide total).
const EXPECTED_CALLBACK_URL = "https://www.mytraillog.com/api/webhook/strava";

interface PushSubscription {
  id: number;
  callback_url: string;
  created_at: string;
  updated_at: string;
}

async function checkStravaApi(): Promise<DiagnosticStep> {
  const name = "strava_api";
  try {
    const { result, tookMs } = await timed(async () => {
      const url = new URL("https://www.strava.com/api/v3/push_subscriptions");
      url.searchParams.set("client_id", process.env.STRAVA_CLIENT_ID ?? "");
      url.searchParams.set("client_secret", process.env.STRAVA_CLIENT_SECRET ?? "");
      const res = await fetchWithTimeout(url.toString(), {});
      if (!res.ok) {
        throw new Error(`Strava API returned HTTP ${res.status}: ${await res.text()}`);
      }
      const subscriptions = (await res.json()) as PushSubscription[];

      // Format per Strava's docs: "15min,daily" for both headers, e.g.
      // Limit: "1000,10000", Usage: "42,1337".
      const limitHeader = res.headers.get("x-ratelimit-limit");
      const usageHeader = res.headers.get("x-ratelimit-usage");
      const [limit15min, limitDaily] = (limitHeader ?? "").split(",").map(Number);
      const [usage15min, usageDaily] = (usageHeader ?? "").split(",").map(Number);

      return { subscriptions, limit15min, limitDaily, usage15min, usageDaily };
    });

    const activeSub = result.subscriptions.find((s) => s.callback_url === EXPECTED_CALLBACK_URL);
    const dailyPct = result.limitDaily ? (result.usageDaily / result.limitDaily) * 100 : null;

    const issues: string[] = [];
    if (result.subscriptions.length === 0) issues.push("no active webhook subscription");
    else if (!activeSub) issues.push(`subscription exists but callback_url doesn't match ${EXPECTED_CALLBACK_URL}`);
    if (dailyPct !== null && dailyPct >= 90) issues.push(`daily API usage at ${dailyPct.toFixed(0)}%`);

    return {
      name,
      status: issues.length > 0 ? "warn" : "pass",
      summary:
        issues.length > 0
          ? `Reachable, but: ${issues.join("; ")}`
          : `Reachable — webhook active, daily usage ${result.usageDaily}/${result.limitDaily} (${dailyPct?.toFixed(1)}%)`,
      details: {
        webhookActive: !!activeSub,
        subscriptionCount: result.subscriptions.length,
        callbackUrls: result.subscriptions.map((s) => s.callback_url),
        rateLimit15min: { usage: result.usage15min, limit: result.limit15min },
        rateLimitDaily: { usage: result.usageDaily, limit: result.limitDaily },
      },
      tookMs,
    };
  } catch (err) {
    return fail(name, 0, err);
  }
}

// ── 3. SYNC PIPELINE ─────────────────────────────────────────────────────
async function checkSyncPipeline(): Promise<{ step: DiagnosticStep; testUserId: string | null }> {
  const name = "sync_pipeline";
  try {
    const { result, tookMs } = await timed(async () => {
      // Prefer an account sized like a genuinely NEW signup (a handful to
      // a few hundred activities), not whichever account happens to be
      // most active — the whole point of this tool is "will the NEXT NEW
      // user have a smooth experience," and a several-thousand-activity
      // power user's own per-trail matching cost isn't representative of
      // that (confirmed directly: Luke Davis's account, ~6,700 activities,
      // routinely took 10-90s+ for a SINGLE trail's match computation —
      // see checkMatchingPipeline's own hard timeout below, added after
      // this exact account got picked and blew well past 30s). Falls back
      // to any complete account with activities if every current user
      // happens to be outside that range.
      const { rows: typicalRows } = await pool.query<{ id: string; first_name: string | null }>(
        `SELECT u.id, u.first_name
         FROM users u
         JOIN activities a ON a.user_id = u.id
         WHERE u.sync_status = 'complete'
         GROUP BY u.id
         HAVING COUNT(a.id) BETWEEN 5 AND 500
         ORDER BY u.last_synced_at DESC NULLS LAST
         LIMIT 1`
      );
      let userRows = typicalRows;
      if (userRows.length === 0) {
        const { rows: fallbackRows } = await pool.query<{ id: string; first_name: string | null }>(
          `SELECT u.id, u.first_name
           FROM users u
           WHERE u.sync_status = 'complete'
             AND EXISTS (SELECT 1 FROM activities a WHERE a.user_id = u.id)
           ORDER BY u.last_synced_at DESC NULLS LAST
           LIMIT 1`
        );
        userRows = fallbackRows;
      }
      if (userRows.length === 0) throw new Error("no user with sync_status='complete' and at least one activity found");
      const testUser = userRows[0];

      const { rows: countRows } = await pool.query<{ total: string; with_geometry: string }>(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE geometry IS NOT NULL) AS with_geometry
         FROM activities WHERE user_id = $1`,
        [testUser.id]
      );
      return {
        testUserId: testUser.id,
        testUserFirstName: testUser.first_name,
        totalActivities: parseInt(countRows[0].total),
        withGeometry: parseInt(countRows[0].with_geometry),
      };
    });

    const geomPct = result.totalActivities > 0 ? (result.withGeometry / result.totalActivities) * 100 : 0;
    const warn = result.totalActivities > 0 && result.withGeometry === 0;

    return {
      testUserId: result.testUserId,
      step: {
        name,
        status: warn ? "warn" : "pass",
        summary: warn
          ? `Queried ${result.testUserFirstName}'s activities OK, but none have geometry (${result.totalActivities} total)`
          : `Queried ${result.testUserFirstName}'s activities OK — ${result.withGeometry}/${result.totalActivities} (${geomPct.toFixed(0)}%) have valid geometry`,
        details: result,
        tookMs,
      },
    };
  } catch (err) {
    return { testUserId: null, step: fail(name, 0, err) };
  }
}

// ── 4. MATCHING PIPELINE ─────────────────────────────────────────────────
const MATCHING_TIME_LIMIT_MS = 30_000;

// matchNextBatch's own `timeBudgetMs` parameter is checked BETWEEN trials
// in its loop, never during one — with `limit: 1` there's only ever one
// trial, so that parameter provides no protection at all here: a single
// trial's own retries (attemptTrailWithRetry, up to 3 attempts) each carry
// their own separate 3-minute statement_timeout in computeTrailProgress,
// meaning a single matchNextBatch(userId, 1, ...) call can legitimately
// run for many MINUTES regardless of what's passed as timeBudgetMs.
// Confirmed directly: this step took 90s and then 150s against Luke
// Davis's account before checkSyncPipeline was changed to prefer a
// typically-sized test user instead. A real Promise.race is the only way
// to actually enforce the stated 30-second requirement — same pattern as
// webhook/strava/route.ts's own withTimeBudget: this doesn't cancel the
// underlying query (matchNextBatch keeps running and its result still
// lands in the DB), it just stops WAITING for it and reports a timeout.
async function checkMatchingPipeline(testUserId: string | null): Promise<DiagnosticStep> {
  const name = "matching_pipeline";
  if (!testUserId) {
    return { name, status: "fail", summary: "Skipped — no test user available from sync_pipeline step", details: {}, tookMs: 0 };
  }
  const startedAt = Date.now();
  try {
    // Wrapped in its own try/catch and pre-settled as a tagged result
    // (never left to reject) — if this loses the race below, nothing is
    // ever awaiting it again, so an unhandled rejection later (e.g. a
    // connection drop mid-query, well after the 30s timeout branch has
    // already resolved this function) would otherwise be a real risk.
    const matchPromise = matchNextBatch(testUserId, 1, MATCHING_TIME_LIMIT_MS)
      .then((result) => ({ timedOut: false as const, result }))
      .catch((err) => ({ timedOut: false as const, error: err as unknown }));

    const outcome = await Promise.race([
      matchPromise,
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), MATCHING_TIME_LIMIT_MS)
      ),
    ]);
    const tookMs = Date.now() - startedAt;

    if (!outcome.timedOut && "error" in outcome) {
      return fail(name, tookMs, outcome.error);
    }

    if (outcome.timedOut) {
      return {
        name,
        status: "fail",
        summary: `matchNextBatch did not complete within the ${MATCHING_TIME_LIMIT_MS}ms limit (still running in the background — this only means the request itself isn't fast enough for a real-time flow, not that it failed)`,
        details: {},
        tookMs,
      };
    }
    const { result } = outcome;
    return {
      name,
      status: "pass",
      summary: `Completed in ${tookMs}ms (limit ${MATCHING_TIME_LIMIT_MS}ms) — checked ${result.checkedThisBatch}, matched ${result.matchedThisBatch}`,
      details: { ...result },
      tookMs,
    };
  } catch (err) {
    return fail(name, Date.now() - startedAt, err);
  }
}

// ── 5. DESCRIPTION PIPELINE ──────────────────────────────────────────────
// Read-only: fetches the activity's CURRENT description from Strava and
// stops there. Never PUTs.
async function checkDescriptionPipeline(): Promise<DiagnosticStep> {
  const name = "description_pipeline";
  try {
    const { result, tookMs } = await timed(async () => {
      const { rows } = await pool.query<{
        activity_db_id: string;
        strava_activity_id: string;
        user_id: string;
      }>(
        `SELECT a.id AS activity_db_id, a.strava_activity_id::text, a.user_id
         FROM activities a
         JOIN activity_trail_matches atm ON atm.activity_id = a.id
         ORDER BY a.created_at DESC
         LIMIT 1`
      );
      if (rows.length === 0) throw new Error("no activity with a confirmed trail match found");
      const activity = rows[0];

      const token = await getValidAccessToken(activity.user_id);
      const res = await fetchWithTimeout(
        `https://www.strava.com/api/v3/activities/${activity.strava_activity_id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        throw new Error(`GET /activities/${activity.strava_activity_id} failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { description?: string | null };
      return {
        activityDbId: activity.activity_db_id,
        stravaActivityId: activity.strava_activity_id,
        descriptionLength: body.description?.length ?? 0,
      };
    });

    return {
      name,
      status: "pass",
      summary: `Read activity ${result.stravaActivityId}'s description OK (${result.descriptionLength} char${result.descriptionLength === 1 ? "" : "s"}) — no write performed`,
      details: result,
      tookMs,
    };
  } catch (err) {
    return fail(name, 0, err);
  }
}

// ── 6. DRAIN STATUS ──────────────────────────────────────────────────────
// "Is the description backlog shrinking day over day" has no exact answer
// without a stored historical backlog-size time series, which doesn't
// exist in this schema — reporting the CURRENT backlog size plus recent
// daily throughput (sum of activities actually updated per day, from
// external_drain_batch's own logged summaries) is the honest proxy
// available: consistent nonzero throughput without the backlog visibly
// exploding is the best evidence obtainable today that it's under control.
const SCHEDULER_STALE_WARN_MS = 10 * 60_000; // cadence is ~2 min; 10 min silence is worth flagging
const SCHEDULER_STALE_FAIL_MS = 60 * 60_000; // an hour of silence means the external scheduler is very likely down

async function checkDrainStatus(): Promise<DiagnosticStep> {
  const name = "drain_status";
  try {
    const { result, tookMs } = await timed(async () => {
      const { rows: lastDrainRows } = await pool.query<{ created_at: string; detail: Record<string, unknown> }>(
        `SELECT created_at, detail FROM sync_log
         WHERE event = 'external_drain_batch'
         ORDER BY created_at DESC LIMIT 1`
      );
      const { rows: lastMatchDrainRows } = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM sync_log
         WHERE event = 'cron_match_sweep' AND detail->>'triggeredBy' = 'external-match-drain'
         ORDER BY created_at DESC LIMIT 1`
      );

      const { rows: backlogRows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n
         FROM activities a
         JOIN activity_trail_matches atm ON atm.activity_id = a.id
         JOIN users u ON u.id = a.user_id
         WHERE a.strava_description_updated = FALSE
           AND u.strava_description_updates = TRUE
           AND u.subscription_status IN ('trial', 'active')`
      );

      const { rows: throughputRows } = await pool.query<{ day: string; updated: string }>(
        `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day,
                SUM((detail->>'totalUpdated')::int) AS updated
         FROM sync_log
         WHERE event = 'external_drain_batch'
           AND detail->>'outcome' = 'completed'
           AND created_at > NOW() - INTERVAL '7 days'
         GROUP BY day
         ORDER BY day DESC`
      );

      return {
        lastDescriptionDrainAt: lastDrainRows[0]?.created_at ?? null,
        lastDescriptionDrainDetail: lastDrainRows[0]?.detail ?? null,
        lastMatchDrainAt: lastMatchDrainRows[0]?.created_at ?? null,
        currentDescriptionBacklog: parseInt(backlogRows[0].n),
        dailyThroughputLast7Days: throughputRows.map((r) => ({ day: r.day, updated: parseInt(r.updated) })),
      };
    });

    const lastDrainMs = result.lastDescriptionDrainAt ? Date.now() - new Date(result.lastDescriptionDrainAt).getTime() : Infinity;
    let status: StepStatus = "pass";
    let issue = "";
    if (lastDrainMs >= SCHEDULER_STALE_FAIL_MS) {
      status = "fail";
      issue = "external scheduler appears to be down (no drain-batch call in over an hour)";
    } else if (lastDrainMs >= SCHEDULER_STALE_WARN_MS) {
      status = "warn";
      issue = `last drain-batch call was ${Math.round(lastDrainMs / 60_000)} min ago (expected ~2 min cadence)`;
    }

    return {
      name,
      status,
      summary: issue || `Scheduler active — last call ${Math.round(lastDrainMs / 1000)}s ago, description backlog ${result.currentDescriptionBacklog}`,
      details: result,
      tookMs,
    };
  } catch (err) {
    return fail(name, 0, err);
  }
}

// ── 7. HEALTH ─────────────────────────────────────────────────────────────
// Same three checks as /api/internal/health-check's own daily sweep — see
// that route for the fuller root-cause writeups (stuck syncs, stale
// matches, orphaned pairs) — reused here in condensed form, plus an
// explicit 48-hour floor on staleness (the daily health-check flags ANY
// staleness, however fresh; this tool is asking a different question —
// "is anything stuck long enough to be a real problem," not "is there any
// background noise at all," which is normal and expected at any given
// moment).
const STUCK_SYNC_THRESHOLD_MINUTES = 60;
const STALE_MATCH_THRESHOLD_HOURS = 48;

async function checkHealth(): Promise<DiagnosticStep> {
  const name = "health";
  try {
    const { result, tookMs } = await timed(async () => {
      const { rows: stuckSyncs } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM users
         WHERE sync_status = 'syncing' AND sync_progress_at < NOW() - INTERVAL '${STUCK_SYNC_THRESHOLD_MINUTES} minutes'`
      );

      const { rows: staleMatches } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n
         FROM trail_match_checks c
         JOIN trails t ON t.id = c.trail_id
         WHERE EXISTS (
           SELECT 1 FROM activities a
           WHERE a.user_id = c.user_id AND a.geometry IS NOT NULL
             AND a.created_at > c.checked_at
             AND a.created_at < NOW() - INTERVAL '${STALE_MATCH_THRESHOLD_HOURS} hours'
             AND t.simplified_geometry && ST_Expand(a.geometry, 0.003)
         )`
      );

      // Same definition as health-check.ts's own orphaned-pairs check —
      // deliberately NOT narrowed to trail_match_checks.matched = true
      // only, for consistency with that established tool, even though most
      // of these are expected noise (activity_trail_matches is a
      // deliberately coarse candidate list — see schema.sql's comment on
      // that table; a candidate without a progress row often just means
      // the real union/intersection genuinely found no sustained overlap,
      // confirmed directly during the Luke Davis "Coast to Coast Trail"
      // investigation, 2026-09-07).
      const { rows: orphanedPairs } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n
         FROM activity_trail_matches atm
         WHERE NOT EXISTS (
           SELECT 1 FROM user_trail_progress utp
           WHERE utp.user_id = atm.user_id AND utp.trail_id = atm.trail_id
         )`
      );

      return {
        stuckSyncs: parseInt(stuckSyncs[0].n),
        staleMatchesOver48h: parseInt(staleMatches[0].n),
        orphanedPairs: parseInt(orphanedPairs[0].n),
      };
    });

    const issues: string[] = [];
    if (result.stuckSyncs > 0) issues.push(`${result.stuckSyncs} sync(s) stuck over ${STUCK_SYNC_THRESHOLD_MINUTES}min`);
    if (result.staleMatchesOver48h > 0) issues.push(`${result.staleMatchesOver48h} match(es) stale over ${STALE_MATCH_THRESHOLD_HOURS}h`);
    if (result.orphanedPairs > 0) issues.push(`${result.orphanedPairs} orphaned pair(s) (mostly expected — see comment)`);

    return {
      name,
      status: issues.length > 0 ? "warn" : "pass",
      summary: issues.length > 0 ? issues.join("; ") : "No stuck syncs, no long-stale matches, orphaned pairs within normal range",
      details: result,
      tookMs,
    };
  } catch (err) {
    return fail(name, 0, err);
  }
}

export async function runNewUserFlowDiagnostics(): Promise<DiagnosticReport> {
  const startedAt = Date.now();

  // Sequential, not Promise.all — same reasoning as admin/page.tsx's own
  // queries (this pool's sslmode=require + rejectUnauthorized:false
  // override cooperates more reliably one connection at a time than
  // several fired concurrently against a cold pool).
  const database = await checkDatabase();
  const stravaApi = await checkStravaApi();
  const { step: syncPipeline, testUserId } = await checkSyncPipeline();
  const matchingPipeline = await checkMatchingPipeline(testUserId);
  const descriptionPipeline = await checkDescriptionPipeline();
  const drainStatus = await checkDrainStatus();
  const health = await checkHealth();

  const steps = [database, stravaApi, syncPipeline, matchingPipeline, descriptionPipeline, drainStatus, health];
  const healthy = steps.every((s) => s.status === "pass");

  const report: DiagnosticReport = {
    healthy,
    ranAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    steps,
  };

  logSyncEvent(ADMIN_USER_ID, "new_user_flow_check", {
    healthy,
    tookMs: report.tookMs,
    stepStatuses: Object.fromEntries(steps.map((s) => [s.name, s.status])),
  });

  return report;
}
