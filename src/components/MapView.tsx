// src/components/MapView.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Cafe, TimeState, SunTimeline, SunTimelineData } from "@/types";
import { getSunPosition, getSunTimes } from "@/lib/sun";
import { calcShadowPolygon } from "@/lib/buildingShadow";
import type { BuildingFeature } from "@/app/api/buildings/route";

// ─── constants ────────────────────────────────────────────────────────────────

const DISTRICT_BOUNDS = {
  south: 48.175, west: 16.333,
  north: 48.230, east: 16.375,
} as const;

const MAP_CENTER: [number, number] = [
  (DISTRICT_BOUNDS.south + DISTRICT_BOUNDS.north) / 2,
  (DISTRICT_BOUNDS.west  + DISTRICT_BOUNDS.east)  / 2,
];
const NEUBAU_CENTER = MAP_CENTER;
const FALLBACK_HEIGHT = 18;

// OpenFreeMap positron — free, no API key, clean light style
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

// Shadow canvas: pre-rendered at a fixed resolution and fed to MapLibre as
// a raster image source. A single ctx.fill() call on the full path produces
// the union of all shadow polygons — overlapping areas are filled only once
// so opacity never accumulates even where building shadows stack.
//
// Resolution matches SHADOW_RENDER_ZOOM=16 (same as the old Leaflet approach)
// so shadow edges are crisp at zoom 16 and still sharp at zoom 17.
const _ZOOM16_PX  = (Math.pow(2, 16) * 256) / 360; // pixels per degree at zoom 16
const SHADOW_W    = Math.ceil((DISTRICT_BOUNDS.east - DISTRICT_BOUNDS.west) * _ZOOM16_PX); // ~1966
const SHADOW_H    = Math.ceil((DISTRICT_BOUNDS.north - DISTRICT_BOUNDS.south) * _ZOOM16_PX); // ~2560
// MapLibre image-source corner order: top-left, top-right, bottom-right, bottom-left
const SHADOW_COORDS: [[number,number],[number,number],[number,number],[number,number]] = [
  [DISTRICT_BOUNDS.west, DISTRICT_BOUNDS.north],
  [DISTRICT_BOUNDS.east, DISTRICT_BOUNDS.north],
  [DISTRICT_BOUNDS.east, DISTRICT_BOUNDS.south],
  [DISTRICT_BOUNDS.west, DISTRICT_BOUNDS.south],
];

// ─── types ────────────────────────────────────────────────────────────────────

interface MapViewProps {
  timeState: TimeState;
  cafes: Cafe[];
  selectedCafe: Cafe | null;
  onCafeSelect: (cafe: Cafe | null) => void;
  onSunRemaining: (data: Record<string, number | null>) => void;
  onSunTimeline: (data: SunTimelineData) => void;
}

// ─── sun computation (unchanged) ─────────────────────────────────────────────

function calcSunRemaining(
  cafe: Cafe,
  currentDate: Date,
  buildings: BuildingFeature[],
): number | null {
  const STEP_MS   = 10 * 60 * 1000;
  const MAX_STEPS = 24;
  const OFFSET_M  = 10;
  const LAT_MAX   = 200 / 111_000;
  const LNG_MAX   = 200 / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));

  // Hard cap: result can never exceed actual minutes until sunset
  const sunTimes = getSunTimes(cafe.lat, cafe.lng, currentDate);
  const minsUntilSunset = Math.max(0, Math.floor((sunTimes.sunset.getTime() - currentDate.getTime()) / 60_000));
  if (minsUntilSunset === 0) return null;

  const nearby = buildings.filter((b) => {
    const [bLat, bLng] = b.polygon[0];
    return Math.abs(bLat - cafe.lat) < LAT_MAX && Math.abs(bLng - cafe.lng) < LNG_MAX;
  });

  for (let step = 0; step <= MAX_STEPS; step++) {
    const date   = new Date(currentDate.getTime() + step * STEP_MS);
    const sunPos = getSunPosition(cafe.lat, cafe.lng, date);
    if (sunPos.altitudeDeg <= 0) return step === 0 ? null : Math.min((step - 1) * 10, minsUntilSunset);

    const azRad  = (sunPos.azimuthDeg * Math.PI) / 180;
    const dlat   = (OFFSET_M * Math.cos(azRad)) / 111_000;
    const dlng   = (OFFSET_M * Math.sin(azRad)) / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));
    const chkLat = cafe.lat + dlat;
    const chkLng = cafe.lng + dlng;

    const inShadow = nearby.some((b) => {
      const poly = calcShadowPolygon(b.polygon, b.height ?? FALLBACK_HEIGHT, sunPos.altitudeDeg, sunPos.azimuthDeg);
      return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
    });
    if (inShadow) return step === 0 ? null : Math.min((step - 1) * 10, minsUntilSunset);
  }
  return Math.min(MAX_STEPS * 10, minsUntilSunset);
}

