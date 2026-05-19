"use client";

import { useEffect, useRef } from "react";

type Coord = [number, number]; // [lon, lat] from GeoJSON

interface GeoJsonGeom {
  type: string;
  coordinates?: Coord[] | Coord[][];
  geometries?: GeoJsonGeom[];
}

export interface TrailMapProps {
  trailGeoJson: object;
  completedGeoJson: object | null;
  manualGeoJson: object | null;
  showRemaining: boolean;
  isMarkingMode: boolean;
  markingPoints: Array<[number, number]>; // [lon, lat]
  onMapClick: (latlng: [number, number]) => void;
  selectedActivityGeoJson: object | null;
}

// Convert GeoJSON [lon, lat] pairs → Leaflet [lat, lon] arrays (handles LineString,
// MultiLineString, and GeometryCollection of LineStrings).
function toLatLngRings(geom: GeoJsonGeom): [number, number][][] {
  if (geom.type === "LineString") {
    return [(geom.coordinates as Coord[]).map(([lon, lat]) => [lat, lon])];
  }
  if (geom.type === "MultiLineString") {
    return (geom.coordinates as Coord[][]).map((ring) =>
      ring.map(([lon, lat]) => [lat, lon])
    );
  }
  if (geom.type === "GeometryCollection" && geom.geometries) {
    return geom.geometries.flatMap((g) => toLatLngRings(g));
  }
  return [];
}

