import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import ActivateForm from "./ActivateForm";

export const dynamic = "force-dynamic";

// Blocking gate between "just connected Strava" and the dashboard for any
// trial/grace_period user who hasn't provided a contact_email yet — Strava
// never exposes an athlete's email, and trial-lifecycle.ts's reminder/expiry
// emails have nowhere to go without one. 'active' accounts (the 10 founding
// beta testers) never hit this — they have no trial to activate. Dashboard's
// own page.tsx redirects here first; this page re-checks independently in
// case someone lands here directly (bookmark, back button) after already
// providing an email or having a status where the gate no longer applies.
export default async function ActivatePage() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) redirect("/");

  const { rows } = await query<{ contact_email: string | null; subscription_status: string }>(
    "SELECT contact_email, subscription_status FROM users WHERE id = $1",
    [userId]
  );
  const user = rows[0];
  if (!user) redirect("/");
  // 'expired' (a returning athlete whose previous account was deleted —
  // see strava/callback/route.ts's deleted_users check, 2026-09-30) has no
  // trial to activate at all — straight to /subscribe instead, not this
  // trial-activation form.
  if (user.subscription_status === "expired") redirect("/subscribe");
  if (user.contact_email || user.subscription_status === "active") redirect("/dashboard");

  return <ActivateForm />;
}
