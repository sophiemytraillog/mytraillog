"use client";

import { useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { TrailSelectionContext } from "./TrailSelectionContext";

const TrailMap = dynamic(() => import("./TrailMap"), {
  ssr: false,
  loading: () => (
    <div
      className="w-full rounded-2xl bg-[#EAE4DA] animate-pulse"
      style={{ height: "500px" }}
    />
  ),
});

export interface ManualSegment {
  id: string;
  segment_type: "auto_gap_fill" | "manual";
  length_m: number;
  created_at: string;
}

interface ApiResponse {
  manualSegmentsGeoJson: object | null;
  manualSegments: ManualSegment[];
  filledCount?: number;
  error?: string;
}

interface ActivityWithGeo {
  id: string;
  activity_trail_geojson: object | null;
}

interface TrailActionsProps {
  trailSlug: string;
  trailGeoJson: object;
  completedGeoJson: object | null;
  initialManualGeoJson: object | null;
  initialManualSegments: ManualSegment[];
  hasProgress: boolean;
  activities: ActivityWithGeo[];
  children?: React.ReactNode;
}

export default function TrailActions({
  trailSlug,
  trailGeoJson,
  completedGeoJson,
  initialManualGeoJson,
  initialManualSegments,
  hasProgress,
  activities,
  children,
}: TrailActionsProps) {
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [selectedActivityGeoJson, setSelectedActivityGeoJson] = useState<object | null>(null);

  const selectActivity = useCallback((id: string | null, geojson: object | null) => {
    setSelectedActivityId(id);
    setSelectedActivityGeoJson(geojson);
  }, []);

  const selectionContext = useMemo(
    () => ({ selectedActivityId, selectActivity }),
    [selectedActivityId, selectActivity]
  );

  const [showRemaining, setShowRemaining] = useState(false);
  const [isMarkingMode, setIsMarkingMode] = useState(false);
  const [markingPoints, setMarkingPoints] = useState<Array<[number, number]>>([]);
  const [manualGeoJson, setManualGeoJson] = useState<object | null>(initialManualGeoJson);
  const [manualSegments, setManualSegments] = useState<ManualSegment[]>(initialManualSegments);
  const [isFilling, setIsFilling] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [pendingAction, setPendingAction] = useState<"fill-all" | "mark-complete" | null>(null);
  const [isActioning, setIsActioning] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "info" | "error" } | null>(null);

  const handleMapClick = useCallback((latlng: [number, number]) => {
    setMarkingPoints((prev) => (prev.length < 2 ? [...prev, latlng] : prev));
  }, []);

  const applyResponse = (data: ApiResponse) => {
    setManualGeoJson(data.manualSegmentsGeoJson);
    setManualSegments(data.manualSegments);
  };

  const handleFillGaps = async () => {
    setIsFilling(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/trails/${trailSlug}/fill-gaps`, { method: "POST" });
      const data: ApiResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      applyResponse(data);
      setMessage({
        text:
          (data.filledCount ?? 0) === 0
            ? "No gaps under 500 m found."
            : `Filled ${data.filledCount} gap${(data.filledCount ?? 0) > 1 ? "s" : ""}.`,
        kind: "info",
      });
    } catch (err) {
      setMessage({ text: (err as Error).message, kind: "error" });
    } finally {
      setIsFilling(false);
    }
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    setIsActioning(true);
    setMessage(null);
    try {
      if (pendingAction === "fill-all") {
        const res = await fetch(`/api/trails/${trailSlug}/fill-gaps?all=true`, { method: "POST" });
        const data: ApiResponse = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");
        applyResponse(data);
        setMessage({
          text:
            (data.filledCount ?? 0) === 0
              ? "No gaps found."
              : `Filled ${data.filledCount} gap${(data.filledCount ?? 0) > 1 ? "s" : ""}.`,
          kind: "info",
        });
      } else {
        const res = await fetch(`/api/trails/${trailSlug}/mark-complete`, { method: "POST" });
        const data: ApiResponse = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");
        applyResponse(data);
        setMessage({ text: "Whole trail marked as complete.", kind: "info" });
      }
    } catch (err) {
      setMessage({ text: (err as Error).message, kind: "error" });
    } finally {
      setIsActioning(false);
      setPendingAction(null);
    }
  };

  const handleConfirmManual = async () => {
    if (markingPoints.length !== 2) return;
    setIsConfirming(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/trails/${trailSlug}/manual-segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pointA: markingPoints[0], pointB: markingPoints[1] }),
      });
      const data: ApiResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      applyResponse(data);
      setMarkingPoints([]);
      setIsMarkingMode(false);
      setMessage({ text: "Section marked as walked.", kind: "info" });
    } catch (err) {
      setMessage({ text: (err as Error).message, kind: "error" });
    } finally {
      setIsConfirming(false);
    }
  };

  const handleRemove = async (segmentId: string) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/trails/${trailSlug}/manual-segment/${segmentId}`, {
        method: "DELETE",
      });
      const data: ApiResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      applyResponse(data);
      setMessage({ text: "Section removed.", kind: "info" });
    } catch (err) {
      setMessage({ text: (err as Error).message, kind: "error" });
    }
  };

  const cancelMarking = () => {
    setIsMarkingMode(false);
    setMarkingPoints([]);
    setMessage(null);
  };

  return (
    <TrailSelectionContext.Provider value={selectionContext}>
      {/* Map */}
      <div className="mb-3">
        <TrailMap
          trailGeoJson={trailGeoJson}
          completedGeoJson={completedGeoJson}
          manualGeoJson={manualGeoJson}
          showRemaining={showRemaining}
          isMarkingMode={isMarkingMode}
          markingPoints={markingPoints}
          onMapClick={handleMapClick}
          selectedActivityGeoJson={selectedActivityGeoJson}
        />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-4 px-1">
        {completedGeoJson && (
          <span className="flex items-center gap-1.5 text-xs text-[#8A7F72]">
            <span className="inline-block w-5 h-1 rounded-full bg-[#4A7C59]" />
            GPS verified
          </span>
        )}
        {manualSegments.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-[#8A7F72]">
            <span
              className="inline-block w-5 h-0"
              style={{
                borderTop: "3px dashed #4A7C59",
                borderRadius: 0,
              }}
            />
            Manually added
          </span>
        )}
        {showRemaining && (
          <span className="flex items-center gap-1.5 text-xs text-[#8A7F72]">
            <span className="inline-block w-5 h-1 rounded-full bg-[#C4652A]" />
            Remaining
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap mb-4">
        {/* Show/hide remaining toggle */}
        <button
          onClick={() => setShowRemaining((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
            showRemaining
              ? "bg-[#C4652A] border-[#C4652A] text-white"
              : "bg-white border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] hover:border-[#C4652A]/40"
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="w-3.5 h-3.5"
          >
            <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
            <path
              fillRule="evenodd"
              d="M1.38 8a6.585 6.585 0 0 1 1.007-1.96C3.608 4.367 5.6 3 8 3s4.392 1.367 5.613 3.04A6.585 6.585 0 0 1 14.62 8a6.585 6.585 0 0 1-1.007 1.96C12.392 11.633 10.4 13 8 13s-4.392-1.367-5.613-3.04A6.585 6.585 0 0 1 1.38 8Z"
              clipRule="evenodd"
            />
          </svg>
          {showRemaining ? "Hide remaining" : "Show remaining sections"}
        </button>

        {/* Fill small gaps */}
        {hasProgress && (
          <button
            onClick={handleFillGaps}
            disabled={isFilling || !!pendingAction}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] hover:border-[#C4652A]/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path
                fillRule="evenodd"
                d="M8 1a.75.75 0 0 1 .75.75V6h4.25a.75.75 0 0 1 0 1.5H8.75v4.25a.75.75 0 0 1-1.5 0V7.5H3a.75.75 0 0 1 0-1.5h4.25V1.75A.75.75 0 0 1 8 1Z"
                clipRule="evenodd"
              />
            </svg>
            {isFilling ? "Filling…" : "Fill small gaps"}
          </button>
        )}

        {/* Fill all gaps */}
        {hasProgress && (
          <button
            onClick={() => { setPendingAction("fill-all"); setMessage(null); }}
            disabled={isFilling || !!pendingAction}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] hover:border-[#C4652A]/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M8 1a.75.75 0 0 1 .75.75V6h4.25a.75.75 0 0 1 0 1.5H8.75v4.25a.75.75 0 0 1-1.5 0V7.5H3a.75.75 0 0 1 0-1.5h4.25V1.75A.75.75 0 0 1 8 1Z" clipRule="evenodd" />
            </svg>
            Fill all gaps
          </button>
        )}

        {/* Mark whole trail complete */}
        <button
          onClick={() => { setPendingAction("mark-complete"); setMessage(null); }}
          disabled={isFilling || !!pendingAction}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] hover:border-[#C4652A]/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
          </svg>
          Mark whole trail complete
        </button>

        {/* Mark walked section */}
        {!isMarkingMode ? (
          <button
            onClick={() => {
              setIsMarkingMode(true);
              setMessage(null);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] hover:border-[#C4652A]/40 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-3.5 h-3.5"
            >
              <path
                fillRule="evenodd"
                d="M11.013 2.513a1.75 1.75 0 0 1 2.475 2.474L6.226 12.25a2.751 2.751 0 0 1-.892.596l-2.047.848a.75.75 0 0 1-.98-.98l.848-2.047a2.75 2.75 0 0 1 .596-.892l7.262-7.262Z"
                clipRule="evenodd"
              />
            </svg>
            Mark walked section
          </button>
        ) : (
          <button
            onClick={cancelMarking}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-white border border-[#E5DED4] text-[#8A7F72] hover:text-[#2C2520] transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Confirm fill-all / mark-complete */}
      {pendingAction && (
        <div className="bg-[#C4652A]/8 border border-[#C4652A]/20 rounded-xl px-4 py-3 mb-4">
          <p className="text-[#C4652A] text-sm">
            {pendingAction === "fill-all"
              ? "This will fill all gaps between completed sections, including those over 500 m. Continue?"
              : "This will mark the entire trail as manually walked. Continue?"}
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={handleConfirmAction}
              disabled={isActioning}
              className="px-4 py-1.5 bg-[#C4652A] hover:bg-[#b35a25] border border-[#C4652A] rounded-lg text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isActioning ? "Applying…" : "Confirm"}
            </button>
            <button
              onClick={() => setPendingAction(null)}
              disabled={isActioning}
              className="px-3 py-1.5 text-[#8A7F72] hover:text-[#2C2520] text-sm transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Marking mode instructions */}
      {isMarkingMode && (
        <div className="bg-[#C4652A]/8 border border-[#C4652A]/20 rounded-xl px-4 py-3 mb-4">
          <p className="text-[#C4652A] text-sm">
            {markingPoints.length === 0 && "Click a start point on the trail map"}
            {markingPoints.length === 1 && "Now click an end point on the trail map"}
            {markingPoints.length === 2 && "Confirm to mark this section as walked"}
          </p>
          {markingPoints.length === 2 && (
            <button
              onClick={handleConfirmManual}
              disabled={isConfirming}
              className="mt-2.5 px-4 py-1.5 bg-[#C4652A] hover:bg-[#b35a25] border border-[#C4652A] rounded-lg text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isConfirming ? "Saving…" : "Confirm section"}
            </button>
          )}
        </div>
      )}

      {/* Status / error message */}
      {message && (
        <p
          className={`text-xs mb-4 ${message.kind === "error" ? "text-red-500" : "text-[#8A7F72]"}`}
        >
          {message.text}
        </p>
      )}

      {/* Server-rendered content (trail header, stats, activity list) */}
      {children}

      {/* Manually added sections list */}
      {manualSegments.length > 0 && (
        <div className="mb-6">
          <h3 className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase mb-2">
            Manually Added Sections
          </h3>
          <div className="flex flex-col gap-1.5">
            {manualSegments.map((seg) => (
              <div
                key={seg.id}
                className="bg-white border border-[#E5DED4] rounded-xl px-3 py-2.5 flex items-center justify-between gap-3"
              >
                <div>
                  <p className="text-[#2C2520] text-sm">
                    {seg.segment_type === "auto_gap_fill"
                      ? "Auto-filled gap"
                      : "Manually marked section"}
                  </p>
                  <p className="text-[#8A7F72] text-xs">
                    {(seg.length_m / 1000).toFixed(2)} km
                  </p>
                </div>
                <button
                  onClick={() => handleRemove(seg.id)}
                  className="text-[#8A7F72]/60 hover:text-red-500 text-xs transition-colors shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </TrailSelectionContext.Provider>
  );
}
