// Shared Leaflet tile source for DashboardMap and TrailMap — one definition
// so the two don't drift apart the way duplicated SQL has elsewhere in this
// codebase. MapTiler's Landscape style is used because it has terrain
// shading but no boundary lines, a plain sea, and no drawn walking routes.
// (Outdoor/Outdoor v2 overlay pink and red hiking-route lines that clash
// with the app's own green/grey trail lines, and the legacy Outdoor style
// also draws dashed maritime boundaries across the sea.) Falls
// back to the original OpenStreetMap raster tiles whenever
// NEXT_PUBLIC_MAPTILER_API_KEY isn't set (local dev before the key's been
// added, or a preview deploy missing the env var) so the map still renders
// instead of showing blank/404 tiles.
const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;

export const TILE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/landscape/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`
  : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

export const TILE_ATTRIBUTION = MAPTILER_KEY
  ? '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>'
  : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
