"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function GenerateInviteCodeButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function generate() {
    setState("running");
    setMessage("");
    try {
      const res = await fetch("/api/admin/invite-codes", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setState("done");
      setMessage(`New code: ${data.code}`);
      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={generate}
        disabled={state === "running"}
        className="px-3 py-1.5 rounded-lg bg-[#2C2520] text-white text-xs font-medium hover:bg-[#2C2520]/90 transition-colors disabled:opacity-50"
      >
        {state === "running" ? "Generating…" : "Generate new code"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-[#C4652A]" : "text-[#4A7C59]"}`}>{message}</span>
      )}
    </div>
  );
}
