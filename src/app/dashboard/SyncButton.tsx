"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SyncState = "idle" | "syncing" | "done" | "error";

interface SyncData {
  fetched: number;
  saved: number;
  message: string;
}

export default function SyncButton({
  autoSync,
  initialActivityCount,
  onSyncComplete,
}: {
  autoSync: boolean;
  initialActivityCount: number;
  onSyncComplete?: () => void;
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
  // Large histories take many 45s chunks to sync. Cap the auto-continue loop
  // so a pathological case (e.g. every chunk instantly reporting "partial")
  // can't spin forever — a real sync needs nowhere near this many chunks.
  const chunkCountRef = useRef(0);
  const MAX_CHUNKS = 200;

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
      setData({ ...baseRef.current, message: d.message });
      es.close();

      chunkCountRef.current += 1;
      if (chunkCountRef.current >= MAX_CHUNKS) {
        setSyncState("error");
        setData((prev) => ({ ...prev, message: "Sync is taking longer than expected - please retry." }));
        return;
      }
      runChunk();
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
    if (syncState === "syncing") return;
    esRef.current?.close();

    baseRef.current = { fetched: 0, saved: 0 };
    chunkCountRef.current = 0;
    setSyncState("syncing");
    setData({ fetched: 0, saved: 0, message: "Connecting…" });

    router.replace("/dashboard", { scroll: false });

    runChunk();
  };

  useEffect(() => {
    if (autoSync && !autoFired.current) {
      autoFired.current = true;
      startSync();
    }
    return () => {
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync]);

  return (
    <div className="mt-6 w-full">
      {/* Activity count */}
      {activityCount > 0 && syncState !== "syncing" && (
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
      {syncState !== "syncing" && (
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
