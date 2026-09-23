"use client";

import { useState } from "react";

interface ResyncCallResult {
  sync: { status: string; fetched?: number; saved?: number; skipped?: boolean };
  matching: { checkedThisBatch?: number; matchedThisBatch?: number; skipped?: boolean };
  descriptions: { checkedThisBatch?: number; updatedThisBatch?: number; skipped?: boolean };
  done: boolean;
}

// Single "push this one along" button for /admin (2026-09-23 request,
// replacing the earlier separate "Re-run sync" / "Re-run matching"
// buttons) — one click drives sync, then matching, then descriptions for
// one user, same three phases drain-batch runs on its own schedule for
// whichever account is most overdue, just scoped to a specific user and
// triggered on demand instead of waiting for the next external drain run.
export default function KickUserButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    let totalSaved = 0;
    let totalMatched = 0;
    let totalDescriptions = 0;

    try {
      // Same "keep calling until the server reports done" loop as the
      // previous admin buttons — the server tracks progress in the DB
      // (sync_status, trail_match_checks, activity_trail_matches), not a
      // client-held offset, so this correctly resumes from wherever it
      // left off even across separate clicks.
      while (true) {
        const res = await fetch("/api/admin/resync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        // A killed serverless invocation returns Vercel's own HTML 504 page
        // (or any other non-JSON body), not this route's own JSON — a bare
        // res.json() crashes on that with a raw, confusing "Unexpected
        // token 'A', "An error o"... is not valid JSON" instead of a
        // readable error. Confirmed happening in practice for Luke Davis,
        // 2026-09-23 — this route's three phases (sync + matching +
        // descriptions) can occasionally still add up to more than
        // Vercel's 60s cap despite the shared time budget (see route.ts's
        // hard-deadline fix). Read as text first so a bad response always
        // becomes a normal error message here regardless of what's
        // actually wrong server-side.
        const rawBody = await res.text();
        let data: (ResyncCallResult & { error?: string }) | { error: string };
        try {
          data = JSON.parse(rawBody);
        } catch {
          throw new Error(res.ok ? "Server returned an invalid response" : `Request timed out (HTTP ${res.status}) — try again`);
        }
        if (!res.ok || "error" in data) throw new Error(("error" in data && data.error) || "Request failed");

        totalSaved += data.sync.saved ?? 0;
        totalMatched += data.matching.matchedThisBatch ?? 0;
        totalDescriptions += data.descriptions.updatedThisBatch ?? 0;
        setMessage(
          `Sync: ${data.sync.status}${data.sync.saved ? ` (+${data.sync.saved})` : ""} · ` +
          `Matched +${data.matching.matchedThisBatch ?? 0} · Descriptions +${data.descriptions.updatedThisBatch ?? 0}…`
        );

        if (data.done) break;
      }
      setState("done");
      setMessage(
        `+${totalSaved} activities · +${totalMatched} trails matched · +${totalDescriptions} descriptions`
      );
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  }

  if (state === "running") {
    return <span className="text-[#8A7F72] text-xs">{message || "Running…"}</span>;
  }

  if (state === "done" || state === "error") {
    return (
      <span className={`text-xs ${state === "error" ? "text-[#C4652A]" : "text-[#4A7C59]"}`}>
        {message}
      </span>
    );
  }

  return (
    <button
      onClick={run}
      className="text-[#C4652A]/70 hover:text-[#C4652A] text-xs font-medium underline underline-offset-2 transition-colors"
    >
      Kick user
    </button>
  );
}
