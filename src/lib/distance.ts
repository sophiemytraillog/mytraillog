export type DistanceUnit = "km" | "mi";

export function formatDist(meters: number | null | undefined, unit: DistanceUnit): string {
  if (!meters) return "0";
  return unit === "mi"
    ? (meters / 1609.344).toFixed(1)
    : (meters / 1000).toFixed(1);
}

export function unitLabel(unit: DistanceUnit): string {
  return unit === "mi" ? "mi" : "km";
}
