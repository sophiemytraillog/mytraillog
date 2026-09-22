"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SyncState = "idle" | "syncing" | "background" | "done" | "error";

interface SyncData {
  fetched: number;
  saved: number;
  message: string;
}

export default function SyncButton({
  autoSync,
  initialActivityCount,
  onSyncComplete,
  hasBasicAccess,
}: {
  autoSync: boolean;
  initialActivityCount: number;
  onSyncComplete?: () => void;
  // 2026-09-30 feature gating: sync stops once a trial lapses into
  // grace_period. The server (runSyncChunk, see sync-engine.ts) is the
  // real enforcement point regardless of this prop; this just keeps the
  // button from ever starting a sync doomed to come back as an error, and
  // shows the locked-state messaging up front instead.
  hasBasicAccess: boolean;
}) {
  const router = useRouter();
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [data, setData] = useState<SyncData>({ fetched: 0, saved: 0, message: "" });
  const [activityCount, setActivityCount] = useState(initialActivityCount);
  const esRef = useRef<EventSource | null>(null);
  const autoFired = useRef(false);
  // Totals from chunks already finished this sync — each SSE connection's
  // fetched/saved counters start back at 0 (see runSyncChunk), so the UI
  // has to add them to what earlier chunks already reported.
  const baseRef = useRef({ fetched: 0, saved: 0 });
  // The "done" event's message (e.g. "Sync complete — 3 activities saved") —
  // held here so it can be restored once "matched" arrives, replacing the
  // interim "Updating trail progress…" text.
  const doneMessageRef = useRef("");

  const runChunk = () => {
    const es = new EventSource("/api/sync/activities");
    esRef.current = es;

    const combined = (d: SyncData): SyncData => ({
      fetched: baseRef.current.fetched + d.fetched,
      saved: baseRef.current.saved + d.saved,
      message: d.message,
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      setData(combined(JSON.parse(e.data)));
    });

    es.addEventListener("partial", (e: MessageEvent) => {
      const d: SyncData = JSON.parse(e.data);
      baseRef.current = { fetched: baseRef.current.fetched + d.fetched, saved: baseRef.current.saved + d.saved };
      es.close();

      // The server takes over from here (see sync/activities/route.ts's
      // "partial" branch — it dispatches sync-chain.ts's background chain
      // right after this event is sent), so the client no longer reopens
      // an EventSource itself for the next chunk. Large histories used to
      // require the tab to stay open and keep reconnecting chunk after
      // chunk; now one click is enough — the rest continues server-side
      // whether or not this page is still open.
      setSyncState("background");
      setData({ ...baseRef.current, message: "Syncing in the background — check back shortly" });
    });

    es.addEventListener("done", (e: MessageEvent) => {
      const d: SyncData = JSON.parse(e.data);
      const final = combined(d);
      baseRef.current = { fetched: final.fetched, saved: final.saved };
      doneMessageRef.current = d.message;
      // d.saved === 0 means the server already skipped matching entirely
      // (nothing new to match) and sends "matched" immediately after this,
      // so d.message ("Sync complete — already up to date") is already the
      // final text — no interim "updating trail progress…" to show.
      const interim = d.saved > 0 ? `${d.message} - updating trail progress…` : d.message;
      setData({ ...final, message: interim });
      // Deliberately NOT closing the EventSource here — matching runs
      // server-side after "done" is sent, and closing now would sever the
      // connection before the "matched" event the server sends afterward
      // ever arrives, leaving the UI stuck on the interim message forever
      // (confirmed: this was the actual cause of syncs appearing to hang
      // on "updating trail progress…", not anything slow server-side — see
      // the comment in sync/activities/route.ts). The "matched" and
      // "error" handlers below close it once there's nothing left to wait for.
    });

    es.addEventListener("matched", () => {
      setData((prev) => ({ ...prev, message: doneMessageRef.current }));
      setSyncState("done");
      setActivityCount(initialActivityCount + baseRef.current.saved);
      es.close();
      onSyncComplete?.();
      router.refresh();
    });

    es.addEventListener("error", (e: MessageEvent) => {
      const msg = e?.data ? JSON.parse(e.data)?.message : "Sync failed";
      setData((prev) => ({ ...prev, message: msg ?? "Sync failed" }));
      setSyncState("error");
      es.close();
    });

    es.onerror = () => {
      setSyncState((prev) => (prev === "done" ? prev : "error"));
      setData((prev) => ({ ...prev, message: "Connection lost - please retry" }));
      es.close();
    };
  };

  const startSync = () => {
    if (syncState === "syncing" || syncState === "background" || !hasBasicAccess) return;
    esRef.current?.close();

    baseRef.current = { fetched: 0, saved: 0 };
    setSyncState("syncing");
    setData({ fetched: 0, saved: 0, message: "Connecting…" });

    router.replace("/dashboard", { scroll: false });

    runChunk();
  };

  useEffect(() => {
    if (autoSync && hasBasicAccess && !autoFired.current) {
      autoFired.current = true;
      startSync();
    }
    return () => {
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, hasBasicAccess]);

  return (
    <div className="mt-6 w-full">
      {/* Activity count */}
      {activityCount > 0 && syncState !== "syncing" && syncState !== "background" && (
        <p className="text-[#8A7F72] text-sm text-center mb-4">
          {activityCount} activit{activityCount === 1 ? "y" : "ies"} synced
        </p>
      )}

      {/* Syncing / matching progress */}
      {syncState === "syncing" && (
        <div className="mb-4">
          <div className="flex items-center justify-center gap-2 text-[#4A7C59] text-sm mb-3">
            <svg
              className="w-4 h-4 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span>{data.message || "Syncing…"}</span>
          </div>

          {/* Indeterminate progress bar */}
          <div className="h-1 bg-[#EAE4DA] rounded-full overflow-hidden">
            <div className="h-full bg-[#4A7C59] rounded-full animate-[progress_1.5s_ease-in-out_infinite]"
              style={{ width: "40%" }} />
          </div>

          {data.fetched > 0 && (
            <p className="text-[#8A7F72] text-xs text-center mt-2">
              {data.fetched} fetched · {data.saved} saved
            </p>
          )}

          <button
            onClick={() => {
              esRef.current?.close();
              setSyncState("idle");
              setData({ fetched: 0, saved: 0, message: "" });
            }}
            className="mt-3 w-full text-xs text-[#8A7F72] hover:text-[#2C2520] underline underline-offset-2 transition-colors"
          >
            Stop
          </button>
        </div>
      )}

      {/* Background sync — the reactive chain (or, failing that, the
          external-scheduler backstop — see sync-chain.ts) continues
          fetching remaining chunks server-side from here. No live
          progress to show since nothing's actively connected anymore;
          "Refresh" just re-renders the dashboard from current DB state,
          it doesn't drive the sync itself. */}
      {syncState === "background" && (
        <div className="mb-4">
          <div className="flex items-center justify-center gap-2 text-[#4A7C59] text-sm mb-3">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M4.755 10.059a7.5 7.5 0 0112.548-3.364l1.903 1.903h-3.183a.75.75 0 100 1.5h4.992a.75.75 0 00.75-.75V4.356a.75.75 0 00-1.5 0v3.18l-1.9-1.9A9 9 0 003.306 9.67a.75.75 0 101.45.388zm15.408 3.352a.75.75 0 00-.919.53 7.5 7.5 0 01-12.548 3.364l-1.902-1.903h3.183a.75.75 0 000-1.5H2.984a.75.75 0 00-.75.75v4.992a.75.75 0 001.5 0v-3.18l1.9 1.9a9 9 0 0015.059-4.035.75.75 0 00-.53-.918z" clipRule="evenodd" />
            </svg>
            <span>{data.message}</span>
          </div>
          {data.saved > 0 && (
            <p className="text-[#8A7F72] text-xs text-center mb-3">
              {data.saved} activit{data.saved === 1 ? "y" : "ies"} saved so far
            </p>
          )}
          <button
            onClick={() => router.refresh()}
            className="w-full text-xs text-[#8A7F72] hover:text-[#2C2520] underline underline-offset-2 transition-colors"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Done message */}
      {syncState === "done" && (
        <div className="flex items-center justify-center gap-1.5 text-[#4A7C59] text-sm mb-4">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
          </svg>
          {data.message}
        </div>
      )}

      {/* Error message */}
      {syncState === "error" && (
        <p className="text-red-500 text-xs text-center mb-4">{data.message}</p>
      )}

      {/* Button */}
      {syncState !== "syncing" && syncState !== "background" && !hasBasicAccess && (
        <button
          disabled
          title="Your trial has ended - subscribe to resume syncing"
          className="w-full flex items-center justify-center gap-2 bg-[#C4652A]/5 border border-[#C4652A]/30 text-[#C4652A] text-sm font-medium py-2.5 px-4 rounded-xl cursor-not-allowed"
        >
          Subscribe to keep tracking
        </button>
      )}
      {syncState !== "syncing" && syncState !== "background" && hasBasicAccess && (
        <button
          onClick={startSync}
          className="w-full flex items-center justify-center gap-2 bg-white hover:bg-[#FAF8F5] border border-[#E5DED4] hover:border-[#C4652A]/40 text-[#2C2520] text-sm font-medium py-2.5 px-4 rounded-xl transition-all duration-150"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" className="w-4 h-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          {syncState === "done"
            ? "Sync Again"
            : syncState === "error"
            ? "Retry Sync"
            : "Sync Activities"}
        </button>
      )}
    </div>
  );
}
