import { pool } from "./db";
import type { SubscriptionStatus } from "./subscription";

// Single round-trip helper for the ~8 API routes that need to gate a
// mutating action on subscription status but don't already have it loaded
// (unlike dashboard/page.tsx and trail/[slug]/page.tsx, which fetch it
// alongside other per-page data). Returns null if the user doesn't exist.
// Server-only (imports pool/pg) — see subscription.ts's top comment for why
// this is a separate file from the client-safe hasBasicAccess/hasPremiumAccess.
export async function getSubscriptionStatus(userId: string): Promise<SubscriptionStatus | null> {
  const { rows } = await pool.query<{ subscription_status: SubscriptionStatus }>(
    "SELECT subscription_status FROM users WHERE id = $1",
    [userId]
  );
  return rows[0]?.subscription_status ?? null;
}
