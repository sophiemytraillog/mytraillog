import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { query } from "@/lib/db";
import { getMatchProgress } from "@/lib/match-trails";
import { triggerMatchChain } from "@/lib/match-chain";
import { triggerDrainIfNotRunToday } from "@/lib/description-chain";
import { hasBasicAccess, type SubscriptionStatus } from "@/lib/subscription";
import DashboardClient, { type TrailRow } from "./DashboardClient";

interface Athlete {
  id: number;
  firstname: string;
  lastname: string;
  username: string;
  profile: string;
}

interface UserStats {
  last_synced_at: Date | null;
  sync_status: string;
  activity_count: string;
}

// A sync that's been sitting in "syncing" with no heartbeat for this long
// has almost certainly been abandoned client-side (browser tab closed,
// navigated away, backgrounded on mobile) partway through a multi-chunk
// sync — there's no server-side process that would still be running after
// this much silence. sync_progress_at is updated after every fetched Strava
// page (see sync-engine.ts), which happens every second or two under normal
// conditions, so a genuinely still-active sync's heartbeat resets this clock
// well before it fires.
//
// Tightened from 3 minutes to 1 minute (2026-09-04) — new users are the
// most likely to hit a stalled sync (they're the ones watching a large
// first-time backfill happen, most likely to be the tab that gets closed
// mid-flight) and were also the ones waiting longest to see it self-heal.
const STALE_SYNC_THRESHOLD_SECONDS = 60;

