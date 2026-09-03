import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// Blocking gate for 'expired' accounts — a returning athlete whose previous
// account was deleted after their trial + grace_period ran out (see
// strava/callback/route.ts's deleted_users check, 2026-09-30). Their new
// row has zero data (nothing to sync/match/show), so unlike /activate this
// isn't "one field then through to the dashboard" — there's no dashboard to
// go to until they actually pay. Re-checks independently (bookmark, back
// button) in case subscription_status has since been flipped to 'active'
// (see trial-lifecycle.ts's comment on why that's the whole re-subscribe
// flow for now, no Stripe yet) — this page isn't meant to be a permanent trap.
export default async function SubscribePage() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) redirect("/");

  const { rows } = await query<{ first_name: string | null; subscription_status: string }>(
    "SELECT first_name, subscription_status FROM users WHERE id = $1",
    [userId]
  );
  const user = rows[0];
  if (!user) redirect("/");
  if (user.subscription_status !== "expired") redirect("/dashboard");

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-2xl font-bold text-[#2C2520] mb-2 leading-snug">
          Welcome back{user.first_name ? `, ${user.first_name}` : ""}!
        </h1>
        <p className="text-[#8A7F72] text-sm mb-6 leading-relaxed">
          Subscribe for £12.99/year to continue tracking your trails.
        </p>
        <a
          href="mailto:mytrailloguk@gmail.com?subject=Subscribe%20to%20My%20Trail%20Log"
          className="inline-block px-6 py-3 rounded-xl bg-[#C4652A] text-white font-semibold hover:bg-[#C4652A]/90 transition-colors"
        >
          Subscribe
        </a>
        <p className="text-[#8A7F72]/60 text-xs mt-5 leading-relaxed">
          Your free trial has already been used on this Strava account, so this one starts straight
          into a subscription rather than another trial.
        </p>
      </div>
    </div>
  );
}
