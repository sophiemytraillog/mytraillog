"use client";

import { useState, useRef } from "react";

type Phase = "idle" | "running" | "done" | "scope_error" | "error";

interface ProgressState {
  current: number;
  total: number;
  updated: number;
  message: string;
}

export default function UpdateDescriptionsButton() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [finalMessage, setFinalMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const esRef = useRef<EventSource | null>(null);

  function start(force = false) {
    if (phase === "running") return;

    setPhase("running");
    setProgress(null);
    setFinalMessage("");
    setErrorMessage("");

    const url = force ? "/api/update-descriptions?force=true" : "/api/update-descriptions";
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("start", (e) => {
      const data = JSON.parse(e.data);
      setProgress({ current: 0, total: data.total, updated: 0, message: data.message });
    });

    es.addEventListener("progress", (e) => {
      const data = JSON.parse(e.data);
      setProgress({
        current: data.current,
        total: data.total,
        updated: data.updated,
        message: data.message,
      });
    });

    es.addEventListener("done", (e) => {
      const data = JSON.parse(e.data);
      setFinalMessage(data.message);
      setPhase("done");
      es.close();
    });

    es.addEventListener("scope_error", (e) => {
      const data = JSON.parse(e.data);
      setErrorMessage(data.message);
      setPhase("scope_error");
      es.close();
    });

    es.addEventListener("error", (e) => {
      const msg = e instanceof MessageEvent
        ? (JSON.parse(e.data)?.message ?? "Unknown error")
        : "Connection error";
      setErrorMessage(msg);
      setPhase("error");
      es.close();
    });
  }

  function cancel() {
    esRef.current?.close();
    esRef.current = null;
    setPhase("idle");
    setProgress(null);
  }

  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="mt-3">
      {phase === "idle" && (
        <button
          onClick={() => start()}
          className="w-full text-xs font-medium text-[#8A7F72] hover:text-[#2C2520] border border-[#E5DED4] rounded-lg px-3 py-2 transition-colors hover:border-[#C4652A]/30 text-left"
        >
          Update historical activity descriptions…
        </button>
      )}

      {phase === "running" && (
        <div className="border border-[#E5DED4] rounded-lg px-3 py-2.5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#2C2520]">
              {progress?.message ?? "Starting…"}
            </span>
            <button
              onClick={cancel}
              className="text-[#8A7F72] hover:text-[#2C2520] text-xs ml-2 shrink-0"
            >
              Cancel
            </button>
          </div>
          <div className="w-full h-1.5 bg-[#EAE4DA] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#4A7C59] rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {progress && (
            <p className="text-[#8A7F72]/70 text-[10px] mt-1.5">
              {progress.current} of {progress.total} checked
              {progress.updated > 0 && ` · ${progress.updated} updated`}
            </p>
          )}
          <p className="text-[#8A7F72]/50 text-[10px] mt-0.5">
            Strava rate limit: 100 requests / 15 min
          </p>
        </div>
      )}

      {phase === "done" && (
        <div className="border border-[#4A7C59]/30 bg-[#4A7C59]/5 rounded-lg px-3 py-2.5 flex items-start gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
            className="w-3.5 h-3.5 text-[#4A7C59] mt-0.5 shrink-0">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
          </svg>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[#4A7C59]">{finalMessage}</p>
            <button
              onClick={() => setPhase("idle")}
              className="text-[#8A7F72] text-[10px] mt-1 hover:text-[#2C2520]"
            >
              Run again
            </button>
          </div>
        </div>
      )}

      {(phase === "scope_error" || phase === "error") && (
        <div className="border border-[#C4652A]/30 bg-[#C4652A]/5 rounded-lg px-3 py-2.5">
          <p className="text-xs text-[#C4652A] font-medium mb-1">
            {phase === "scope_error" ? "Permission needed" : "Error"}
          </p>
          <p className="text-[#8A7F72] text-[10px] leading-relaxed">{errorMessage}</p>
          {phase === "scope_error" && (
            <a
              href="/api/auth/strava"
              className="inline-block mt-2 text-[10px] font-medium text-[#C4652A] hover:underline"
            >
              Reconnect Strava →
            </a>
          )}
          <button
            onClick={() => setPhase("idle")}
            className="block text-[#8A7F72] text-[10px] mt-1 hover:text-[#2C2520]"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