function calcDayTimeline(
  cafe: Cafe,
  date: Date,
  buildings: BuildingFeature[],
): SunTimeline {
  const INTERVAL_MIN = 20;
  const OFFSET_M     = 10;
  const LAT_MAX      = 200 / 111_000;
  const LNG_MAX      = 200 / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));

  const nearby = buildings.filter((b) => {
    const [bLat, bLng] = b.polygon[0];
    return Math.abs(bLat - cafe.lat) < LAT_MAX && Math.abs(bLng - cafe.lng) < LNG_MAX;
  });

  const times       = getSunTimes(cafe.lat, cafe.lng, date);
  const startMinute = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
  const endMinute   = times.sunset.getHours()  * 60 + times.sunset.getMinutes();
  const inSun: boolean[] = [];

  for (let minute = startMinute; minute <= endMinute; minute += INTERVAL_MIN) {
    const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(),
      Math.floor(minute / 60), minute % 60, 0, 0);
    const sunPos = getSunPosition(cafe.lat, cafe.lng, slotDate);
    if (sunPos.altitudeDeg <= 0) { inSun.push(false); continue; }

    const azRad  = (sunPos.azimuthDeg * Math.PI) / 180;
    const dlat   = (OFFSET_M * Math.cos(azRad)) / 111_000;
    const dlng   = (OFFSET_M * Math.sin(azRad)) / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));
    const chkLat = cafe.lat + dlat;
    const chkLng = cafe.lng + dlng;

    const inShadow = nearby.some((b) => {
      const poly = calcShadowPolygon(b.polygon, b.height ?? FALLBACK_HEIGHT, sunPos.altitudeDeg, sunPos.azimuthDeg);
      return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
    });
    inSun.push(!inShadow);
  }

  return { inSun, startMinute, intervalMin: INTERVAL_MIN };
}

function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [lati, lngi] = poly[i];
    const [latj, lngj] = poly[j];
    if ((lngi > lng) !== (lngj > lng) &&
        lat < ((latj - lati) * (lng - lngi)) / (lngj - lngi) + lati) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── shadow canvas renderer ───────────────────────────────────────────────────
// Draws all shadow polygons onto a single canvas with one ctx.fill() call.
// Because the entire path is filled at once, overlapping building shadows
// produce no opacity stacking — the result is a flat uniform dark layer.

