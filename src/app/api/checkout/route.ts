import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";

const SUCCESS_URL = "https://www.mytraillog.com/dashboard?subscribed=true";
const CANCEL_URL = "https://www.mytraillog.com/pricing";

// Creates a Stripe Checkout Session for the £12.99/year subscription and
// returns its hosted-page URL — SubscribeButton redirects the browser there.
// The user is identified to the webhook via client_reference_id (and
// subscription metadata as a backup), never via anything the browser sends.
export async function POST() {
  const userId = cookies().get("strava_user_id")?.value;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    console.error("[checkout] STRIPE_PRICE_ID is not set");
    return NextResponse.json({ error: "Payments are not configured" }, { status: 500 });
  }

  const { rows } = await query<{
    subscription_status: string;
    contact_email: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  }>(
    `SELECT subscription_status, contact_email, stripe_customer_id, stripe_subscription_id
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = rows[0];
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Guards against a second, double-billed subscription (a double click, a
  // stale tab). Founding testers are 'active' with no Stripe subscription
  // and never see a Subscribe button, so they aren't caught by this.
  if (user.subscription_status === "active" && user.stripe_subscription_id) {
    return NextResponse.json({ error: "Already subscribed" }, { status: 409 });
  }

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      subscription_data: { metadata: { user_id: userId } },
      // Reuse the Stripe customer from a previous (since cancelled)
      // subscription rather than creating a duplicate customer record.
      ...(user.stripe_customer_id
        ? { customer: user.stripe_customer_id }
        : user.contact_email
          ? { customer_email: user.contact_email }
          : {}),
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    if (!session.url) throw new Error("Checkout Session has no url");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[checkout] Failed to create Checkout Session:", err);
    return NextResponse.json({ error: "Could not start checkout" }, { status: 500 });
  }
}