export default function TrailMap({
  trailGeoJson,
  completedGeoJson,
  manualGeoJson,
  showRemaining,
  isMarkingMode,
  markingPoints,
  onMapClick,
  selectedActivityGeoJson,
}: TrailMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const trailLayerRef = useRef<unknown>(null);
  const manualLayerRef = useRef<unknown>(null);
  const selectedLayerRef = useRef<unknown>(null);
  const trailBoundsRef = useRef<unknown>(null);
  const markersRef = useRef<unknown[]>([]);
  // Tracks whether the async leaflet init has completed
  const leafletReadyRef = useRef(false);

  // Refs so async callbacks always see the latest prop values without re-running init
  const showRemainingRef = useRef(showRemaining);
  showRemainingRef.current = showRemaining;
  const isMarkingModeRef = useRef(isMarkingMode);
  isMarkingModeRef.current = isMarkingMode;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const manualGeoJsonRef = useRef(manualGeoJson);
  manualGeoJsonRef.current = manualGeoJson;

  // ── One-time map initialisation ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    import("leaflet").then((L) => {
      if (!containerRef.current || mapRef.current) return;
      leafletRef.current = L;

      const map = L.map(containerRef.current, { zoomControl: true });
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 18,
      }).addTo(map);

      // Trail line — grey normally, burnt orange when showRemaining is on
      const trailRings = toLatLngRings(trailGeoJson as GeoJsonGeom);
      const trailLayer = L.polyline(trailRings as L.LatLngExpression[][], {
        color: showRemainingRef.current ? "#C4652A" : "#9ca3af",
        weight: 4,
        opacity: 0.9,
        fill: false,
        smoothFactor: 1,
      }).addTo(map);
      trailLayerRef.current = trailLayer;

      // GPS-verified completed sections (forest green)
      if (completedGeoJson) {
        const rings = toLatLngRings(completedGeoJson as GeoJsonGeom);
        if (rings.length > 0) {
          L.polyline(rings as L.LatLngExpression[][], {
            color: "#4A7C59",
            weight: 4,
            opacity: 1,
            fill: false,
            smoothFactor: 1,
          }).addTo(map);
        }
      }

      // Manually filled sections (dashed light green) — apply current value from ref
      if (manualGeoJsonRef.current) {
        const rings = toLatLngRings(manualGeoJsonRef.current as GeoJsonGeom);
        if (rings.length > 0) {
          manualLayerRef.current = L.polyline(rings as L.LatLngExpression[][], {
            color: "#4A7C59",
            weight: 5,
            opacity: 1,
            dashArray: "10, 8",
            fill: false,
            smoothFactor: 1,
          }).addTo(map);
        }
      }

      // Map click handler for manual marking mode
      map.on("click", (e: L.LeafletMouseEvent) => {
        if (isMarkingModeRef.current) {
          onMapClickRef.current([e.latlng.lng, e.latlng.lat]);
        }
      });

      const bounds = trailLayer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [24, 24] });
        trailBoundsRef.current = bounds;
      }
      map.invalidateSize();

      leafletReadyRef.current = true;
    });

    return () => {
      if (mapRef.current) {
        (mapRef.current as { remove: () => void }).remove();
        mapRef.current = null;
        leafletRef.current = null;
        trailLayerRef.current = null;
        manualLayerRef.current = null;
        selectedLayerRef.current = null;
        trailBoundsRef.current = null;
        markersRef.current = [];
        leafletReadyRef.current = false;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toggle remaining: recolour the trail layer ──────────────────────────────
  useEffect(() => {
    if (!leafletReadyRef.current || !trailLayerRef.current) return;
    (trailLayerRef.current as { setStyle: (s: object) => void }).setStyle({
      color: showRemaining ? "#C4652A" : "#9ca3af",
    });
  }, [showRemaining]);

  // ── Manual segments layer: recreate whenever the geometry changes ───────────
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !leafletReadyRef.current) return;

    if (manualLayerRef.current) {
      (manualLayerRef.current as { remove: () => void }).remove();
      manualLayerRef.current = null;
    }

    if (manualGeoJson) {
      const rings = toLatLngRings(manualGeoJson as GeoJsonGeom);
      if (rings.length > 0) {
        manualLayerRef.current = L.polyline(rings as L.LatLngExpression[][], {
          color: "#4A7C59",
          weight: 5,
          opacity: 1,
          dashArray: "10, 8",
          fill: false,
          smoothFactor: 1,
        }).addTo(map as L.Map);
      }
    }
  }, [manualGeoJson]);

  // ── Crosshair cursor when in marking mode ───────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.style.cursor = isMarkingMode ? "crosshair" : "";
  }, [isMarkingMode]);

  // ── Selected activity highlight (burnt orange) ───────────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !leafletReadyRef.current) return;

    if (selectedLayerRef.current) {
      (selectedLayerRef.current as { remove: () => void }).remove();
      selectedLayerRef.current = null;
    }

    if (selectedActivityGeoJson) {
      const rings = toLatLngRings(selectedActivityGeoJson as GeoJsonGeom);
      if (rings.length > 0) {
        const layer = L.polyline(rings as L.LatLngExpression[][], {
          color: "#C4652A",
          weight: 5,
          opacity: 1,
          fill: false,
          smoothFactor: 1,
        }).addTo(map as L.Map);
        selectedLayerRef.current = layer;

        const bounds = layer.getBounds();
        if (bounds.isValid()) {
          (map as L.Map).fitBounds(bounds, { padding: [48, 48] });
        }
      }
    } else {
      // Deselected — zoom back to full trail
      const trailBounds = trailBoundsRef.current;
      if (trailBounds && (trailBounds as L.LatLngBounds).isValid()) {
        (map as L.Map).fitBounds(trailBounds as L.LatLngBounds, { padding: [24, 24] });
      }
    }
  }, [selectedActivityGeoJson]);

  // ── Orange dot markers for selected marking points ──────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !leafletReadyRef.current) return;

    markersRef.current.forEach((m) => (m as { remove: () => void }).remove());
    markersRef.current = [];

    for (const [lon, lat] of markingPoints) {
      const marker = L.circleMarker([lat, lon] as L.LatLngExpression, {
        radius: 8,
        color: "#C4652A",
        fillColor: "#C4652A",
        fillOpacity: 1,
        weight: 2,
      }).addTo(map as L.Map);
      markersRef.current.push(marker);
    }
  }, [markingPoints]);

  return (
    <div className="w-full rounded-2xl overflow-hidden" style={{ height: "500px" }}>
      <div ref={containerRef} style={{ width: "100%", height: "500px" }} />
    </div>
  );
}
