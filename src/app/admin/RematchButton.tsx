"use client";

import { useState } from "react";

export default function RematchButton({ userId }: { userId: string }) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    setMessage("");
    let offset = 0;
    let totalMatched = 0;

    try {
      // Mirrors sync's own partial/continue chunking — a large account's
      // trail table walk can't finish in one request, so the client keeps
      // calling with the next offset until the server reports done.
      while (true) {
        const res = await fetch("/api/admin/rematch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, offset }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");

        totalMatched += data.matchedTrails;
        setMessage(`Checked ${data.nextOffset}/${data.totalTrails} trails…`);

        if (data.done) break;
        offset = data.nextOffset;
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
