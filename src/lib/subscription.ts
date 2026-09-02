// No imports here, deliberately — this file is shared by both server code
// (API routes, server components) AND client components (DashboardClient,
// TrailActions, SyncButton, UpdateDescriptionsButton all need
// hasBasicAccess/hasPremiumAccess to decide what to render). Pulling in
// db.ts's `pool` (a Node-only pg Pool) here would drag it into the client
// bundle the moment any client component imported this file. The one
// DB-touching helper (getSubscriptionStatus) lives in subscription-db.ts
// instead, server-only.

// Single source of truth for what each subscription_status can do — see
// schema.sql's trial-tracking comments for how these values get set.
// 'expired' is kept in the type/CHECK constraint for forward compatibility
// but shouldn't actually persist in practice: the 14-day grace_period cron
// cleanup (trial-lifecycle.ts) deletes the account outright rather than
// transitioning it to 'expired'.
export type SubscriptionStatus = "trial" | "active" | "expired" | "grace_period";

// Trial and active (paid, or a founding beta tester) both get the "basic"
// feature set: sync, matching, new-activity descriptions, gap fill/mark
// complete, cycling toggle. grace_period and expired do not — per the
// 2026-09-30 request, everything they built during the trial stays fully
// viewable, but nothing new gets added and no mutating action is allowed.
export function hasBasicAccess(status: SubscriptionStatus | string | null | undefined): boolean {
  return status === "trial" || status === "active";
}

// Historical description backfill is the one feature trial users DON'T get
// — it's paid-only, unlike everything else hasBasicAccess covers.
export function hasPremiumAccess(status: SubscriptionStatus | string | null | undefined): boolean {
  return status === "active";
}
