"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SyncButton from "./SyncButton";
import TrailProgressList from "./TrailProgressList";
import NationalTrailsList from "./NationalTrailsList";
import UpdateDescriptionsButton from "./UpdateDescriptionsButton";
import RequestTrailModal from "./RequestTrailModal";
import DeleteAccountModal from "./DeleteAccountModal";
import { useDistanceUnit } from "@/app/DistanceUnitProvider";
import { formatDist, unitLabel } from "@/lib/distance";

const DashboardMap = dynamic(() => import("./DashboardMap"), {
  ssr: false,
  loading: () => (
    <div
      className="w-full rounded-2xl bg-[#EAE4DA] animate-pulse border border-[#E5DED4] h-[380px] lg:h-[750px]"
    />
  ),
});

export interface TrailRow {
  id: string;
  slug: string;
  name: string;
  region: string;
  total_distance: number;
  parent_trail_id: string | null;
  completion_percentage: number | null;
  completed_distance: number | null;
  activity_count: number | null;
  trail_geojson: object;
  completed_geojson: object | null;
  category: string;
}

interface Athlete {
  id: number;
  firstname: string;
  lastname: string;
  username: string;
  profile: string;
}

interface UserStats {
  last_synced_at: Date | null;
  sync_status: string;
  activity_count: string;
}

interface Props {
  athlete: Athlete;
  stats: UserStats | null;
  trails: TrailRow[];
  activityCount: number;
  autoSync: boolean;
  stravaDescriptionUpdates: boolean;
  hasWriteScope: boolean;
  includeCycling: boolean;
}

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.47 3.841a.75.75 0 011.06 0l8.69 8.69a.75.75 0 101.06-1.061l-8.689-8.69a2.25 2.25 0 00-3.182 0l-8.69 8.69a.75.75 0 101.061 1.06l8.69-8.689z" />
      <path d="M12 5.432l8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 01-.75-.75v-4.5a.75.75 0 00-.75-.75h-3a.75.75 0 00-.75.75V21a.75.75 0 01-.75.75H5.625a1.875 1.875 0 01-1.875-1.875v-6.198c.03-.028.061-.056.091-.086L12 5.432z" />
    </svg>
  );
}

