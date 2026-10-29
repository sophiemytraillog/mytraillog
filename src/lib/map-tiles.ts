// Shared Leaflet tile sources for DashboardMap and TrailMap, kept in one
// file so the key handling and attribution don't drift apart.
//
// - Dashboard: MapTiler Landscape. It has terrain shading but no boundary
//   lines, a plain sea and no drawn walking routes, so it looks clean at
//   UK-wide zoom under the app's green/grey trail lines.
// - Trail detail: MapTiler Topo. It adds contours, peak names and stronger
//   terrain detail that are useful when zoomed in on a single trail.
//
// Outdoor/Outdoor v2 aren't used: they overlay pink and red hiking-route
// lines that clash with the app's own trail lines.
//
// Both fall back to the original OpenStreetMap raster tiles whenever
// NEXT_PUBLIC_MAPTILER_API_KEY isn't set (local dev before the key's been
// added, or a preview deploy missing the env var) so the map still renders
// instead of showing blank/404 tiles.
const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const maptilerUrl = (style: string) =>
  `https://api.maptiler.com/maps/${style}/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`;

export const DASHBOARD_TILE_URL = MAPTILER_KEY ? maptilerUrl("landscape") : OSM_TILE_URL;

export const TRAIL_TILE_URL = MAPTILER_KEY ? maptilerUrl("topo-v2") : OSM_TILE_URL;

export const TILE_ATTRIBUTION = MAPTILER_KEY
  ? '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>'
  : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
