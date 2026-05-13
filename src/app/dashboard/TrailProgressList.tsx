"use client";

import Link from "next/link";
import { useDistanceUnit } from "@/app/DistanceUnitProvider";
import { formatDist, unitLabel } from "@/lib/distance";

interface TrailRow {
  slug: string;
  name: string;
  region: string;
  total_distance: number;
  completion_percentage: number | null;
  completed_distance: number | null;
  activity_count: number | null;
}

interface Props {
  trails: TrailRow[];
  selectedSlug?: string | null;
  onTrailSelect?: (slug: string) => void;
}

function pct(n: number | null) {
  if (n == null) return 0;
  return Math.min(Math.round(n), 100);
}

export default function TrailProgressList({ trails, selectedSlug, onTrailSelect }: Props) {
  const { unit } = useDistanceUnit();
  if (trails.length === 0) return null;

  const started = trails.filter((t) => (t.completion_percentage ?? 0) > 0);
  const unstarted = trails.filter((t) => !(t.completion_percentage ?? 0));
  const ul = unitLabel(unit);

  return (
    <div className="flex flex-col gap-2.5">
      {[...started, ...unstarted].map((trail) => {
        const p = pct(trail.completion_percentage);
        const coveredDist = formatDist(trail.completed_distance, unit);
        const totalDist = formatDist(trail.total_distance, unit);
        const isStarted = p > 0;
        const isSelected = selectedSlug === trail.slug;

        return (
          <Link
            key={trail.slug}
            id={`trail-${trail.slug}`}
            href={`/trail/${trail.slug}`}
            onClick={() => onTrailSelect?.(trail.slug)}
            className={`block rounded-xl px-4 py-3 transition-all border ${
              isSelected
                ? "bg-white border-[#C4652A]/40 shadow-sm"
                : "bg-white border-[#E5DED4] hover:bg-[#FAF8F5] hover:border-[#C4652A]/20"
            }`}
          >
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${isStarted ? "text-[#2C2520]" : "text-[#8A7F72]"}`}>
                  {trail.name}
                </p>
                <p className="text-[#8A7F72] text-xs mt-0.5">{trail.region}</p>
              </div>
              <span className={`text-sm font-semibold tabular-nums shrink-0 ${
                p >= 100 ? "text-[#4A7C59]" : isStarted ? "text-[#2C2520]" : "text-[#8A7F72]/50"
              }`}>
                {p}%
              </span>
            </div>

            <div className="h-1.5 bg-[#EAE4DA] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 bg-[#4A7C59]"
                style={{ width: `${p}%`, opacity: isStarted ? 1 : 0 }}
              />
            </div>

            <div className="flex items-center justify-between mt-1.5">
              <p className="text-[#8A7F72] text-xs">
                {coveredDist} / {totalDist} {ul}
              </p>
              {(trail.activity_count ?? 0) > 0 && (
                <p className="text-[#8A7F72]/70 text-xs">
                  {trail.activity_count} activit{trail.activity_count === 1 ? "y" : "ies"}
                </p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
