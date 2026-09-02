"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ActivateForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_email: trimmed }),
      });
      if (!res.ok) {
        setError("Please enter a valid email address.");
        return;
      }
      router.push("/dashboard?autoSync=true");
    } catch {
      setError("Something went wrong - please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-2xl font-bold text-[#2C2520] mb-2 leading-snug">
          Enter your email to activate your free trial
        </h1>
        <p className="text-[#8A7F72] text-sm mb-6 leading-relaxed">
          Strava doesn&apos;t share your email with us - we need one to activate your trial and send
          account notifications.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="contact-email" className="sr-only">
            Email address
          </label>
          <input
            id="contact-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="px-4 py-3 rounded-xl border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 text-center focus:outline-none focus:ring-2 focus:ring-[#C4652A]/40"
          />
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-3 rounded-xl bg-[#C4652A] text-white font-semibold hover:bg-[#C4652A]/90 transition-colors disabled:opacity-50"
          >
            {submitting ? "Activating…" : "Activate my trial"}
          </button>
        </form>
        {error && <p className="text-[#C4652A] text-xs mt-3">{error}</p>}
        <p className="text-[#8A7F72]/60 text-xs mt-5">
          We&apos;ll only use this for account notifications - no spam.
        </p>
      </div>
    </div>
  );
}