function formatLastSynced(date: Date | null): string {
  if (!date) return "Never synced";
  const d = new Date(date);
  return `Last synced ${d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#E5DED4] rounded-2xl px-2 py-2.5 sm:px-3 sm:py-3">
      <p className="text-[#8A7F72] text-[10px] sm:text-xs mb-1 sm:mb-1.5 leading-tight">{label}</p>
      <p className="text-base sm:text-xl font-bold text-[#2C2520] tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[#8A7F72]/70 text-[10px] sm:text-xs mt-1 sm:mt-1.5">{sub}</p>}
    </div>
  );
}

export default function DashboardClient({
  athlete, stats, trails, activityCount, autoSync, stravaDescriptionUpdates, hasWriteScope, includeCycling,
}: Props) {
  const { unit, setUnit } = useDistanceUnit();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "started">("all");
  const [search, setSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("all");
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(stats?.last_synced_at ?? null);
  const [descUpdates, setDescUpdates] = useState(stravaDescriptionUpdates);
  const [savingPref, setSavingPref] = useState(false);
  const [cyclingEnabled, setCyclingEnabled] = useState(includeCycling);
  const [savingCycling, setSavingCycling] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const [requestModalName, setRequestModalName] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  async function toggleDescriptionUpdates(enabled: boolean) {
    setSavingPref(true);
    setDescUpdates(enabled);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strava_description_updates: enabled }),
      });
    } finally {
      setSavingPref(false);
    }
  }

  async function toggleCyclingActivities(enabled: boolean) {
    setSavingCycling(true);
    setCyclingEnabled(enabled);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_cycling: enabled }),
      });
      if (enabled) {
        setBackfillStatus("Scanning for cycling activities…");
        const res = await fetch("/api/settings/backfill-cycling");
        if (!res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find(l => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(5));
              if (payload.message) setBackfillStatus(payload.message);
            } catch { /* ignore */ }
          }
        }
        setTimeout(() => setBackfillStatus(null), 4000);
      }
    } finally {
      setSavingCycling(false);
    }
  }

  // Scroll the list to the selected trail when clicked on the map
  useEffect(() => {
    if (!selectedSlug) return;
    const el = document.getElementById(`trail-${selectedSlug}`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedSlug]);

  // Build children map (keyed by parent trail id)
  const childrenByParentId: Record<string, TrailRow[]> = {};
  for (const t of trails) {
    if (t.parent_trail_id) {
      (childrenByParentId[t.parent_trail_id] ??= []).push(t);
    }
  }

  // Summary stats — always use unfiltered trails; exclude child sections from "Other"
  const allNational = trails.filter(t => t.category === "national_trail");
  const allOther    = trails.filter(t => t.category !== "national_trail" && !t.parent_trail_id);

  const natStarted   = allNational.filter(t => (t.completion_percentage ?? 0) > 0).length;
  const natCompleted = allNational.filter(t => Math.round(t.completion_percentage ?? 0) >= 100).length;
  const natDistM     = allNational.reduce((s, t) => s + (t.completed_distance ?? 0), 0);

  const otherStarted   = allOther.filter(t => (t.completion_percentage ?? 0) > 0).length;
  const otherCompleted = allOther.filter(t => Math.round(t.completion_percentage ?? 0) >= 100).length;
  const otherDistM     = allOther.reduce((s, t) => s + (t.completed_distance ?? 0), 0);

  const searchActive = search.trim().length > 0 || regionFilter !== "all";

  function matchesFilters(t: TrailRow) {
    if (regionFilter !== "all" && t.region !== regionFilter) return false;
    if (search.trim() && !t.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  }

  // Filtered trail lists
  const nationalTrails = trails
    .filter(t => t.category === "national_trail")
    .filter(t => filter === "all" || (t.completion_percentage ?? 0) > 0)
    .filter(matchesFilters);
  // Other trails: exclude child sections; show started only by default
  const otherTrails = trails
    .filter(t => t.category !== "national_trail" && !t.parent_trail_id)
    .filter(t => searchActive || (t.completion_percentage ?? 0) > 0)
    .filter(matchesFilters);

  // Map only shows non-child trails (parent trails + standalone others)
  const mapTrails = trails.filter(t => !t.parent_trail_id);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="px-6 py-4 flex items-center gap-2 border-b border-[#E5DED4]">
        <div className="flex items-center gap-2">
          <LogoIcon className="w-5 h-5 text-[#C4652A] block" />
          <span className="font-semibold text-base tracking-tight text-[#2C2520] leading-none">My Trail Log</span>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/strava/api_logo_pwrdBy_strava_horiz_orange.svg"
          alt="Powered by Strava"
          className="ml-auto"
          style={{ height: "20px", width: "auto" }}
        />
      </nav>

      <div className="flex-1 px-4 py-4 sm:px-6 sm:py-6 max-w-7xl mx-auto w-full">

        {/* Stat row — National Trails + Other Trails */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase mb-2 px-0.5">
              National Trails
            </p>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <StatCard label="Trails started"   value={String(natStarted)}   sub={`of ${allNational.length} tracked`} />
              <StatCard label="Trails completed" value={String(natCompleted)} />
              <StatCard label="Distance covered" value={`${formatDist(natDistM, unit)} ${unitLabel(unit)}`} />
            </div>
          </div>
          <div className="hidden sm:block w-px bg-[#E5DED4] self-stretch mt-6" />
          <div className="sm:hidden h-px bg-[#E5DED4]" />
          <div className="flex-1 min-w-0">
            <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase mb-2 px-0.5">
              Other Trails
            </p>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <StatCard label="Trails started"   value={String(otherStarted)}   sub={`of ${allOther.length} tracked`} />
              <StatCard label="Trails completed" value={String(otherCompleted)} />
              <StatCard label="Distance covered" value={`${formatDist(otherDistM, unit)} ${unitLabel(unit)}`} />
            </div>
          </div>
        </div>

        {/* Two-column layout — stacks on mobile */}
        <div className="flex flex-col gap-4 lg:flex-row lg:gap-5">

          {/* LEFT column (45%): welcome box + map stacked */}
          <div className="min-w-0 flex flex-col gap-4 lg:flex-[9]">

            {/* Welcome box */}
            <div className="bg-white border border-[#E5DED4] rounded-2xl px-5 py-4">
              <div className="flex items-center gap-3 mb-3">
                {athlete.profile && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={athlete.profile}
                    alt={`${athlete.firstname}'s avatar`}
                    className="w-10 h-10 rounded-full ring-2 ring-[#C4652A]/20 shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h1 className="text-sm font-bold text-[#2C2520]">
                      Welcome, {athlete.firstname}!
                    </h1>
                    <span className="inline-flex items-center gap-1 bg-[#4A7C59]/10 text-[#4A7C59] text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded-full">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5">
                        <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                      </svg>
                      Connected
                    </span>
                  </div>
                  <p className="text-[#8A7F72] text-xs mt-0.5">{formatLastSynced(lastSyncedAt)}</p>
                </div>
              </div>
              <SyncButton
                autoSync={autoSync}
                initialActivityCount={activityCount}
                onSyncComplete={() => setLastSyncedAt(new Date())}
              />

              {/* Description updates setting */}
              <div className="mt-3 pt-3 border-t border-[#E5DED4]">
                <label className="flex items-start gap-2.5 cursor-pointer group">
                  <div className="relative mt-0.5 shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={descUpdates}
                      disabled={savingPref}
                      onChange={(e) => toggleDescriptionUpdates(e.target.checked)}
                    />
                    <div className={`w-8 h-4.5 rounded-full transition-colors ${
                      descUpdates ? "bg-[#4A7C59]" : "bg-[#E5DED4]"
                    } ${savingPref ? "opacity-50" : ""}`}
                      style={{ height: "18px" }}
                    >
                      <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                        descUpdates ? "translate-x-4" : "translate-x-0.5"
                      }`} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#2C2520] leading-tight">
                      Add trail info to Strava descriptions
                    </p>
                    <p className="text-[#8A7F72]/70 text-[10px] mt-0.5 leading-relaxed">
                      Appends matched trail progress to new activity descriptions.
                    </p>
                    {descUpdates && !hasWriteScope && (
                      <p className="text-[#C4652A] text-[10px] mt-1">
                        Requires activity:write —{" "}
                        <a href="/api/auth/strava" className="underline hover:no-underline">
                          reconnect Strava
                        </a>
                      </p>
                    )}
                  </div>
                </label>

                <UpdateDescriptionsButton />
              </div>

              {/* Cycling activities setting */}
              <div className="mt-3 pt-3 border-t border-[#E5DED4]">
                <label className="flex items-start gap-2.5 cursor-pointer group">
                  <div className="relative mt-0.5 shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={cyclingEnabled}
                      disabled={savingCycling}
                      onChange={(e) => toggleCyclingActivities(e.target.checked)}
                    />
                    <div className={`w-8 rounded-full transition-colors ${
                      cyclingEnabled ? "bg-[#4A7C59]" : "bg-[#E5DED4]"
                    } ${savingCycling ? "opacity-50" : ""}`}
                      style={{ height: "18px" }}
                    >
                      <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                        cyclingEnabled ? "translate-x-4" : "translate-x-0.5"
                      }`} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#2C2520] leading-tight">
                      Include cycle rides
                    </p>
                    <p className="text-[#8A7F72]/70 text-[10px] mt-0.5 leading-relaxed">
                      Match Ride, Gravel Ride, and Mountain Bike activities against trails.
                    </p>
                  </div>
                </label>
                {backfillStatus && (
                  <p className="text-[#8A7F72] text-[10px] mt-2 pl-[calc(2rem+0.625rem)]">
                    {backfillStatus}
                  </p>
                )}
              </div>

              {/* Distance unit setting */}
              <div className="mt-3 pt-3 border-t border-[#E5DED4] flex items-center justify-between">
                <p className="text-xs font-medium text-[#2C2520]">Distance units</p>
                <div className="flex gap-1 bg-[#EAE4DA] rounded-lg p-0.5">
                  {(["km", "mi"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setUnit(u)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        unit === u
                          ? "bg-white text-[#2C2520] shadow-sm"
                          : "text-[#8A7F72] hover:text-[#2C2520]"
                      }`}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>

              {/* Account deletion — deliberately understated: red text only,
                  no button chrome, tucked below everything else so it isn't
                  the visual focus of the settings card. */}
              <div className="mt-3 pt-3 border-t border-[#E5DED4]">
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="text-[#C4652A]/70 hover:text-[#C4652A] text-[10px] transition-colors"
                >
                  Disconnect &amp; Delete My Data
                </button>
              </div>
            </div>

            {/* Map */}
            <DashboardMap
              trails={mapTrails}
              selectedSlug={selectedSlug}
              onTrailClick={setSelectedSlug}
            />
          </div>

          {/* RIGHT column (55%): trail lists */}
          <div className="min-w-0 flex flex-col lg:flex-[11]">
            <div className="bg-white border border-[#E5DED4] rounded-2xl flex flex-col overflow-hidden lg:flex-1">

              {/* Search + region filter */}
              <div className="px-4 pt-3.5 pb-3 border-b border-[#E5DED4] shrink-0 flex gap-2">
                <div className="relative flex-1">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className="w-3.5 h-3.5 text-[#8A7F72] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                    <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search trails…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full pl-7 pr-3 py-1.5 text-xs rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] placeholder-[#8A7F72]/60 focus:outline-none focus:border-[#C4652A]/40"
                  />
                </div>
                <select
                  value={regionFilter}
                  onChange={e => setRegionFilter(e.target.value)}
                  className="text-xs rounded-lg border border-[#E5DED4] bg-white text-[#2C2520] px-2 py-1.5 focus:outline-none focus:border-[#C4652A]/40"
                >
                  <option value="all">All regions</option>
                  <option value="England">England</option>
                  <option value="Scotland">Scotland</option>
                  <option value="Wales">Wales</option>
                  <option value="Northern Ireland">Northern Ireland</option>
                </select>
              </div>

              {/* Filter toggle */}
              <div className="px-4 pt-3 pb-3 border-b border-[#E5DED4] shrink-0">
                <div className="flex gap-1 bg-[#EAE4DA] rounded-lg p-1 w-fit">
                  <button
                    onClick={() => setFilter("all")}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      filter === "all"
                        ? "bg-white text-[#2C2520] shadow-sm"
                        : "text-[#8A7F72] hover:text-[#2C2520]"
                    }`}
                  >
                    All trails
                  </button>
                  <button
                    onClick={() => setFilter("started")}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                      filter === "started"
                        ? "bg-white text-[#2C2520] shadow-sm"
                        : "text-[#8A7F72] hover:text-[#2C2520]"
                    }`}
                  >
                    Started only
                  </button>
                </div>
              </div>

              {/* Two sub-columns — stacked on mobile, side-by-side on desktop */}
              <div className="flex flex-col lg:flex-row lg:flex-1 lg:min-h-0">

                {/* National Trails */}
                <div className="flex flex-col min-w-0 border-b border-[#E5DED4] lg:border-b-0 lg:border-r lg:flex-1">
                  <div className="px-4 py-2.5 border-b border-[#E5DED4] shrink-0">
                    <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                      National Trails
                    </p>
                  </div>
                  <div className="overflow-y-auto px-3 py-3 max-h-[320px] lg:max-h-none lg:flex-1">
                    {nationalTrails.length > 0 ? (
                      <NationalTrailsList
                        trails={nationalTrails}
                        childrenByParentId={childrenByParentId}
                        selectedSlug={selectedSlug}
                        onTrailSelect={setSelectedSlug}
                      />
                    ) : (
                      <p className="text-[#8A7F72] text-xs text-center pt-8">
                        No started trails yet.
                      </p>
                    )}
                  </div>
                </div>

                {/* Other trails */}
                <div className="flex flex-col min-w-0 lg:flex-1">
                  <div className="px-4 py-2.5 border-b border-[#E5DED4] shrink-0 flex items-center justify-between">
                    <p className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase">
                      Other trails
                    </p>
                    <button
                      onClick={() => setRequestModalName(search.trim() || "")}
                      className="text-[#C4652A]/70 hover:text-[#C4652A] text-[10px] font-medium transition-colors flex items-center gap-0.5"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path d="M8.75 3.75a.75.75 0 00-1.5 0v3.5h-3.5a.75.75 0 000 1.5h3.5v3.5a.75.75 0 001.5 0v-3.5h3.5a.75.75 0 000-1.5h-3.5v-3.5z" />
                      </svg>
                      Can&apos;t find your trail?
                    </button>
                  </div>
                  <div className="overflow-y-auto px-3 py-3 max-h-[320px] lg:max-h-none lg:flex-1">
                    {otherTrails.length > 0 ? (
                      <TrailProgressList
                        trails={otherTrails}
                        selectedSlug={selectedSlug}
                        onTrailSelect={setSelectedSlug}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                        {searchActive ? (
                          <>
                            <p className="text-[#8A7F72] text-xs">No trails match your search.</p>
                            <button
                              onClick={() => setRequestModalName(search.trim())}
                              className="mt-2 text-[#C4652A] text-xs hover:underline transition-colors"
                            >
                              Request this trail →
                            </button>
                          </>
                        ) : (
                          <>
                            <p className="text-[#8A7F72] text-sm font-medium mb-1">No started trails yet</p>
                            <p className="text-[#8A7F72]/60 text-xs leading-relaxed">
                              Search above to browse all 633 long-distance routes.
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>
          </div>

        </div>
      </div>

      {requestModalName !== null && (
        <RequestTrailModal
          initialName={requestModalName}
          onClose={() => setRequestModalName(null)}
        />
      )}

      {showDeleteModal && (
        <DeleteAccountModal onClose={() => setShowDeleteModal(false)} />
      )}

      {/* Footer */}
      <footer className="border-t border-[#E5DED4] py-4 px-6 mt-2">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[#8A7F72]">
            <LogoIcon className="w-4 h-4 text-[#C4652A]" />
            <span className="text-sm font-medium">My Trail Log</span>
          </div>
          <div className="flex items-center gap-4 text-[#8A7F72]/60 text-xs">
            <a href="/privacy" className="hover:text-[#8A7F72] transition-colors">Privacy</a>
            <a href="/terms" className="hover:text-[#8A7F72] transition-colors">Terms</a>
            <a href="/support" className="hover:text-[#8A7F72] transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
