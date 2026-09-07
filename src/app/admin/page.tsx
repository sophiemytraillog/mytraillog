import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import { ADMIN_USER_ID } from "@/lib/admin";
import RematchButton from "./RematchButton";
import GenerateInviteCodeButton from "./GenerateInviteCodeButton";
import SystemHealthButton from "./SystemHealthButton";

// Keep in sync with DAILY_UPDATE_BUDGET in src/lib/trail-descriptions.ts —
// backfill_api_usage is the only Strava call counter this app keeps; there's no
// tracking of total daily calls across sync/webhook/etc., only this one feature's
// self-imposed share of Strava's app-wide quota.
const BACKFILL_DAILY_UPDATE_LIMIT = 750;

export const dynamic = "force-dynamic";

interface TotalsRow {
  total_users: string;
  total_activities: string;
  total_matches: string;
}

interface NewUsersRow {
  new_week: string;
  new_month: string;
}

interface PopularTrailRow {
  name: string;
  slug: string;
  user_count: string;
}

interface RequestedTrailRow {
  trail_name: string;
  region: string | null;
  request_count: string;
  last_requested: string;
}

interface ApiUsageRow {
  calls_used: number;
}

interface InviteCodeRow {
  code: string;
  created_at: string;
  used_by: string | null;
  used_at: string | null;
  used_by_name: string | null;
}

interface WaitlistRow {
  email: string;
  signed_up_at: string;
}

interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  activity_count: string;
  trail_match_count: string;
  sync_status: string;
  stale_sync: boolean;
  geometry_count: string;
}

function formatDate(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#E5DED4] rounded-2xl px-4 py-3.5">
      <p className="text-[#8A7F72] text-xs mb-1.5">{label}</p>
      <p className="text-2xl font-bold text-[#2C2520] tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[#8A7F72]/70 text-xs mt-1.5">{sub}</p>}
    </div>
  );
}