function renderShadowCanvas(
  canvas: HTMLCanvasElement,
  allBuildings: BuildingFeature[],
  timeState: TimeState,
) {
  const ctx    = canvas.getContext("2d")!;
  const date   = new Date(`${timeState.date}T${timeState.time}:00`);
  const sunPos = getSunPosition(NEUBAU_CENTER[0], NEUBAU_CENTER[1], date);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#334155";

  if (sunPos.altitudeDeg <= 0) {
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  ctx.beginPath();
  for (const b of allBuildings) {
    const shadow = calcShadowPolygon(
      b.polygon, b.height ?? FALLBACK_HEIGHT,
      sunPos.altitudeDeg, sunPos.azimuthDeg,
    );
    if (shadow.length < 3) continue;
    let first = true;
    for (const [lat, lng] of shadow as [number, number][]) {
      // Equirectangular projection — negligible error for a ~6 km area
      const x = (lng - DISTRICT_BOUNDS.west)  / (DISTRICT_BOUNDS.east  - DISTRICT_BOUNDS.west)  * canvas.width;
      const y = (DISTRICT_BOUNDS.north - lat)  / (DISTRICT_BOUNDS.north - DISTRICT_BOUNDS.south) * canvas.height;
      if (first) { ctx.moveTo(x, y); first = false; }
      else         ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.fill(); // single fill → union of all polygons, no opacity stacking
}

// Flip [lat, lng] polygon to GeoJSON [lng, lat] and close the ring
function polygonToGeoJSON(polygon: [number, number][]): number[][] {
  const ring = polygon.map(([lat, lng]) => [lng, lat]);
  if (ring.length > 0 &&
      (ring[0][0] !== ring[ring.length - 1][0] ||
       ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push(ring[0]);
  }
  return ring;
}

// ─── component ────────────────────────────────────────────────────────────────

export function MapView({
  timeState, cafes, selectedCafe, onCafeSelect, onSunRemaining, onSunTimeline,
}: MapViewProps) {
  const mapRef         = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  const mapReadyRef    = useRef(false);  // true once map 'load' event fired

  const shadowCanvasRef   = useRef<HTMLCanvasElement | null>(null);
  const buildingCacheRef  = useRef<Map<number, BuildingFeature>>(new Map());
  const sunGenRef         = useRef(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locationMarkerRef = useRef<any>(null);

  // Stable refs so event handlers always see current prop values
  const cafesRef          = useRef<Cafe[]>(cafes);
  cafesRef.current        = cafes;
  const selectedCafeRef   = useRef<Cafe | null>(selectedCafe);
  selectedCafeRef.current = selectedCafe;
  const onCafeSelectRef   = useRef(onCafeSelect);
  onCafeSelectRef.current = onCafeSelect;
  const onSunRemainingRef = useRef(onSunRemaining);
  onSunRemainingRef.current = onSunRemaining;
  const onSunTimelineRef  = useRef(onSunTimeline);
  onSunTimelineRef.current = onSunTimeline;
  const timeStateRef      = useRef(timeState);
  timeStateRef.current    = timeState;

  const [fetching,  setFetching]  = useState(false);
  const [locating,  setLocating]  = useState(false);

  // ── helpers ────────────────────────────────────────────────────────────────

  // Push updated café GeoJSON to the map source.
  // recomputeSunData = true → also kick off the heavy sun-remaining/timeline
  // computation in idle-time chunks (generation-guarded against stale runs).
  function updateCafesSource(recomputeSunData = true) {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;
    const source = map.getSource("cafes-source");
    if (!source) return;

    const ts     = timeStateRef.current;
    const date   = new Date(`${ts.date}T${ts.time}:00`);
    const sunPos = getSunPosition(NEUBAU_CENTER[0], NEUBAU_CENTER[1], date);
    const OFFSET_M = 10;
    const azRad  = (sunPos.azimuthDeg * Math.PI) / 180;
    const selId  = selectedCafeRef.current?.id ?? null;

    const allBuildings = Array.from(buildingCacheRef.current.values());

    const features = cafesRef.current.map((cafe) => {
      let chkLat = cafe.lat, chkLng = cafe.lng;
      if (sunPos.altitudeDeg > 0) {
        const dlat = (OFFSET_M * Math.cos(azRad)) / 111_000;
        const dlng = (OFFSET_M * Math.sin(azRad)) / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));
        chkLat = cafe.lat + dlat;
        chkLng = cafe.lng + dlng;
      }

      let inShadow: boolean;
      if (sunPos.altitudeDeg <= 0) {
        inShadow = true;
      } else {
        const LAT_MAX = 200 / 111_000;
        const LNG_MAX = 200 / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));
        const nearby = allBuildings.filter((b) => {
          const [bLat, bLng] = b.polygon[0];
          return Math.abs(bLat - cafe.lat) < LAT_MAX && Math.abs(bLng - cafe.lng) < LNG_MAX;
        });
        inShadow = nearby.some((b) => {
          const poly = calcShadowPolygon(b.polygon, b.height ?? FALLBACK_HEIGHT, sunPos.altitudeDeg, sunPos.azimuthDeg);
          return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
        });
      }

      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [cafe.lng, cafe.lat] },
        properties: { id: cafe.id, name: cafe.name, inShadow, isSelected: cafe.id === selId },
      };
    });

    source.setData({ type: "FeatureCollection", features });

    if (!recomputeSunData) return;

    // Heavy computation: sun-remaining + day timeline for all cafés.
    // Uses requestIdleCallback so chunks only run when the browser is idle,
    // keeping map gestures smooth. Generation counter cancels stale runs.
    const buildings   = Array.from(buildingCacheRef.current.values());
    const currentDate = new Date(`${ts.date}T${ts.time}:00`);
    const dayDate     = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 12, 0, 0);
    const allCafes    = [...cafesRef.current];
    const remaining: Record<string, number | null> = {};
    const timelines: SunTimelineData = {};
    const CHUNK = 15;
    let idx = 0;
    const gen = ++sunGenRef.current;

    const schedule = (fn: () => void) =>
      typeof requestIdleCallback !== "undefined"
        ? requestIdleCallback(fn, { timeout: 3000 })
        : setTimeout(fn, 16);

    function processChunk() {
      if (sunGenRef.current !== gen) return;
      const end = Math.min(idx + CHUNK, allCafes.length);
      for (; idx < end; idx++) {
        const cafe = allCafes[idx];
        remaining[cafe.id] = calcSunRemaining(cafe, currentDate, buildings);
        timelines[cafe.id] = calcDayTimeline(cafe, dayDate, buildings);
      }
      if (idx < allCafes.length) {
        schedule(processChunk);
      } else {
        onSunRemainingRef.current(remaining);
        onSunTimelineRef.current(timelines);
        // Sync dot colors with the accurate calcSunRemaining result
        const source = mapInstanceRef.current?.getSource("cafes-source");
        if (source && mapReadyRef.current) {
          const selId = selectedCafeRef.current?.id ?? null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (source as any).setData({
            type: "FeatureCollection",
            features: allCafes.map((cafe) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [cafe.lng, cafe.lat] },
              properties: {
                id: cafe.id, name: cafe.name,
                inShadow: remaining[cafe.id] === null,
                isSelected: cafe.id === selId,
              },
            })),
          });
        }
      }
    }
    schedule(processChunk);
  }

  // Render shadow canvas and push it to the MapLibre image source.
  function updateShadowSource(allBuildings: BuildingFeature[], ts: TimeState) {
    const canvas = shadowCanvasRef.current;
    const map    = mapInstanceRef.current;
    if (!canvas || !map || !mapReadyRef.current) return;
    renderShadowCanvas(canvas, allBuildings, ts);
    const source = map.getSource("shadow-source") as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    source?.updateImage({ url: canvas.toDataURL("image/png"), coordinates: SHADOW_COORDS });
  }

  // Update café dot colors after pan/zoom. Shadow check uses per-café nearby buildings.
  function refreshViewportShadows() {
    updateCafesSource(false);
  }

  function loadStaticBuildings() {
    setFetching(true);
    fetch("/buildings-cache.json")
      .then((r) => r.json())
      .then(({ buildings }: { buildings: BuildingFeature[] }) => {
        buildings.forEach((b) => buildingCacheRef.current.set(b.id, b));

        const map = mapInstanceRef.current;
        if (!map || !mapReadyRef.current) return;

        // Push building polygons to the GeoJSON source
        const source = map.getSource("buildings-source");
        if (source) {
          source.setData({
            type: "FeatureCollection",
            features: buildings.map((b) => ({
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [polygonToGeoJSON(b.polygon as [number,number][])] },
              properties: { id: b.id },
            })),
          });
        }

        // Build visual shadow layer and compute initial café statuses
        updateShadowSource(buildings, timeStateRef.current);
        updateCafesSource(true);
        setFetching(false);
      })
      .catch(() => setFetching(false));
  }

  function loadGreenAreas() {
    fetch("/green-areas-cache.json")
      .then((r) => r.json())
      .then(({ areas }: { areas: { id: number; polygon: [number, number][] }[] }) => {
        const map = mapInstanceRef.current;
        if (!map || !mapReadyRef.current) return;
        const source = map.getSource("green-areas-source");
        if (!source) return;
        source.setData({
          type: "FeatureCollection",
          features: areas.map((a) => ({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [polygonToGeoJSON(a.polygon)] },
            properties: { id: a.id },
          })),
        });
      })
      .catch(() => {});
  }

  // ── init map once ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    let mounted = true;

    import("maplibre-gl").then((maplibregl) => {
      if (!mounted || !mapRef.current || mapInstanceRef.current) return;

      const map = new maplibregl.Map({
        container: mapRef.current,
        style: MAP_STYLE,
        center: [MAP_CENTER[1], MAP_CENTER[0]], // MapLibre: [lng, lat]
        zoom: 14,
        minZoom: 12,
        maxZoom: 19,
        attributionControl: false,
      });

      mapInstanceRef.current = map;

      map.on("load", () => {
        if (!mounted) return;
        mapReadyRef.current = true;

        // Find the first symbol layer in the base style (road/place labels, icons).
        // All our custom layers are inserted before it so labels always render on top.
        const firstSymbolId = map.getStyle().layers.find(
          (l: { type: string }) => l.type === "symbol"
        )?.id;
        const before = firstSymbolId; // undefined is fine — appends to end if no symbols

        // ── filter place labels ────────────────────────────────────────────
        // In OpenFreeMap positron, "label_other" is a catch-all that renders
        // every place class not explicitly listed (city/country/state/town/village).
        // That includes both "suburb" (= official Bezirke, keep) and
        // "neighbourhood"/"quarter" (= Grätzl like Strozziggrund, hide).
        // We replace the filter with the same match expression but add the
        // unwanted classes to the exclusion list.
        map.setFilter("label_other", [
          "match", ["get", "class"],
          ["city", "continent", "country", "hamlet", "isolated_dwelling",
           "neighbourhood", "quarter", "state", "town", "village"],
          false,
          true,
        ]);

        // ── shadow canvas ──────────────────────────────────────────────────

        const shadowCanvas = document.createElement("canvas");
        shadowCanvas.width  = SHADOW_W;
        shadowCanvas.height = SHADOW_H;
        shadowCanvasRef.current = shadowCanvas;

        // ── sources ────────────────────────────────────────────────────────

        map.addSource("green-areas-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        // Static sunny-district overlay (amber rectangle over DISTRICT_BOUNDS)
        map.addSource("sunny-overlay-source", {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[
                [DISTRICT_BOUNDS.west,  DISTRICT_BOUNDS.south],
                [DISTRICT_BOUNDS.east,  DISTRICT_BOUNDS.south],
                [DISTRICT_BOUNDS.east,  DISTRICT_BOUNDS.north],
                [DISTRICT_BOUNDS.west,  DISTRICT_BOUNDS.north],
                [DISTRICT_BOUNDS.west,  DISTRICT_BOUNDS.south],
              ]],
            },
            properties: {},
          },
        });

        // Shadow source: raster image from the offscreen canvas.
        // Image sources avoid WebGL fill-opacity accumulation from overlapping polygons.
        map.addSource("shadow-source", {
          type: "image",
          url: shadowCanvas.toDataURL("image/png"), // blank initially
          coordinates: SHADOW_COORDS,
        });

        map.addSource("buildings-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addSource("cafes-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        // ── layers (z-order: bottom → top, all inserted before base labels) ─

        map.addLayer({
          id: "green-areas",
          type: "fill",
          source: "green-areas-source",
          paint: { "fill-color": "#86efac", "fill-opacity": 0.55 },
        }, before);

        map.addLayer({
          id: "sunny-overlay",
          type: "fill",
          source: "sunny-overlay-source",
          paint: { "fill-color": "#fde68a", "fill-opacity": 0.38 },
        }, before);

        // Raster shadow layer — opacity here is the only transparency applied;
        // the canvas itself is fully opaque dark pixels on transparent background.
        // raster-resampling: nearest prevents bilinear blur when zoomed in past
        // the canvas resolution, keeping shadow edges crisp at all zoom levels.
        map.addLayer({
          id: "shadows",
          type: "raster",
          source: "shadow-source",
          paint: { "raster-opacity": 0.55 },
        }, before);

        map.addLayer({
          id: "buildings-fill",
          type: "fill",
          source: "buildings-source",
          paint: { "fill-color": "#e2e8f0", "fill-opacity": 1.0 },
        }, before);

        map.addLayer({
          id: "buildings-outline",
          type: "line",
          source: "buildings-source",
          paint: { "line-color": "#94a3b8", "line-width": 0.8 },
        }, before);

        // Café dots — color + size driven by GeoJSON properties
        map.addLayer({
          id: "cafes",
          type: "circle",
          source: "cafes-source",
          paint: {
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              13, ["case", ["get", "isSelected"], 6, 3],
              16, ["case", ["get", "isSelected"], 7, 4],
              17, ["case", ["get", "isSelected"], 8, 5],
            ],
            "circle-color": ["case", ["get", "inShadow"], "#374151", "#ea580c"],
            "circle-stroke-width": ["case", ["get", "isSelected"], 2.5, 0],
            "circle-stroke-color": "#ffffff",
          },
        }, before);

        // Invisible 32 px hit area so cafés are easy to tap on mobile
        map.addLayer({
          id: "cafes-hit",
          type: "circle",
          source: "cafes-source",
          paint: {
            "circle-radius": 16,
            "circle-opacity": 0,
            "circle-stroke-opacity": 0,
          },
        }, before);

        // ── interactions ──────────────────────────────────────────────────

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.on("click", "cafes-hit", (e: any) => {
          if (!e.features?.length) return;
          const id = e.features[0].properties?.id;
          const cafe = cafesRef.current.find((c) => c.id === id);
          if (cafe) {
            e.originalEvent.stopPropagation();
            onCafeSelectRef.current(cafe);
          }
        });

        map.on("mouseenter", "cafes-hit", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "cafes-hit", () => {
          map.getCanvas().style.cursor = "";
        });

        // ── viewport events ───────────────────────────────────────────────

        // Recompute viewport shadows and redraw café dots after any pan/zoom.
        // Shadow visual layer needs no repositioning — MapLibre handles that.
        map.on("moveend", () => {
          refreshViewportShadows();
        });

        // ── load data ─────────────────────────────────────────────────────

        loadStaticBuildings();
        loadGreenAreas();
      });
    });

    return () => {
      mounted = false;
      mapReadyRef.current = false;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── redraw when time changes ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;
    const all = Array.from(buildingCacheRef.current.values());
    if (all.length === 0) return;

    // Rebuild full visual shadow layer
    updateShadowSource(all, timeState);

    updateCafesSource(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeState]);

  // ── redraw when café list changes ─────────────────────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateCafesSource(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cafes]);

  // ── redraw dots when selection changes ────────────────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateCafesSource(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCafe]);

  // ── pan to selected café ──────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedCafe || !mapInstanceRef.current) return;
    mapInstanceRef.current.easeTo({
      center: [selectedCafe.lng, selectedCafe.lat],
      duration: 400,
    });
  }, [selectedCafe]);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full relative">
      <div ref={mapRef} className="w-full h-full" />

      {fetching && (
        <div className="absolute top-3 left-14 z-[1000] bg-white/80 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-lg shadow-zinc-200/30 px-3.5 py-2 flex items-center gap-2 font-body text-zinc-500" style={{ fontSize: "12px" }}>
          <div className="w-3 h-3 border-[1.5px] border-amber-400 border-t-transparent rounded-full animate-spin" />
          Gebäude laden…
        </div>
      )}

      {/* Locate button */}
      <button
        onClick={() => {
          if (!mapInstanceRef.current) return;
          setLocating(true);
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              setLocating(false);
              import("maplibre-gl").then((maplibregl) => {
                const map = mapInstanceRef.current;
                if (!map) return;
                const { latitude: lat, longitude: lng } = pos.coords;

                locationMarkerRef.current?.remove();

                const el = document.createElement("div");
                el.style.cssText = [
                  "width:18px;height:18px;border-radius:50%;",
                  "background:#3b82f6;border:2.5px solid white;",
                  "box-shadow:0 0 0 4px rgba(59,130,246,0.25);",
                  "animation:locationPulse 2s ease-in-out infinite;",
                ].join("");

                locationMarkerRef.current = new maplibregl.Marker({ element: el })
                  .setLngLat([lng, lat])
                  .addTo(map);

                map.easeTo({ center: [lng, lat], duration: 600 });
              });
            },
            () => setLocating(false),
            { enableHighAccuracy: true, timeout: 8000 },
          );
        }}
        className="absolute top-[6.25rem] left-3 z-[500] w-9 h-9 bg-white/90 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-lg shadow-zinc-200/40 flex items-center justify-center active:scale-95 transition-all"
        title="Meinen Standort anzeigen"
      >
        {locating ? (
          <div className="w-4 h-4 border-[1.5px] border-blue-400 border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            <circle cx="12" cy="12" r="8" strokeOpacity="0.3" />
          </svg>
        )}
      </button>

      {/* Legend + compass stacked bottom-left */}
      <div className="absolute z-[500] flex flex-col gap-2 items-start" style={{ bottom: "24px", left: "12px" }}>
        <SunCompass
          timeState={timeState}
          onNorth={() => mapInstanceRef.current?.easeTo({ bearing: 0, duration: 600 })}
        />
        <Legend />
      </div>
      <SunInfoOverlay timeState={timeState} />
    </div>
  );
}

