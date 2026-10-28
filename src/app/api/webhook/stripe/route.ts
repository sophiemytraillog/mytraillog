import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { query } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { logSyncEvent } from "@/lib/sync-log";
import { sendNotificationEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

// Stripe webhook receiver. Every event is signature-verified against
// STRIPE_WEBHOOK_SECRET on the raw body before anything is trusted — without
// that, anyone could POST a fake checkout.session.completed and activate
// their own account for free. Handlers are idempotent (plain UPDATEs to a
// fixed state), so Stripe's at-least-once retries are harmless; a DB error
// returns 500 so Stripe retries it rather than the event being lost.
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — rejecting event");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(await request.text(), signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object);
        break;
      default:
        // Not subscribed to anything else; acknowledge so Stripe doesn't retry.
        break;
    }
  } catch (err) {
    console.error(`[stripe-webhook] Failed to handle ${event.type} (${event.id}):`, err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription") return;

  const userId = session.client_reference_id;
  if (!userId || !UUID_PATTERN.test(userId)) {
    console.error(`[stripe-webhook] checkout.session.completed ${session.id} has no valid client_reference_id`);
    return;
  }

  const customerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);

  const { rowCount } = await query(
    `UPDATE users
     SET subscription_status = 'active',
         stripe_customer_id = $2,
         stripe_subscription_id = $3
     WHERE id = $1`,
    [userId, customerId, subscriptionId]
  );

  if (!rowCount) {
    // Paid, but the account is gone (e.g. deleted between checkout and
    // webhook). Needs a manual look — the customer has been charged.
    console.error(`[stripe-webhook] Paid checkout ${session.id} for unknown user ${userId}`);
    await sendNotificationEmail("Stripe: payment for unknown user", [
      `Checkout session ${session.id} completed for user ${userId}, but no such user exists.`,
      `Stripe customer: ${customerId ?? "unknown"}, subscription: ${subscriptionId ?? "unknown"}.`,
      "The customer has been charged — check the account and refund or reattach manually.",
    ]);
    return;
  }

  logSyncEvent(userId, "subscription_activated", { customerId, subscriptionId, sessionId: session.id });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const { rows } = await query<{ id: string }>(
    `UPDATE users SET subscription_status = 'expired'
     WHERE stripe_subscription_id = $1
     RETURNING id`,
    [subscription.id]
  );

  if (rows.length === 0) {
    console.warn(`[stripe-webhook] customer.subscription.deleted for unknown subscription ${subscription.id}`);
    return;
  }
  for (const row of rows) {
    logSyncEvent(row.id, "subscription_expired", { subscriptionId: subscription.id });
  }
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = idOf(invoice.customer);
  const { rows } = customerId
    ? await query<{ id: string; first_name: string | null; contact_email: string | null }>(
        "SELECT id, first_name, contact_email FROM users WHERE stripe_customer_id = $1",
        [customerId]
      )
    : { rows: [] };
  const user = rows[0];

  const detail = {
    invoiceId: invoice.id,
    customerId,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    attemptCount: invoice.attempt_count,
  };
  console.warn("[stripe-webhook] invoice.payment_failed:", detail);
  if (user) logSyncEvent(user.id, "invoice_payment_failed", detail);

  await sendNotificationEmail("Stripe: subscription payment failed", [
    `A subscription payment failed for ${user ? `${user.first_name ?? "a user"} (${user.id})` : "an unknown user"}.`,
    `Contact email: ${user?.contact_email ?? "none on file"}.`,
    `Amount due: ${(invoice.amount_due / 100).toFixed(2)} ${invoice.currency.toUpperCase()}, attempt ${invoice.attempt_count}.`,
    `Stripe customer: ${customerId ?? "unknown"}, invoice: ${invoice.id}.`,
    ...(invoice.hosted_invoice_url ? [`Invoice: ${invoice.hosted_invoice_url}`] : []),
  ]);
}
