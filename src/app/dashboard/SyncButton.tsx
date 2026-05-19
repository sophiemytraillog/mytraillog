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

  const startSync = () => {
    if (syncState === "syncing") return;
    esRef.current?.close();

    setSyncState("syncing");
    setData({ fetched: 0, saved: 0, message: "Connecting…" });

    router.replace("/dashboard", { scroll: false });

    const es = new EventSource("/api/sync/activities");
    esRef.current = es;

    es.addEventListener("progress", (e: MessageEvent) => {
      const d: SyncData = JSON.parse(e.data);
      setData(d);
    });

    es.addEventListener("done", (e: MessageEvent) => {
      const d: SyncData = JSON.parse(e.data);
      setData(d);
      setActivityCount((prev) => prev + d.saved);
      setSyncState("done");
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
      setSyncState((prev) => {
        if (prev === "done") return prev;
        return "error";
      });
      setData((prev) =>
        prev.message ? prev : { ...prev, message: "Connection lost" }
      );
      es.close();
    };
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