// ─── legend ───────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div className="bg-white/90 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-lg shadow-zinc-200/40 p-3">
      <div className="text-zinc-400 font-body uppercase tracking-widest mb-2" style={{ fontSize: "8px", fontWeight: 700, letterSpacing: "0.1em" }}>
        Legende
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <div style={{ width: 12, height: 12, borderRadius: 4, background: "#fde68a", border: "1.5px solid #f59e0b" }} />
        <span className="font-body text-zinc-600" style={{ fontSize: "11px" }}>Sonnig</span>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <div style={{ width: 12, height: 12, borderRadius: 4, background: "#334155", opacity: 0.65 }} />
        <span className="font-body text-zinc-600" style={{ fontSize: "11px" }}>Schatten</span>
      </div>
      <div className="flex items-center gap-2 mb-1.5">
        <div style={{ width: 12, height: 12, borderRadius: 4, background: "#e2e8f0", border: "1.5px solid #cbd5e1" }} />
        <span className="font-body text-zinc-600" style={{ fontSize: "11px" }}>Gebäude</span>
      </div>
      <div className="flex items-center gap-2">
        <div style={{ width: 12, height: 12, borderRadius: 4, background: "#86efac" }} />
        <span className="font-body text-zinc-600" style={{ fontSize: "11px" }}>Grünfläche</span>
      </div>
    </div>
  );
}

