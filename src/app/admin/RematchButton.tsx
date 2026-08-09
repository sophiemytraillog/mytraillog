"use client";

import { useState } from "react";

export default function RematchButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    let totalMatched = 0;

    try {
      // The server tracks progress via trail_match_checks (see
      // api/admin/rematch), not a client-held offset — so this loop just
      // keeps calling until the server reports done, and correctly resumes
      // from wherever a previous run (even from a different browser
      // session, hours or days ago) left off.
      while (true) {
        const res = await fetch("/api/admin/rematch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");

        totalMatched += data.matchedTrails;
        setMessage(`Checked ${data.totalChecked}/${data.totalTrails} trails…`);

        if (data.done) break;
      }
      setState("done");
      setMessage(`${totalMatched} trail${totalMatched === 1 ? "" : "s"} matched`);
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
      Re-run matching
    </button>
  );
}
