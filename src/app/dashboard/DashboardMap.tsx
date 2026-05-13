"use client";

import { useEffect, useRef } from "react";

type Coord = [number, number];

interface GeoJsonGeom {
  type: string;
  coordinates?: Coord[] | Coord[][];
  geometries?: GeoJsonGeom[];
}

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

export interface TrailGeoData {
  slug: string;
  name: string;
  trail_geojson: object;
  completed_geojson: object | null;
}

interface LayerPair {
  base: { setStyle: (s: object) => void; bringToFront: () => void };
  completed: { setStyle: (s: object) => void; bringToFront: () => void } | null;
}

interface Props {
  trails: TrailGeoData[];
  selectedSlug: string | null;
  onTrailClick: (slug: string) => void;
}

export default function DashboardMap({ trails, selectedSlug, onTrailClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);
  const layersRef = useRef<Map<string, LayerPair>>(new Map());

  const onTrailClickRef = useRef(onTrailClick);
  onTrailClickRef.current = onTrailClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    import("leaflet").then((L) => {
      if (!containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, { zoomControl: true, zoomAnimation: false });
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map);

      // Fit to Great Britain
      map.fitBounds([[49.5, -8.5], [61.0, 2.0]]);

      for (const trail of trails) {
        if (!trail.trail_geojson) continue;
        const rings = toLatLngRings(trail.trail_geojson as GeoJsonGeom);
        if (rings.length === 0) continue;

        const base = L.polyline(rings as L.LatLngExpression[][], {
          color: "#9ca3af",
          weight: 3,
          opacity: 0.8,
          fill: false,
        }).addTo(map);

        base.on("click", () => onTrailClickRef.current(trail.slug));

        let completed: LayerPair["completed"] = null;
        if (trail.completed_geojson) {
          const cRings = toLatLngRings(trail.completed_geojson as GeoJsonGeom);
          if (cRings.length > 0) {
            const cLine = L.polyline(cRings as L.LatLngExpression[][], {
              color: "#4A7C59",
              weight: 3,
              opacity: 1,
              fill: false,
            }).addTo(map);
            cLine.on("click", () => onTrailClickRef.current(trail.slug));
            completed = cLine as unknown as LayerPair["completed"];
          }
        }

        layersRef.current.set(trail.slug, {
          base: base as unknown as LayerPair["base"],
          completed,
        });
      }
    });

    return () => {
      if (mapRef.current) {
        (mapRef.current as { remove: () => void }).remove();
        mapRef.current = null;
        layersRef.current.clear();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-style layers when selected trail changes
  useEffect(() => {
    const hasSelection = selectedSlug !== null;

    for (const [slug, { base, completed }] of layersRef.current.entries()) {
      const isSelected = slug === selectedSlug;

      base.setStyle({
        weight: isSelected ? 5 : 3,
        opacity: isSelected ? 1 : hasSelection ? 0.3 : 0.8,
      });

      if (completed) {
        completed.setStyle({
          weight: isSelected ? 5 : 3,
          opacity: isSelected ? 1 : hasSelection ? 0.3 : 1,
        });
      }

      if (isSelected) {
        base.bringToFront();
        completed?.bringToFront();
      }
    }
  }, [selectedSlug]);

  return (
    <div className="w-full rounded-2xl overflow-hidden border border-[#E5DED4]" style={{ height: "750px" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
