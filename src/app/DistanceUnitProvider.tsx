"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { DistanceUnit } from "@/lib/distance";

const STORAGE_KEY = "distance_unit";

const DistanceUnitContext = createContext<{
  unit: DistanceUnit;
  setUnit: (u: DistanceUnit) => void;
}>({ unit: "km", setUnit: () => {} });

export function DistanceUnitProvider({ children }: { children: React.ReactNode }) {
  const [unit, setUnitState] = useState<DistanceUnit>("km");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "mi" || stored === "km") setUnitState(stored);
  }, []);

  function setUnit(u: DistanceUnit) {
    setUnitState(u);
    localStorage.setItem(STORAGE_KEY, u);
    // Persisted server-side so Strava description writes have a fallback
    // when the athlete's Strava measurement_preference is unavailable.
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ distance_unit: u }),
    }).catch(() => {});
  }

  return (
    <DistanceUnitContext.Provider value={{ unit, setUnit }}>
      {children}
    </DistanceUnitContext.Provider>
  );
}

export function useDistanceUnit() {
  return useContext(DistanceUnitContext);
}
