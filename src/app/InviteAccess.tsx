"use client";

import { useEffect, useRef, useState } from "react";

type CodeStatus = "idle" | "checking" | "valid" | "invalid";
type WaitlistStatus = "idle" | "submitting" | "done" | "error";

export default function InviteAccess() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<CodeStatus>("idle");
  const [showWaitlist, setShowWaitlist] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistStatus, setWaitlistStatus] = useState<WaitlistStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) {
      setStatus("idle");
      return;
    }

    setStatus("checking");
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/invite-codes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });
        const data = await res.json();
        setStatus(data.valid ? "valid" : "invalid");
      } catch {
        setStatus("invalid");
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [code]);

  async function submitWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setWaitlistStatus("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: waitlistEmail }),
      });
      if (!res.ok) throw new Error();
      setWaitlistStatus("done");
    } catch {
      setWaitlistStatus("error");
    }
  }

  // The button is never client-side disabled: whether a code is actually
  // required depends on whether this is a brand-new Strava athlete, which
  // only the server can know (via strava_id) — and only after the OAuth
  // round-trip completes. Returning users can just click straight through;
  // the callback route skips the invite check entirely for them. A new
  // user with no code (or a bad one) gets sent to Strava and back with
  // ?error=invalid_invite, shown via the banner above.
  const trimmedCode = code.trim();
  const stravaHref = trimmedCode
    ? `/api/auth/strava?invite=${encodeURIComponent(trimmedCode)}`
    : "/api/auth/strava";

  return (
    <div id="get-started" className="max-w-sm mx-auto scroll-mt-10">
      <div className="mb-4">
        <label htmlFor="invite-code" className="sr-only">
          Invite code
        </label>
        <input
          id="invite-code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Enter invite code"
          autoComplete="off"
          autoCapitalize="characters"
          className="w-full px-4 py-3 rounded-xl border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/50 text-center tracking-widest font-medium focus:outline-none focus:ring-2 focus:ring-[#C4652A]/40"
        />
        {status === "invalid" && (
          <p className="text-[#C4652A] text-xs mt-1.5">Invite code not recognised or already used.</p>
        )}
        {status === "valid" && <p className="text-[#4A7C59] text-xs mt-1.5">Code accepted — you&apos;re in!</p>}
        {status === "idle" && (
          <p className="text-[#8A7F72]/70 text-xs mt-1.5">Already connected before? Leave this blank and connect below.</p>
        )}
      </div>

      <a
        href={stravaHref}
        className="inline-block hover:-translate-y-0.5 active:translate-y-0 transition-transform duration-200"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/strava/btn_strava_connect_with_orange.svg"
          alt="Connect with Strava"
          style={{ height: "48px", width: "auto" }}
        />
      </a>

      <div className="mt-6">
        {!showWaitlist ? (
          <button
            type="button"
            onClick={() => setShowWaitlist(true)}
            className="text-[#8A7F72] text-sm underline underline-offset-2 hover:text-[#2C2520] transition-colors"
          >
            Don&apos;t have a code? Join the waitlist
          </button>
        ) : waitlistStatus === "done" ? (
          <p className="text-[#4A7C59] text-sm">You&apos;re on the list — we&apos;ll email you when a spot opens up.</p>
        ) : (
          <form onSubmit={submitWaitlist} className="flex flex-col sm:flex-row gap-2 items-center justify-center">
            <label htmlFor="waitlist-email" className="sr-only">
              Email address
            </label>
            <input
              id="waitlist-email"
              type="email"
              required
              value={waitlistEmail}
              onChange={(e) => setWaitlistEmail(e.target.value)}
              placeholder="you@example.com"
              className="px-3 py-2.5 rounded-lg border border-[#E5DED4] bg-white text-sm text-[#2C2520] focus:outline-none focus:ring-2 focus:ring-[#C4652A]/40 w-full sm:w-auto"
            />
            <button
              type="submit"
              disabled={waitlistStatus === "submitting"}
              className="px-4 py-2.5 rounded-lg bg-[#2C2520] text-white text-sm font-medium hover:bg-[#2C2520]/90 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {waitlistStatus === "submitting" ? "Joining…" : "Join waitlist"}
            </button>
          </form>
        )}
        {waitlistStatus === "error" && (
          <p className="text-[#C4652A] text-xs mt-1.5">Something went wrong — please try again.</p>
        )}
      </div>
    </div>
  );
}
