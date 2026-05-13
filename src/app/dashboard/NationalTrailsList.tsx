"use client";

import { useState } from "react";
import Link from "next/link";
import type { TrailRow } from "./DashboardClient";
import { useDistanceUnit } from "@/app/DistanceUnitProvider";
import { formatDist, unitLabel } from "@/lib/distance";

interface Props {
  trails: TrailRow[];
  childrenByParentId: Record<string, TrailRow[]>;
  selectedSlug?: string | null;
  onTrailSelect?: (slug: string) => void;
}

function pct(n: number | null) {
  return Math.min(Math.round(n ?? 0), 100);
}

/** Strip the parent trail name prefix from a section name for compact display. */
function sectionLabel(childName: string, parentName: string): string {
  // "Foo (Bar baz)" → "Bar baz"
  const parenMatch = childName.match(/\(([^)]+)\)$/);
  if (parenMatch) return parenMatch[1];
  // "Foo - Bar" or "Foo – Bar" → "Bar"
  if (childName.toLowerCase().startsWith(parentName.toLowerCase())) {
    const rest = childName.slice(parentName.length).replace(/^\s*[-–\s]+/, "").trim();
    if (rest) return rest;
  }
  return childName;
}

export default function NationalTrailsList({
  trails, childrenByParentId, selectedSlug, onTrailSelect,
}: Props) {
  const { unit } = useDistanceUnit();
  const ul = unitLabel(unit);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const started   = trails.filter(t => (t.completion_percentage ?? 0) > 0);
  const unstarted = trails.filter(t => !((t.completion_percentage ?? 0) > 0));

  return (
    <div className="flex flex-col gap-2.5">
      {[...started, ...unstarted].map(trail => {
        const p = pct(trail.completion_percentage);
        const coveredDist = formatDist(trail.completed_distance, unit);
        const isStarted = p > 0;
        const isSelected = selectedSlug === trail.slug;
        const children = (childrenByParentId[trail.id] ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const hasChildren = children.length > 0;
        const isExpanded = expandedIds.has(trail.id);

        return (
          <div key={trail.slug} id={`trail-${trail.slug}`}>
            {/* Parent trail card */}
            <Link
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
                  {coveredDist} / {formatDist(trail.total_distance, unit)} {ul}
                </p>
                {(trail.activity_count ?? 0) > 0 && (
                  <p className="text-[#8A7F72]/70 text-xs">
                    {trail.activity_count} activit{trail.activity_count === 1 ? "y" : "ies"}
                  </p>
                )}
              </div>
            </Link>

            {/* Sections toggle */}
            {hasChildren && (
              <button
                onClick={() => toggleExpanded(trail.id)}
                className="flex items-center gap-1 text-[10px] text-[#8A7F72] hover:text-[#C4652A] transition-colors mt-1 ml-1 pl-2"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
                {children.length} section{children.length !== 1 ? "s" : ""}
              </button>
            )}

            {/* Expanded child sections */}
            {hasChildren && isExpanded && (
              <div className="mt-1 ml-3 pl-3 border-l-2 border-[#E5DED4] flex flex-col gap-1.5 pb-1">
                {children.map(child => {
                  const cp = pct(child.completion_percentage);
                  const childStarted = cp > 0;
                  const childSelected = selectedSlug === child.slug;
                  return (
                    <Link
                      key={child.slug}
                      id={`trail-${child.slug}`}
                      href={`/trail/${child.slug}`}
                      onClick={() => onTrailSelect?.(child.slug)}
                      className={`block rounded-lg px-3 py-2 transition-all border ${
                        childSelected
                          ? "bg-white border-[#C4652A]/40 shadow-sm"
                          : "bg-white border-[#E5DED4] hover:bg-[#FAF8F5] hover:border-[#C4652A]/20"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className={`text-xs font-medium truncate ${childStarted ? "text-[#2C2520]" : "text-[#8A7F72]"}`}>
                          {sectionLabel(child.name, trail.name)}
                        </p>
                        <span className={`text-xs tabular-nums shrink-0 ${
                          cp >= 100 ? "text-[#4A7C59]" : childStarted ? "text-[#2C2520]" : "text-[#8A7F72]/40"
                        }`}>
                          {cp}%
                        </span>
                      </div>
                      <div className="h-1 bg-[#EAE4DA] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#4A7C59]"
                          style={{ width: `${cp}%`, opacity: childStarted ? 1 : 0 }}
                        />
                      </div>
                      <p className="text-[#8A7F72]/70 text-[10px] mt-1">
                        {formatDist(child.completed_distance, unit)} / {formatDist(child.total_distance, unit)} {ul}
                      </p>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
