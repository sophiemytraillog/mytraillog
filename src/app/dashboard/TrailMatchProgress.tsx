"use client";

import { useEffect, useState } from "react";

interface MatchBatchResponse {
  checkedThisBatch: number;
  totalChecked: number;
  totalTrails: number;
  done: boolean;
}

// Client-driven continuation of finishSync's own capped inline matching
// (see sync-engine.ts's MAX_TRAILS_PER_FINISH_SYNC) — a new or actively
// syncing account only gets its first ~40 nearby trails checked inline;
// this component keeps calling /api/sync/match-trails in a loop, right
// here in the dashboard, until every trail's been checked, instead of
// leaving the rest for tomorrow's cron sweep or a human noticing.
//
// Remounted (see DashboardClient's key={lastSyncedAt}) after every sync
// completes, so it always restarts from whatever the server just reported
// rather than a stale in-memory count.
export default function TrailMatchProgress({
  initialChecked,
  initialTotal,
}: {
  initialChecked: number;
  initialTotal: number;
}) {
  const [checked, setChecked] = useState(initialChecked);
  const [total, setTotal] = useState(initialTotal);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialChecked >= initialTotal) return;

    let cancelled = false;

    const run = async () => {
      while (!cancelled) {
        try {
          const res = await fetch("/api/sync/match-trails");
          if (!res.ok) throw new Error(`match-trails ${res.status}`);
          const data: MatchBatchResponse = await res.json();
          if (cancelled) return;

          setChecked(data.totalChecked);
          setTotal(data.totalTrails);
          if (data.done) return;

          // A batch that checked nothing (every trail in it failed all its
          // retries) would otherwise spin the loop as fast as the network
          // allows — pause before the next attempt instead of hammering it.
          if (data.checkedThisBatch === 0) {
            await new Promise((r) => setTimeout(r, 5_000));
          }
        } catch {
          if (!cancelled) setFailed(true);
          return;
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount — a fresh mount (via the key prop in
    // DashboardClient) is how this restarts after a new sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing left to check, or the loop gave up — the daily cron sweep is
  // the fallback either way, no need to keep this visible.
  if (checked >= total || failed || total === 0) return null;

  const pct = Math.min((checked / total) * 100, 100);

  return (
    <div className="mt-3 text-center">
      <p className="text-[#8A7F72] text-xs">
        Matching trails: {checked.toLocaleString()} of {total.toLocaleString()} checked
      </p>
      <div className="h-1 bg-[#EAE4DA] rounded-full overflow-hidden mt-1.5 max-w-[220px] mx-auto">
        <div
          className="h-full bg-[#4A7C59] rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
