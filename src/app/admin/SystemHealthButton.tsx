"use client";

import { useState } from "react";

interface DiagnosticStep {
  name: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  details: Record<string, unknown>;
  tookMs: number;
}

interface DiagnosticReport {
  healthy: boolean;
  ranAt: string;
  tookMs: number;
  steps: DiagnosticStep[];
}

const STEP_LABELS: Record<string, string> = {
  database: "Database",
  strava_api: "Strava API",
  sync_pipeline: "Sync pipeline",
  matching_pipeline: "Matching pipeline",
  description_pipeline: "Description pipeline",
  drain_status: "Drain status",
  health: "Health",
};

const STATUS_STYLE: Record<DiagnosticStep["status"], string> = {
  pass: "text-[#4A7C59] bg-[#4A7C59]/10",
  warn: "text-[#C4652A] bg-[#C4652A]/10",
  fail: "text-red-700 bg-red-100",
};

export default function SystemHealthButton() {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState("");

  async function run() {
    setState("running");
    setError("");
    try {
      const res = await fetch("/api/admin/test-new-user-flow", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setReport(data);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setState("error");
    }
  }

  return (
    <div>
      <button
        onClick={run}
        disabled={state === "running"}
        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-[#E5DED4] text-[#2C2520] hover:border-[#C4652A]/40 hover:text-[#C4652A] transition-colors disabled:opacity-50"
      >
        {state === "running" ? "Running checks…" : "Run System Health check"}
      </button>

      {error && <p className="text-red-700 text-xs mt-2">{error}</p>}

      {report && (
        <div className="mt-4 bg-white border border-[#E5DED4] rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E5DED4] flex items-center justify-between">
            <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
              System Health — {new Date(report.ranAt).toLocaleString("en-GB")}
            </p>
            <span
              className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                report.healthy ? "text-[#4A7C59] bg-[#4A7C59]/10" : "text-[#C4652A] bg-[#C4652A]/10"
              }`}
            >
              {report.healthy ? "All clear" : "Needs attention"}
            </span>
          </div>
          <div className="divide-y divide-[#E5DED4]">
            {report.steps.map((step) => (
              <details key={step.name} className="px-4 py-3">
                <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                  <span className="text-sm text-[#2C2520] font-medium">
                    {STEP_LABELS[step.name] ?? step.name}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[#8A7F72]/70 text-xs tabular-nums">{step.tookMs}ms</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full uppercase ${STATUS_STYLE[step.status]}`}>
                      {step.status}
                    </span>
                  </span>
                </summary>
                <p className="text-[#8A7F72] text-xs mt-1.5">{step.summary}</p>
                <pre className="text-[#8A7F72]/70 text-[11px] mt-2 bg-[#FAF8F5] rounded-lg p-2 overflow-x-auto">
                  {JSON.stringify(step.details, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
