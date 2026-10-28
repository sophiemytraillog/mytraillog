import Stripe from "stripe";

// Server-only — STRIPE_SECRET_KEY must never reach a client bundle. Created
// lazily so a missing key surfaces as a clear error from the route that
// needs it rather than crashing every module that happens to import this.
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  client = new Stripe(key);
  return client;
}
