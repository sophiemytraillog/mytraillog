"use client";

import { useState } from "react";

// The one way into payment: POSTs to /api/checkout, which creates a Stripe
// Checkout Session, then sends the browser to Stripe's hosted page. Every
// Subscribe button on the site renders this so they can't drift apart.
export default function SubscribeButton({
  className,
  wrapperClassName,
  children = "Subscribe",
}: {
  className?: string;
  wrapperClassName?: string;
  children?: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.url) {
        window.location.href = body.url;
        return; // Stay in the loading state while the browser navigates away.
      }
      if (res.status === 409) {
        window.location.href = "/dashboard";
        return;
      }
      setError("Couldn't start checkout - please try again.");
    } catch {
      setError("Couldn't start checkout - please try again.");
    }
    setLoading(false);
  }

  return (
    <span className={`inline-flex flex-col items-stretch ${wrapperClassName ?? ""}`}>
      <button type="button" onClick={startCheckout} disabled={loading} className={`${className ?? ""} disabled:opacity-70 disabled:cursor-wait`}>
        {loading ? "Redirecting…" : children}
      </button>
      {error && <span className="text-xs mt-1.5 opacity-90">{error}</span>}
    </span>
  );
}
