"use client";

import { useEffect, useState } from "react";

interface MatchProgressResponse {
  totalChecked: number;
  totalTrails: number;
  done: boolean;
}

const POLL_INTERVAL_MS = 4_000;

// Purely a display — the actual matching work runs server-side regardless
// of whether this component (or the browser) is even open, via the
// waitUntil()-chained background job triggered from /api/sync/activities
// and dashboard/page.tsx (see match-chain.ts). This just polls the
// read-only /api/sync/match-progress endpoint to show "Matching trails: X
// of Y checked" while that's happening, and stops polling once done.
//
// Remounted (see DashboardClient's key={lastSyncedAt}) after every sync
// completes, so it always starts from whatever the server just reported
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
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch("/api/sync/match-progress");
        if (!res.ok) throw new Error(`match-progress ${res.status}`);
        const data: MatchProgressResponse = await res.json();
        if (cancelled) return;

        setChecked(data.totalChecked);
        setTotal(data.totalTrails);
        if (data.done) return;

        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Intentionally only on mount — a fresh mount (via the key prop in
    // DashboardClient) is how this restarts after a new sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