// ─── sun compass ──────────────────────────────────────────────────────────────
function SunCompass({ timeState, onNorth }: { timeState: TimeState; onNorth?: () => void }) {
  const date = new Date(`${timeState.date}T${timeState.time}:00`);
  const pos  = getSunPosition(NEUBAU_CENTER[0], NEUBAU_CENTER[1], date);
  const isUp = pos.altitudeDeg > 0;

  const size         = 52;
  const r            = size / 2;
  const pad          = 10;
  const innerR       = r - pad;
  const distFraction = isUp ? Math.max(0, 1 - pos.altitudeDeg / 90) : 1.0;
  const azRad        = (pos.azimuthDeg * Math.PI) / 180;
  const sx           = r + distFraction * innerR * Math.sin(azRad);
  const sy           = r - distFraction * innerR * Math.cos(azRad);

  return (
    <div
      onClick={onNorth}
      className="bg-white/90 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-lg shadow-zinc-200/40 p-2 inline-flex cursor-pointer hover:border-zinc-200 active:scale-95 transition-transform"
      title="Karte nach Norden ausrichten"
    >
      <svg width={size} height={size}>
        <defs>
          <radialGradient id="skyGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#bfdbfe" />
            <stop offset="100%" stopColor="#dbeafe" />
          </radialGradient>
        </defs>
        <circle cx={r} cy={r} r={innerR} fill="url(#skyGrad)" stroke="#93c5fd" strokeWidth="1" />
        <circle cx={r} cy={r} r={innerR * 0.67} fill="none" stroke="#93c5fd" strokeWidth="0.5" strokeDasharray="3,3" />
        <line x1={r} y1={pad / 2} x2={r} y2={size - pad / 2} stroke="#bfdbfe" strokeWidth="0.5" />
        <line x1={pad / 2} y1={r} x2={size - pad / 2} y2={r} stroke="#bfdbfe" strokeWidth="0.5" />
        <text x={r} y={5}          textAnchor="middle" fontSize="5" fill="#64748b" fontFamily="Figtree, sans-serif" fontWeight="600">N</text>
        <text x={r} y={size - 1}   textAnchor="middle" fontSize="5" fill="#64748b" fontFamily="Figtree, sans-serif" fontWeight="600">S</text>
        <text x={3}          y={r + 2} textAnchor="middle" fontSize="5" fill="#64748b" fontFamily="Figtree, sans-serif" fontWeight="600">W</text>
        <text x={size - 3}   y={r + 2} textAnchor="middle" fontSize="5" fill="#64748b" fontFamily="Figtree, sans-serif" fontWeight="600">O</text>
        {isUp ? (
          <>
            <circle cx={sx} cy={sy} r={5} fill="#fde68a" opacity="0.5" />
            <circle cx={sx} cy={sy} r={3} fill="#fbbf24" stroke="#f59e0b" strokeWidth="1" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
              const rad = (angle * Math.PI) / 180;
              return (
                <line
                  key={angle}
                  x1={sx + 4 * Math.cos(rad)} y1={sy + 4 * Math.sin(rad)}
                  x2={sx + 6 * Math.cos(rad)} y2={sy + 6 * Math.sin(rad)}
                  stroke="#f59e0b" strokeWidth="1" strokeLinecap="round"
                />
              );
            })}
          </>
        ) : (
          <text x={r} y={r + 5} textAnchor="middle" fontSize="16" fill="#94a3b8">🌙</text>
        )}
      </svg>
    </div>
  );
}

// ─── sun info ─────────────────────────────────────────────────────────────────
function SunInfoOverlay({ timeState }: { timeState: TimeState }) {
  const date  = new Date(`${timeState.date}T${timeState.time}:00`);
  const times = getSunTimes(NEUBAU_CENTER[0], NEUBAU_CENTER[1], date);
  const fmt   = (d: Date) => d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="absolute top-3 right-3 z-[500] bg-white/80 backdrop-blur-xl rounded-2xl border border-zinc-100 shadow-lg shadow-zinc-200/30 px-3.5 py-2">
      <div className="flex items-center gap-2.5 font-body text-zinc-500" style={{ fontSize: "12px" }}>
        <span>🌅 {fmt(times.sunrise)}</span>
        <span className="text-zinc-200">·</span>
        <span>🌇 {fmt(times.sunset)}</span>
      </div>
    </div>
  );
}
