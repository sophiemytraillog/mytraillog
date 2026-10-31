"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface MatchProgressResponse {
  totalChecked: number;
  totalTrails: number;
  done: boolean;
  nationalChecked: number;
  nationalTotal: number;
  finalCheck: boolean;
}

const POLL_INTERVAL_MS = 4_000;
// How long "All trails matched!" shows before the final refresh.
const READY_MESSAGE_MS = 2_500;

// Purely a display — the actual matching work runs server-side regardless
// of whether this component (or the browser) is even open (see
// match-chain.ts). Polls the read-only /api/sync/match-progress endpoint
// and, for a new user (2026-10-31 onboarding fixes):
// - refreshes the page once all National Trails are checked, so the
//   first-sync banner gives way to the dashboard without a manual refresh
//   (only when rendered inside that banner — refreshOnNationalReady)
// - shows "Running final check against your full history" while matching
//   re-runs from scratch after the first sync (checks reset to 0), instead
//   of a counter that looks like it jumped backwards
// - shows "All trails matched!" when matching reaches the full total, then
//   refreshes once more so the stats on screen are final
//
// Remounted (see DashboardClient's key={lastSyncedAt}) after every sync
// completes, so it always starts from whatever the server just reported.
export default function TrailMatchProgress({
  initialChecked,
  initialTotal,
  refreshOnNationalReady = false,
}: {
  initialChecked: number;
  initialTotal: number;
  refreshOnNationalReady?: boolean;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(initialChecked);
  const [total, setTotal] = useState(initialTotal);
  const [failed, setFailed] = useState(false);
  const [finalCheck, setFinalCheck] = useState(false);
  const [allMatched, setAllMatched] = useState(false);
  const maxSeenRef = useRef(initialChecked);
  const nationalRefreshedRef = useRef(false);

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

        // A drop means the first full sync just finished and checks were
        // reset for the from-scratch re-match; the server flag covers the
        // case where the reset happened before this page loaded.
        if (data.finalCheck || data.totalChecked < maxSeenRef.current) setFinalCheck(true);
        maxSeenRef.current = Math.max(maxSeenRef.current, data.totalChecked);

        setChecked(data.totalChecked);
        setTotal(data.totalTrails);

        if (data.done) {
          setFinalCheck(false);
          setAllMatched(true);
          timer = setTimeout(() => {
            if (cancelled) return;
            router.refresh();
            // This component survives the refresh, so clear the message
            // shortly after rather than leaving it up for good.
            timer = setTimeout(() => {
              if (!cancelled) setAllMatched(false);
            }, READY_MESSAGE_MS * 2);
          }, READY_MESSAGE_MS);
          return;
        }

        if (
          refreshOnNationalReady &&
          !nationalRefreshedRef.current &&
          data.nationalTotal > 0 &&
          data.nationalChecked >= data.nationalTotal
        ) {
          // The banner is decided server-side, so a refresh is what swaps
          // it for the dashboard. Polling carries on in case the refreshed
          // page still renders this banner (e.g. mid-sync).
          nationalRefreshedRef.current = true;
          router.refresh();
        }

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

  if (allMatched) {
    return (
      <div className="mt-3 text-center">
        <p className="text-[#4A7C59] text-xs font-medium inline-flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5" aria-hidden="true">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
          </svg>
          All trails matched!
        </p>
      </div>
    );
  }

  if (checked >= total || failed || total === 0) return null;

  const pct = Math.min((checked / total) * 100, 100);

  return (
    <div className="mt-3 text-center">
      {finalCheck ? (
        <p className="text-[#8A7F72] text-xs">Running final check against your full history</p>
      ) : (
        <p
          className="text-[#8A7F72] text-xs"
          title="Includes named sub-sections of longer trails (e.g. individual stages of a multi-part route), which are tracked separately here but shown nested under their parent trail in your list below — so this total is higher than the number of trails you see listed."
        >
          Matching trails: {checked.toLocaleString()} of {total.toLocaleString()} checked
        </p>
      )}
      <div className="h-1 bg-[#EAE4DA] rounded-full overflow-hidden mt-1.5 max-w-[220px] mx-auto">
        <div
          className="h-full bg-[#4A7C59] rounded-full transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
