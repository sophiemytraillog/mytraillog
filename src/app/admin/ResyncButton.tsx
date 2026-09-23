"use client";

import { useState } from "react";

interface ResyncCallResult {
  sync: { status: string; fetched?: number; saved?: number; skipped?: boolean };
  matching: { checkedThisBatch?: number; matchedThisBatch?: number; skipped?: boolean };
  descriptions: { checkedThisBatch?: number; updatedThisBatch?: number; skipped?: boolean };
  done: boolean;
}

export default function ResyncButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    let totalSaved = 0;
    let totalMatched = 0;
    let totalDescriptions = 0;

    try {
      // Same "keep calling until the server reports done" loop as
      // RematchButton — the server tracks progress in the DB (sync_status,
      // trail_match_checks, activity_trail_matches), not a client-held
      // offset, so this correctly resumes from wherever it left off even
      // across separate clicks.
      while (true) {
        const res = await fetch("/api/admin/resync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        const data: ResyncCallResult & { error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");

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
      Re-run sync
    </button>
  );
}