export default async function Dashboard({
  searchParams,
}: {
  searchParams?: { autoSync?: string };
}) {
  const cookieStore = cookies();
  const athleteCookie = cookieStore.get("strava_athlete");
  const userId = cookieStore.get("strava_user_id")?.value;

  if (!athleteCookie) redirect("/");

  const athlete: Athlete = JSON.parse(athleteCookie.value);
  const requestedAutoSync = searchParams?.autoSync === "true";

  let stats: UserStats | null = null;
  let stravaDescriptionUpdates = false;
  let descriptionMode: "full" | "new_only" | "new_with_totals" = "full";
  let stravaScope: string | null = null;
  let includeCycling = false;
  let staleSync = false;
  let subscriptionStatus: SubscriptionStatus = "trial";
  let trialEndsAt: Date | null = null;
  let contactEmail: string | null = null;
  if (userId) {
    try {
      const result = await query<
        UserStats & {
          strava_description_updates: boolean;
          description_mode: "full" | "new_only" | "new_with_totals";
          strava_scope: string | null;
          include_cycling: boolean;
          stale_sync: boolean;
          subscription_status: SubscriptionStatus;
          trial_ends_at: Date | null;
          contact_email: string | null;
        }
      >(
        `SELECT u.last_synced_at,
                u.sync_status,
                u.strava_description_updates,
                u.description_mode,
                u.strava_scope,
                u.include_cycling,
                (u.sync_status = 'syncing'
                  AND u.sync_progress_at < NOW() - INTERVAL '${STALE_SYNC_THRESHOLD_SECONDS} seconds'
                ) AS stale_sync,
                u.subscription_status,
                u.trial_ends_at,
                u.contact_email,
                COUNT(a.id)::text AS activity_count
         FROM users u
         LEFT JOIN activities a ON a.user_id = u.id
         WHERE u.id = $1
         GROUP BY u.last_synced_at, u.sync_status, u.strava_description_updates,
                  u.description_mode, u.strava_scope, u.include_cycling, u.sync_progress_at,
                  u.subscription_status, u.trial_ends_at, u.contact_email`,
        [userId]
      );
      stats = result.rows[0] ?? null;
      stravaDescriptionUpdates = result.rows[0]?.strava_description_updates ?? false;
      descriptionMode = result.rows[0]?.description_mode ?? "full";
      stravaScope = result.rows[0]?.strava_scope ?? null;
      includeCycling = result.rows[0]?.include_cycling ?? false;
      staleSync = result.rows[0]?.stale_sync ?? false;
      subscriptionStatus = result.rows[0]?.subscription_status ?? "trial";
      trialEndsAt = result.rows[0]?.trial_ends_at ?? null;
      contactEmail = result.rows[0]?.contact_email ?? null;
    } catch (err) {
      console.error("[dashboard] Failed to load stats:", err);
    }
  }

  // Blocking gate: trial/grace_period accounts without a contact_email on
  // file get sent to /activate instead of the dashboard — Strava never
  // exposes an athlete's email, and trial-lifecycle.ts's reminder/expiry
  // emails have nowhere to go without one. 'active' accounts (the 10
  // founding beta testers) never hit this.
  if (
    userId &&
    !contactEmail &&
    (subscriptionStatus === "trial" || subscriptionStatus === "grace_period")
  ) {
    redirect("/activate");
  }

  // Blocking gate: 'expired' accounts (a returning athlete whose previous
  // account was deleted after their trial + grace_period ran out — see
  // strava/callback/route.ts's deleted_users check, 2026-09-30) get no
  // dashboard at all, not even a locked/read-only one — there's nothing to
  // show them since their old row is gone and this is a brand-new one.
  // Straight to /subscribe until they pay.
  if (userId && subscriptionStatus === "expired") {
    redirect("/subscribe");
  }

  // Self-heal nudge: resume automatically on this visit if the last sync
  // attempt looks abandoned, exactly as if the user had clicked "Sync
  // Activities" themselves — runSyncChunk resumes from wherever the stored
  // activities' MIN/MAX(start_date) bounds left off, so this is always safe
  // to re-fire, never re-fetches from scratch.
  const autoSync = requestedAutoSync || staleSync;

  const activityCount = parseInt(stats?.activity_count ?? "0");

  let trails: TrailRow[] = [];
  if (userId) {
    try {
      const trailResult = await query<TrailRow>(
        `SELECT
           t.id,
           t.slug,
           t.name,
           t.region,
           t.total_distance,
           t.parent_trail_id,
           LEAST(
             CASE WHEN t.total_distance > 0
               THEN (COALESCE(utp.completed_distance, 0) + COALESCE(ms.manual_m, 0))
                    / t.total_distance * 100
               ELSE COALESCE(utp.completion_percentage, 0) END,
             100
           )                                                                         AS completion_percentage,
           LEAST(
             COALESCE(utp.completed_distance, 0) + COALESCE(ms.manual_m, 0),
             t.total_distance
           )                                                                         AS completed_distance,
           utp.activity_count,
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(t.geometry, 0.005))::json        AS trail_geojson,
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(utp.completed_geometry, 0.005))::json AS completed_geojson,
           COALESCE(t.category, 'national_trail')                                   AS category
         FROM trails t
         LEFT JOIN user_trail_progress utp
           ON utp.trail_id = t.id AND utp.user_id = $1
         LEFT JOIN (
           SELECT trail_id, SUM(ST_Length(geometry::geography)) AS manual_m
           FROM user_trail_manual_segments
           WHERE user_id = $1
           GROUP BY trail_id
         ) ms ON ms.trail_id = t.id
         ORDER BY
           completion_percentage DESC,
           t.name ASC`,
        [userId]
      );
      trails = trailResult.rows;
    } catch (err) {
      console.error("[dashboard] Failed to load trail progress:", err);
    }
  }

  // How far finishSync's capped inline matching (and any continuation
  // since) has gotten through the trail catalog — TrailMatchProgress uses
  // this to show "Matching trails: X of Y checked" and picks up wherever
  // this left off instead of waiting on the daily cron sweep.
  let matchProgress = { totalChecked: 0, totalTrails: 0 };
  if (userId) {
    try {
      matchProgress = await getMatchProgress(userId);
    } catch (err) {
      console.error("[dashboard] Failed to load match progress:", err);
    }

    // Covers the account that finished syncing in an earlier session but
    // never got all the way through the trail catalog (finishSync's inline
    // pass is capped — see MAX_TRAILS_PER_FINISH_SYNC) — /api/sync/activities
    // only fires this chain when an actual sync just ran, so a user who
    // just opens the dashboard with leftover matching from before needs
    // this trigger too. Harmless if a chain is already running (matchNextBatch's
    // upserts are idempotent) or already done (an immediate no-op).
    if (matchProgress.totalChecked < matchProgress.totalTrails && hasBasicAccess(subscriptionStatus)) {
      waitUntil(triggerMatchChain(userId));
    }

    // Backup for the daily cron drain, which isn't reliable enough on its
    // own (see description-chain.ts's triggerDrainIfNotRunToday) — cheap
    // no-op once today's drain has actually run from any source.
    waitUntil(triggerDrainIfNotRunToday());
  }

  return (
    <DashboardClient
      athlete={athlete}
      stats={stats}
      trails={trails}
      activityCount={activityCount}
      autoSync={autoSync}
      stravaDescriptionUpdates={stravaDescriptionUpdates}
      descriptionMode={descriptionMode}
      hasWriteScope={stravaScope?.includes("activity:write") ?? false}
      includeCycling={includeCycling}
      matchProgress={matchProgress}
      subscriptionStatus={subscriptionStatus}
      trialEndsAt={trialEndsAt}
      contactEmail={contactEmail}
    />
  );
}