export default async function AdminPage() {
  const userId = cookies().get("strava_user_id")?.value;
  if (userId !== ADMIN_USER_ID) notFound();

  // Sequential, not Promise.all — DATABASE_URL's sslmode=require is treated
  // as verify-full by newer pg versions, which only reliably cooperates with
  // this pool's rejectUnauthorized:false override one connection at a time.
  // Every other page in this app awaits its queries in sequence for the same
  // reason; firing several at once against a cold pool intermittently threw
  // "self-signed certificate in certificate chain".
  const totalsResult = await query<TotalsRow>(
    `SELECT
       (SELECT COUNT(*) FROM users)               AS total_users,
       (SELECT COUNT(*) FROM activities)           AS total_activities,
       (SELECT COUNT(*) FROM user_trail_progress)  AS total_matches`
  );
  const newUsersResult = await query<NewUsersRow>(
    `SELECT
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS new_week,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS new_month
     FROM users`
  );
  const popularTrailsResult = await query<PopularTrailRow>(
    `SELECT t.name, t.slug, COUNT(DISTINCT utp.user_id) AS user_count
     FROM user_trail_progress utp
     JOIN trails t ON t.id = utp.trail_id
     WHERE utp.completion_percentage > 0
     GROUP BY t.id, t.name, t.slug
     ORDER BY user_count DESC, t.name ASC
     LIMIT 10`
  );
  const requestedTrailsResult = await query<RequestedTrailRow>(
    `SELECT trail_name, MAX(region) AS region, COUNT(*) AS request_count, MAX(created_at) AS last_requested
     FROM trail_requests
     GROUP BY trail_name
     ORDER BY request_count DESC, last_requested DESC
     LIMIT 10`
  );
  const apiUsageResult = await query<ApiUsageRow>(
    `SELECT calls_used FROM backfill_api_usage WHERE usage_date = CURRENT_DATE`
  );
  const inviteCodesResult = await query<InviteCodeRow>(
    `SELECT ic.code, ic.created_at, ic.used_by, ic.used_at,
            NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS used_by_name
     FROM invite_codes ic
     LEFT JOIN users u ON u.id = ic.used_by
     ORDER BY ic.created_at DESC`
  );
  const waitlistResult = await query<WaitlistRow>(
    `SELECT email, signed_up_at FROM waitlist ORDER BY signed_up_at DESC`
  );
  // Two separate LEFT JOINs straight to users (one to activities, one to
  // user_trail_progress) multiply against each other before GROUP BY
  // collapses them — for a user with 4,017 activities and 170 matched
  // trails that's 683,000+ intermediate rows just for one account, ~1.9M
  // across all users, each one evaluating a.geometry (PostGIS data). That
  // blew Postgres's work_mem and spilled a temp file large enough to hit
  // "No space left on device" (error 53100) in production — not a real
  // disk-capacity issue (the whole DB is 151MB), just this query's fan-out.
  // Pre-aggregating each table separately first means each join side is
  // already one row per user, so there's nothing left to multiply.
  const usersResult = await query<UserRow>(
    `SELECT u.id, u.first_name, u.last_name, u.created_at, u.sync_status,
            (u.sync_status = 'syncing' AND u.sync_progress_at < NOW() - INTERVAL '3 minutes') AS stale_sync,
            COALESCE(ac.activity_count, 0)::text AS activity_count,
            COALESCE(ac.geometry_count, 0)::text AS geometry_count,
            COALESCE(tc.trail_match_count, 0)::text AS trail_match_count
     FROM users u
     LEFT JOIN (
       SELECT user_id,
              COUNT(*) AS activity_count,
              COUNT(*) FILTER (WHERE geometry IS NOT NULL) AS geometry_count
       FROM activities
       GROUP BY user_id
     ) ac ON ac.user_id = u.id
     LEFT JOIN (
       SELECT user_id, COUNT(DISTINCT trail_id) AS trail_match_count
       FROM user_trail_progress
       GROUP BY user_id
     ) tc ON tc.user_id = u.id
     ORDER BY u.created_at DESC`
  );

  const totals = totalsResult.rows[0];
  const newUsers = newUsersResult.rows[0];
  const popularTrails = popularTrailsResult.rows;
  const requestedTrails = requestedTrailsResult.rows;
  const callsUsedToday = apiUsageResult.rows[0]?.calls_used ?? 0;
  const users = usersResult.rows;
  const inviteCodes = inviteCodesResult.rows;
  const activeCodes = inviteCodes.filter((c) => !c.used_by);
  const usedCodes = inviteCodes.filter((c) => c.used_by);
  const waitlist = waitlistResult.rows;

  return (
    <div className="min-h-screen bg-[#FAF8F5] px-6 py-10">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-[#2C2520] tracking-tight mb-1">Admin</h1>
        <p className="text-[#8A7F72] text-sm mb-4">Internal stats - visible only to your account.</p>

        {/* ── System Health ─────────────────────────────────────────── */}
        <div className="mb-8">
          <SystemHealthButton />
        </div>

        {/* ── Stat cards ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-10">
          <StatCard label="Total users" value={totals.total_users} />
          <StatCard label="New users (7d)" value={newUsers.new_week} />
          <StatCard label="New users (30d)" value={newUsers.new_month} />
          <StatCard label="Activities synced" value={totals.total_activities} />
          <StatCard label="Trail matches" value={totals.total_matches} />
          <StatCard label="Active invite codes" value={String(activeCodes.length)} />
          <StatCard label="Waitlist signups" value={String(waitlist.length)} />
          <StatCard
            label="Backfill API calls today"
            value={`${callsUsedToday}/${BACKFILL_DAILY_UPDATE_LIMIT * 2}`}
            sub="Description-update backlog only - shared across all users"
          />
        </div>

        {/* ── Invite codes & waitlist ────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          <div className="bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E5DED4] flex items-center justify-between gap-3">
              <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                Invite codes
              </p>
              <GenerateInviteCodeButton />
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-[#E5DED4]">
              {activeCodes.length === 0 && usedCodes.length === 0 && (
                <p className="text-[#8A7F72] text-sm px-4 py-4">No invite codes yet.</p>
              )}
              {activeCodes.map((c) => (
                <div key={c.code} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[#2C2520] font-mono tracking-wide">{c.code}</span>
                  <span className="text-xs text-[#4A7C59] font-medium">Active</span>
                </div>
              ))}
              {usedCodes.map((c) => (
                <div key={c.code} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[#8A7F72] font-mono tracking-wide line-through decoration-[#8A7F72]/40">
                    {c.code}
                  </span>
                  <span className="text-xs text-[#8A7F72] text-right">
                    Used{c.used_by_name ? ` by ${c.used_by_name}` : ""}
                    {c.used_at ? ` · ${formatDate(c.used_at)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E5DED4]">
              <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                Waitlist ({waitlist.length})
              </p>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-[#E5DED4]">
              {waitlist.length === 0 && (
                <p className="text-[#8A7F72] text-sm px-4 py-4">No waitlist signups yet.</p>
              )}
              {waitlist.map((w) => (
                <div key={w.email} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[#2C2520] truncate mr-3">{w.email}</span>
                  <span className="text-xs text-[#8A7F72] shrink-0">{formatDate(w.signed_up_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          {/* ── Most popular trails ──────────────────────────────── */}
          <div className="bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E5DED4]">
              <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                Most popular trails
              </p>
            </div>
            <div className="divide-y divide-[#E5DED4]">
              {popularTrails.length === 0 && (
                <p className="text-[#8A7F72] text-sm px-4 py-4">No trail progress recorded yet.</p>
              )}
              {popularTrails.map((t, i) => (
                <div key={t.slug} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[#2C2520] truncate mr-3">
                    <span className="text-[#8A7F72] tabular-nums mr-2">{i + 1}.</span>
                    {t.name}
                  </span>
                  <span className="text-sm text-[#8A7F72] tabular-nums shrink-0">
                    {t.user_count} user{t.user_count === "1" ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Most requested trails ────────────────────────────── */}
          <div className="bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E5DED4]">
              <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                Most requested trails
              </p>
            </div>
            <div className="divide-y divide-[#E5DED4]">
              {requestedTrails.length === 0 && (
                <p className="text-[#8A7F72] text-sm px-4 py-4">No trail requests yet.</p>
              )}
              {requestedTrails.map((t, i) => (
                <div key={t.trail_name} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[#2C2520] truncate mr-3">
                    <span className="text-[#8A7F72] tabular-nums mr-2">{i + 1}.</span>
                    {t.trail_name}
                    {t.region && <span className="text-[#8A7F72]/70"> - {t.region}</span>}
                  </span>
                  <span className="text-sm text-[#8A7F72] tabular-nums shrink-0">
                    {t.request_count}×
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── All users ─────────────────────────────────────────── */}
        <div className="bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E5DED4]">
            <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
              All users ({users.length})
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[#8A7F72] text-xs border-b border-[#E5DED4]">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Joined</th>
                  <th className="px-4 py-2 font-medium">Sync status</th>
                  <th className="px-4 py-2 font-medium text-right">Activities</th>
                  <th className="px-4 py-2 font-medium text-right">Trails matched</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5DED4]">
                {users.map((u) => {
                  // Same anomaly this whole page exists to catch: activities
                  // with real geometry but nothing matched to any trail.
                  const anomaly = parseInt(u.geometry_count) > 0 && parseInt(u.trail_match_count) === 0;
                  return (
                    <tr key={u.id}>
                      <td className="px-4 py-2.5 text-[#2C2520]">
                        {u.first_name} {u.last_name}
                      </td>
                      <td className="px-4 py-2.5 text-[#8A7F72]">{formatDate(u.created_at)}</td>
                      <td className="px-4 py-2.5">
                        {u.stale_sync ? (
                          <span className="text-[#C4652A] font-medium">stuck syncing</span>
                        ) : (
                          <span className="text-[#8A7F72]">{u.sync_status}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-[#2C2520] text-right tabular-nums">
                        {u.activity_count}
                      </td>
                      <td className={`px-4 py-2.5 text-right tabular-nums ${anomaly ? "text-[#C4652A] font-medium" : "text-[#2C2520]"}`}>
                        {u.trail_match_count}
                      </td>
                      <td className="px-4 py-2.5">
                        <RematchButton userId={u.id} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
