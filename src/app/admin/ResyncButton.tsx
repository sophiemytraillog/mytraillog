"use client";

import { useState } from "react";

// /admin "Re-run sync" button — restarts the background sync chain for one
// user via /api/admin/continue-sync (which calls /api/internal/continue-sync
// server-side). Returns as soon as the chain has started; refresh the page
// to watch the user's sync status and activity count move.
export default function ResyncButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    try {
      const res = await fetch("/api/admin/continue-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const raw = await res.text();
      let data: { accepted?: boolean; error?: string } = {};
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok || !data.accepted) throw new Error(data.error || `HTTP ${res.status}`);
      setState("done");
      setMessage("Sync started — refresh to check progress");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  }

  if (state === "running") {
    return <span className="text-[#8A7F72] text-xs">Starting sync…</span>;
  }

  if (state === "done" || state === "error") {
    return (
      <span className={`text-xs ${state === "error" ? "text-[#C4652A]" : "text-[#4A7C59]"}`}>
        {message}
        {state === "error" && (
          <button onClick={run} className="ml-1.5 underline underline-offset-2 hover:no-underline">
            Retry
          </button>
        )}
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
