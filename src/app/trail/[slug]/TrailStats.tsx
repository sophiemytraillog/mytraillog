"use client";

import { useDistanceUnit } from "@/app/DistanceUnitProvider";
import { formatDist, unitLabel } from "@/lib/distance";
import { useTrailSelection } from "./TrailSelectionContext";

interface Activity {
  id: string;
  name: string;
  activity_type: string;
  start_date: Date;
  activity_distance_m: number;
  strava_activity_id: string;
  trail_contribution_m: number;
  activity_trail_geojson: object | null;
}

interface Props {
  completedM: number;
  totalDistM: number;
  activityCount: number;
  pct: number;
  activities: Activity[];
}

const CYCLING_TYPES = new Set(["Ride", "MountainBikeRide", "GravelRide", "EBikeRide"]);

function activityTypeLabel(type: string) {
  const map: Record<string, string> = {
    Run: "Run", TrailRun: "Trail Run", Walk: "Walk", Hike: "Hike",
    Ride: "Ride", MountainBikeRide: "MTB Ride", GravelRide: "Gravel Ride", EBikeRide: "E-Bike Ride",
  };
  return map[type] ?? type;
}

function formatDate(date: Date) {
  return new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function BikeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 inline-block mr-0.5 -mt-0.5 text-[#8A7F72]" aria-hidden="true">
      <path fillRule="evenodd" d="M14.5 3a.75.75 0 01.75.75v.5h.25a.75.75 0 010 1.5h-.25v.013A5.5 5.5 0 1113.5 16h-7a5.5 5.5 0 110-8.987V6.75h-.25a.75.75 0 010-1.5H8a.75.75 0 01.75.75v.965A5.51 5.51 0 016.5 10.5a5.474 5.474 0 01.62 2.27L10 9.31V7.25h-.25a.75.75 0 010-1.5H13.75V4.75a.75.75 0 01.75-.75zm-4 9a.75.75 0 01.65-.743L14.3 10H11.5a.75.75 0 01-.75-.75V7.75h-1v4.5a.75.75 0 01-.75.75H6.5a4 4 0 107.743 1.453L10.5 12z" clipRule="evenodd" />
    </svg>
  );
}

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-white border border-[#E5DED4] rounded-2xl px-4 py-3.5">
      <p className="text-[#8A7F72] text-xs mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${highlight ? "text-[#4A7C59]" : "text-[#2C2520]"}`}>
        {value}
      </p>
    </div>
  );
}

export default function TrailStats({ completedM, totalDistM, activityCount, pct, activities }: Props) {
  const { unit } = useDistanceUnit();
  const ul = unitLabel(unit);
  const { selectedActivityId, selectActivity } = useTrailSelection();

  return (
    <>
      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="Completed" value={`${formatDist(completedM, unit)} ${ul}`} />
        <StatCard label="Total distance" value={`${formatDist(totalDistM, unit)} ${ul}`} />
        <StatCard label="Progress" value={`${pct}%`} highlight={pct > 0} />
        <StatCard label="Activities" value={String(activityCount)} />
      </div>

      {/* Progress bar */}
      {pct > 0 && (
        <div className="mb-8">
          <div className="h-2 bg-[#EAE4DA] rounded-full overflow-hidden">
            <div className="h-full bg-[#4A7C59] rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Contributing activities */}
      {activities.length > 0 && (
        <div>
          <h2 className="text-[#8A7F72] text-xs font-semibold tracking-widest uppercase mb-3">
            Contributing Activities
          </h2>
          <div className="flex flex-col gap-2">
            {activities.map((act) => {
              const isSelected = selectedActivityId === act.id;
              return (
                <div
                  key={act.id}
                  onClick={() =>
                    selectActivity(
                      isSelected ? null : act.id,
                      isSelected ? null : act.activity_trail_geojson
                    )
                  }
                  className={`border rounded-xl px-4 py-3 transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-[#FDF6F2] border-[#C4652A]/50"
                      : "bg-white hover:bg-[#FAF8F5] border-[#E5DED4]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[#2C2520] text-sm font-medium truncate">{act.name}</p>
                      <p className="text-[#8A7F72] text-xs mt-0.5">
                        {CYCLING_TYPES.has(act.activity_type) && <BikeIcon />}
                        {activityTypeLabel(act.activity_type)} · {formatDate(act.start_date)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-semibold tabular-nums ${isSelected ? "text-[#C4652A]" : "text-[#4A7C59]"}`}>
                        +{formatDist(act.trail_contribution_m, unit)} {ul}
                      </p>
                      <p className="text-[#8A7F72] text-xs">of trail</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-[#8A7F72]/70 text-xs">
                      Activity total: {formatDist(act.activity_distance_m, unit)} {ul}
                    </p>
                    <a
                      href={`https://www.strava.com/activities/${act.strava_activity_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[#8A7F72]/40 hover:text-[#C4652A]/60 transition-colors"
                      title="Open on Strava"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                        <path fillRule="evenodd" d="M4.22 11.78a.75.75 0 010-1.06L9.44 5.5H5.75a.75.75 0 010-1.5h5.5a.75.75 0 01.75.75v5.5a.75.75 0 01-1.5 0V6.56l-5.22 5.22a.75.75 0 01-1.06 0z" clipRule="evenodd" />
                      </svg>
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activities.length === 0 && (
        <div className="text-center py-12">
          <p className="text-[#8A7F72] text-sm">No activities match this trail yet.</p>
          <p className="text-[#8A7F72]/60 text-xs mt-1">Sync your activities from the dashboard to see your progress.</p>
        </div>
      )}
    </>
  );
}
