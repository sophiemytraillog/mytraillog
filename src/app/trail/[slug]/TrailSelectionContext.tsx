"use client";

import { createContext, useContext } from "react";

interface TrailSelectionContextValue {
  selectedActivityId: string | null;
  selectActivity: (id: string | null, geojson: object | null) => void;
}

export const TrailSelectionContext = createContext<TrailSelectionContextValue>({
  selectedActivityId: null,
  selectActivity: () => {},
});

export function useTrailSelection() {
  return useContext(TrailSelectionContext);
}
