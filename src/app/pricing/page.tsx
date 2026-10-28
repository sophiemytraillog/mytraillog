import { redirect } from "next/navigation";

// Stripe Checkout's cancel_url (see /api/checkout). There's no separate
// pricing page yet — /subscribe is it, and it already routes signed-out or
// non-expired users onward to wherever they belong.
export default function PricingPage() {
  redirect("/subscribe");
}
