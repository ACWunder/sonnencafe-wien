// src/components/MapView.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Cafe, TimeState, SunTimelineData } from "@/types";
import { getSunPosition } from "@/lib/sun";
import { calcShadowPolygon } from "@/lib/buildingShadow";
import { DISTRICT_BOUNDS, MAP_CENTER } from "@/lib/mapConfig";
import type { BuildingFeature } from "@/app/api/buildings/route";

// ─── spatial grid index ───────────────────────────────────────────────────────
// Buckets buildings into ~440m cells so nearby lookups are O(1) instead of O(n).

const GRID_CELL = 0.004; // ~0.004° ≈ 440m per cell; shadow radius is ~200m

class BuildingGrid {
  private cells = new Map<string, BuildingFeature[]>();

  constructor(buildings: BuildingFeature[]) {
    for (const b of buildings) {
      const key = BuildingGrid.key(b.polygon[0][0], b.polygon[0][1]);
      let cell = this.cells.get(key);
      if (!cell) { cell = []; this.cells.set(key, cell); }
      cell.push(b);
    }
  }

  private static key(lat: number, lng: number): string {
    return `${Math.floor(lat / GRID_CELL)},${Math.floor(lng / GRID_CELL)}`;
  }

  getNearby(lat: number, lng: number): BuildingFeature[] {
    const result: BuildingFeature[] = [];
    const row = Math.floor(lat / GRID_CELL);
    const col = Math.floor(lng / GRID_CELL);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const bs = this.cells.get(`${row + dr},${col + dc}`);
        if (bs) result.push(...bs);
      }
    }
    return result;
  }
}

// ─── constants ────────────────────────────────────────────────────────────────

const NEUBAU_CENTER = MAP_CENTER;
const FALLBACK_HEIGHT = 18;

// OpenFreeMap bright — free, no API key, Google-Maps-like colours
const MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";

// Shadow canvas: pre-rendered at a fixed resolution and fed to MapLibre as
// a raster image source. A single ctx.fill() call on the full path produces
// the union of all shadow polygons — overlapping areas are filled only once
// so opacity never accumulates even where building shadows stack.
//
// Zoom-16 resolution so the canvas matches 1:1 at the most common viewing zoom,
// giving crisp 1-pixel shadow edges. Combined with raster-resampling:"nearest"
// on the raster layer this eliminates all bilinear blur.
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

export interface MapViewShadowHandle {
  updateShadow: (ts: TimeState) => void;
}

interface MapViewProps {
  timeState: TimeState;
  cafes: Cafe[];
  sunRemaining: Record<string, number | null>;
  selectedCafe: Cafe | null;
  onCafeSelect: (cafe: Cafe | null) => void;
  onSunRemaining: (data: Record<string, number | null>) => void;
  onSunTimeline: (data: SunTimelineData) => void;
  onSunDataSettled?: () => void;
  // Ref populated by MapView so callers can trigger shadow updates without
  // going through React state (removes one full render-cycle of latency).
  shadowHandleRef?: React.MutableRefObject<MapViewShadowHandle | null>;
  // Optional: subset of cafe IDs to show markers for (undefined = show all)
  visibleCafeIds?: Set<string>;
}

// Sun computation has moved to src/workers/sun.worker.ts.
// MapView dispatches compute jobs via postMessage; results come back via onmessage.

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
// Approximate polygon area in m² using shoelace formula (equirectangular)
function polygonAreaM2(polygon: [number, number][]): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j][1] + polygon[i][1]) * (polygon[j][0] - polygon[i][0]);
  }
  // At lat ~48.2: 1° lat ≈ 111 000 m, 1° lng ≈ 74 000 m
  return (Math.abs(area) / 2) * 111_000 * 74_000;
}

function polygonToGeoJSON(polygon: [number, number][]): number[][] {
  const ring = polygon.map(([lat, lng]) => [lng, lat]);
  if (ring.length > 0 &&
      (ring[0][0] !== ring[ring.length - 1][0] ||
       ring[0][1] !== ring[ring.length - 1][1])) {
    ring.push(ring[0]);
  }
  return ring;
}

// Load Twemoji sun PNG and add as map image; calls onReady when done.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSunEmoji(map: any, onReady: () => void) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => { map.addImage("cafe-sunny", img); onReady(); };
  img.onerror = () => {
    // Fallback: plain orange circle
    const c = document.createElement("canvas"); c.width = 40; c.height = 40;
    const ctx = c.getContext("2d")!;
    ctx.beginPath(); ctx.arc(20, 20, 18, 0, Math.PI * 2);
    ctx.fillStyle = "#f59e0b"; ctx.fill();
    map.addImage("cafe-sunny", ctx.getImageData(0, 0, 40, 40), { pixelRatio: 2 });
    onReady();
  };
  img.src = "/sun-emoji.png";
}

// ─── component ────────────────────────────────────────────────────────────────

export function MapView({
  timeState, cafes, sunRemaining, selectedCafe, onCafeSelect, onSunRemaining, onSunTimeline, onSunDataSettled, shadowHandleRef, visibleCafeIds,
}: MapViewProps) {
  const mapRef         = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  const mapReadyRef    = useRef(false);  // true once map 'load' event fired

  const shadowCanvasRef   = useRef<HTMLCanvasElement | null>(null);
  const buildingCacheRef  = useRef<Map<number, BuildingFeature>>(new Map());
  const buildingGridRef   = useRef<BuildingGrid | null>(null);
  const shadowWorkerRef   = useRef<Worker | null>(null);
  const shadowRenderInFlightRef = useRef(false);
  const pendingShadowTimeRef = useRef<TimeState | null>(null);
  const sunDataTimeoutRef = useRef<number | null>(null);

  const selectFromMapRef  = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locationMarkerRef = useRef<any>(null);

  // Stable refs so event handlers always see current prop values
  const cafesRef          = useRef<Cafe[]>(cafes);
  cafesRef.current        = cafes;
  const sunRemainingRef   = useRef<Record<string, number | null>>(sunRemaining);
  sunRemainingRef.current = sunRemaining;
  const selectedCafeRef   = useRef<Cafe | null>(selectedCafe);
  selectedCafeRef.current = selectedCafe;
  const onCafeSelectRef   = useRef(onCafeSelect);
  onCafeSelectRef.current = onCafeSelect;
  const onSunRemainingRef = useRef(onSunRemaining);
  onSunRemainingRef.current = onSunRemaining;
  const onSunTimelineRef  = useRef(onSunTimeline);
  onSunTimelineRef.current = onSunTimeline;
  const onSunDataSettledRef = useRef(onSunDataSettled);
  onSunDataSettledRef.current = onSunDataSettled;
  const timeStateRef      = useRef(timeState);
  timeStateRef.current    = timeState;
  // Cache: cafe id → inShadow, so selection changes don't recompute shadows
  const shadowCacheRef       = useRef<Map<string, boolean>>(new Map());
  const visibleCafeIdsRef    = useRef<Set<string> | undefined>(visibleCafeIds);
  visibleCafeIdsRef.current  = visibleCafeIds;

  // Sun computation worker — runs calcSunRemaining + calcDayTimeline off-thread.
  // Pend-drop pattern: only one compute in flight; latest pending dispatched when done.
  const sunWorkerRef           = useRef<Worker | null>(null);
  const sunComputeInFlightRef  = useRef(false);
  const pendingSunComputeRef   = useRef<{ cafes: Cafe[]; date: string; time: string } | null>(null);
  const pendingBackgroundRef   = useRef<{ cafes: Cafe[]; date: string; time: string } | null>(null);
  const isBackgroundComputeRef = useRef(false);

  const [, setFetching]  = useState(false);

  // Internal ref always pointing to the latest shadow-update closure.
  // Populated each render (functions are hoisted so updateShadowSource is
  // already in scope). Exposed via shadowHandleRef so callers can bypass
  // the React re-render cycle for instant slider response.
  const shadowUpdateFnRef = useRef<((ts: TimeState) => void) | null>(null);
  shadowUpdateFnRef.current = (ts: TimeState) => {
    if (shadowWorkerRef.current) {
      // Worker path ignores allBuildings — skip Array.from to avoid main-thread allocation
      updateShadowSource([], ts);
    } else {
      const all = Array.from(buildingCacheRef.current.values());
      if (all.length > 0) updateShadowSource(all, ts);
    }
  };
  if (shadowHandleRef) {
    shadowHandleRef.current = { updateShadow: shadowUpdateFnRef.current };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  function clearScheduledSunData() {
    if (sunDataTimeoutRef.current !== null) {
      window.clearTimeout(sunDataTimeoutRef.current);
      sunDataTimeoutRef.current = null;
    }
  }

  function scheduleSunDataRefresh(delay = 500) {
    clearScheduledSunData();
    sunDataTimeoutRef.current = window.setTimeout(() => {
      sunDataTimeoutRef.current = null;
      updateCafesSource(true);
    }, delay);
  }

  // Dispatch a sun-compute job to the worker using pend-drop.
  // If a computation is already in flight, the new request is queued; once
  // the current one finishes the latest queued request is sent (stale ones dropped).
  function dispatchSunCompute(cafes: Cafe[], date: string, time: string) {
    const worker = sunWorkerRef.current;
    if (!worker) return;
    pendingSunComputeRef.current = { cafes, date, time };
    if (!sunComputeInFlightRef.current) {
      const next = pendingSunComputeRef.current;
      pendingSunComputeRef.current = null;
      if (next) {
        sunComputeInFlightRef.current = true;
        worker.postMessage({ type: "compute", cafes: next.cafes, date: next.date, time: next.time });
      }
    }
  }

  function dispatchShadowRender(ts: TimeState) {
    const worker = shadowWorkerRef.current;
    const canvas = shadowCanvasRef.current;
    if (!worker || !canvas) return;

    shadowRenderInFlightRef.current = true;
    worker.postMessage({
      type: "render",
      timeState: ts,
      bounds: DISTRICT_BOUNDS,
      width: canvas.width,
      height: canvas.height,
    });
  }

  // Push updated café GeoJSON to the map source.
  // recomputeSunData = true  → kick off sun-remaining/timeline computation.
  // incrementalOnly = true   → only compute cafés not yet in sunRemainingRef
  //                            (used when the visible set grows, not when time changes).
  function updateCafesSource(recomputeSunData = true, incrementalOnly = false) {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;
    const source = map.getSource("cafes-source");
    if (!source) return;

    const selId     = selectedCafeRef.current?.id ?? null;
    const visibleIds = visibleCafeIdsRef.current;
    const visibleCafes = cafesRef.current.filter((c) => !visibleIds || visibleIds.has(c.id));
    const features = visibleCafes.map((cafe) => {
      const inShadow = Object.prototype.hasOwnProperty.call(sunRemainingRef.current, cafe.id)
        ? sunRemainingRef.current[cafe.id] === null
        : (shadowCacheRef.current.get(cafe.id) ?? true);

      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [cafe.lng, cafe.lat] },
        properties: { id: cafe.id, name: cafe.name, inShadow, isSelected: cafe.id === selId },
      };
    });

    source.setData({ type: "FeatureCollection", features });

    if (!recomputeSunData) return;

    // Dispatch to background worker — no main-thread computation, no idle scheduling.
    const ts = timeStateRef.current;
    // Phase 1: visible cafés → fast update for map + spinner.
    // Phase 2 (background): remaining cafés → fills sidebar/search results.
    const cafesToCompute = incrementalOnly
      ? visibleCafes.filter((c) => !Object.prototype.hasOwnProperty.call(sunRemainingRef.current, c.id))
      : visibleCafes;

    if (!incrementalOnly) {
      const visibleIds = new Set(visibleCafes.map((c) => c.id));
      const bgCafes = cafesRef.current.filter((c) => !visibleIds.has(c.id));
      pendingBackgroundRef.current = bgCafes.length > 0
        ? { cafes: bgCafes, date: ts.date, time: ts.time }
        : null;
    }

    if (cafesToCompute.length === 0) {
      onSunDataSettledRef.current?.();
      // Still kick off background batch if any
      const bg = pendingBackgroundRef.current;
      if (bg) {
        pendingBackgroundRef.current = null;
        isBackgroundComputeRef.current = true;
        dispatchSunCompute(bg.cafes, bg.date, bg.time);
      }
      return;
    }

    isBackgroundComputeRef.current = false;
    dispatchSunCompute(cafesToCompute, ts.date, ts.time);
  }

  // Render shadow canvas and push it to the MapLibre image source.
  function updateShadowSource(allBuildings: BuildingFeature[], ts: TimeState) {
    const canvas = shadowCanvasRef.current;
    const map    = mapInstanceRef.current;
    if (!canvas || !map || !mapReadyRef.current) return;

    if (shadowWorkerRef.current) {
      // Keep at most one render in flight; if the slider moves again, only the
      // most recent time is rendered next instead of queueing stale frames.
      pendingShadowTimeRef.current = ts;
      if (!shadowRenderInFlightRef.current) {
        const nextTime = pendingShadowTimeRef.current;
        pendingShadowTimeRef.current = null;
        if (nextTime) dispatchShadowRender(nextTime);
      }
      return;
    }

    // Fallback: render synchronously on main thread
    renderShadowCanvas(canvas, allBuildings, ts);
    map.triggerRepaint();
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
        buildingGridRef.current = new BuildingGrid(buildings);
        shadowWorkerRef.current?.postMessage({ type: "init", buildings });
        sunWorkerRef.current?.postMessage({ type: "init", buildings });

        const map = mapInstanceRef.current;
        if (!map || !mapReadyRef.current) return;

        // Push building polygons to the GeoJSON source.
        // Filter out tiny footprints (< 80 m²) so small courtyards / sheds
        // don't appear as gaps inside building blocks.
        // Shadow computation still uses the full buildingCacheRef.
        const source = map.getSource("buildings-source");
        if (source) {
          source.setData({
            type: "FeatureCollection",
            features: buildings
              .filter((b) => polygonAreaM2(b.polygon as [number, number][]) >= 80)
              .map((b) => ({
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

    // Create shadow worker
    const worker = typeof window !== "undefined"
      ? new Worker(new URL("../workers/shadow.worker.ts", import.meta.url))
      : null;
    shadowWorkerRef.current = worker;

    if (worker) {
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.type !== "rendered") return;
        const bitmap: ImageBitmap = e.data.bitmap;
        const canvas = shadowCanvasRef.current;
        const map = mapInstanceRef.current;
        if (!canvas || !map || !mapReadyRef.current) { bitmap.close(); return; }
        const ctx = canvas.getContext("2d");
        if (!ctx) { bitmap.close(); return; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        map.triggerRepaint();

        shadowRenderInFlightRef.current = false;
        const nextTime = pendingShadowTimeRef.current;
        pendingShadowTimeRef.current = null;
        if (nextTime) {
          dispatchShadowRender(nextTime);
        }
      };
    }

    // Create sun computation worker
    const sunWorker = typeof window !== "undefined"
      ? new Worker(new URL("../workers/sun.worker.ts", import.meta.url))
      : null;
    sunWorkerRef.current = sunWorker;

    if (sunWorker) {
      sunWorker.onmessage = (e: MessageEvent) => {
        if (e.data.type !== "computed") return;
        sunComputeInFlightRef.current = false;

        const { remaining, timelines } = e.data as {
          remaining: Record<string, number | null>;
          timelines: import("@/types").SunTimelineData;
        };

        onSunRemainingRef.current(remaining);
        onSunTimelineRef.current(timelines);
        for (const [id, val] of Object.entries(remaining))
          shadowCacheRef.current.set(id, val === null);

        // Rebuild map source with accurate shadow state
        const map = mapInstanceRef.current;
        const src  = map?.getSource("cafes-source");
        if (src && mapReadyRef.current) {
          const selId     = selectedCafeRef.current?.id ?? null;
          const visIds    = visibleCafeIdsRef.current;
          const allCafes  = cafesRef.current.filter((c) => !visIds || visIds.has(c.id));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (src as any).setData({
            type: "FeatureCollection",
            features: allCafes.map((cafe) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [cafe.lng, cafe.lat] },
              properties: {
                id: cafe.id, name: cafe.name,
                inShadow: shadowCacheRef.current.get(cafe.id) ?? true,
                isSelected: cafe.id === selId,
              },
            })),
          });
        }
        const wasBackground = isBackgroundComputeRef.current;
        isBackgroundComputeRef.current = false;

        if (!wasBackground) {
          // Wait for MapLibre to fully process setData (async in its internal worker)
          // and render the updated dots before hiding the spinner.
          // 'idle' fires after all pending source updates and renders are settled.
          const m = mapInstanceRef.current;
          if (m) {
            m.once("idle", () => onSunDataSettledRef.current?.());
          } else {
            onSunDataSettledRef.current?.();
          }
        }

        // Drain pending (time-change) request first; if none, run background batch
        const next = pendingSunComputeRef.current;
        pendingSunComputeRef.current = null;
        if (next) {
          pendingBackgroundRef.current = null; // stale background, discard
          sunComputeInFlightRef.current = true;
          sunWorker.postMessage({ type: "compute", cafes: next.cafes, date: next.date, time: next.time });
        } else {
          const bg = pendingBackgroundRef.current;
          if (bg) {
            pendingBackgroundRef.current = null;
            isBackgroundComputeRef.current = true;
            sunComputeInFlightRef.current = true;
            sunWorker.postMessage({ type: "compute", cafes: bg.cafes, date: bg.date, time: bg.time });
          }
        }
      };
    }

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

        // Café dots are inserted before the place/district label layer so they
        // render above road names but below Viertel/suburb labels.
        const beforePlace = map.getLayer("label_other") ? "label_other" : before;

        // ── hide POI layers ────────────────────────────────────────────────
        // Hide all shop/restaurant/icon POI layers – keep only road & place labels.
        map.getStyle().layers.forEach((l: { id: string; type: string; "source-layer"?: string }) => {
          if (l["source-layer"] === "poi") {
            map.setLayoutProperty(l.id, "visibility", "none");
          }
        });

        // ── filter place labels ────────────────────────────────────────────
        // Hide neighbourhood/quarter labels (Grätzl names) – keep suburb/Bezirke.
        if (map.getLayer("label_other")) {
          map.setFilter("label_other", [
            "match", ["get", "class"],
            ["city", "continent", "country", "hamlet", "isolated_dwelling",
             "neighbourhood", "quarter", "state", "town", "village"],
            false,
            true,
          ]);
        }

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
          type: "canvas",
          canvas: shadowCanvas,
          animate: true,
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
          paint: { "fill-color": "#aad3a0", "fill-opacity": 0.55 },
        }, before);

        map.addLayer({
          id: "sunny-overlay",
          type: "fill",
          source: "sunny-overlay-source",
          paint: { "fill-color": "#fde68a", "fill-opacity": 0.25 },
        }, before);

        // Raster shadow layer — opacity here is the only transparency applied;
        // the canvas itself is fully opaque dark pixels on transparent background.
        // raster-resampling: nearest prevents bilinear blur when zoomed in past
        // the canvas resolution, keeping shadow edges crisp at all zoom levels.
        map.addLayer({
          id: "shadows",
          type: "raster",
          source: "shadow-source",
          paint: {
            "raster-opacity": 0.55,
            // "linear" (default) preserves the canvas's own sub-pixel anti-aliasing
            // exactly at zoom 16 (1:1 canvas-to-screen) — smooth edges, no staircase.
            // "nearest" was crisp but showed pixel steps on diagonal edges.
            "raster-resampling": "linear",
          },
        }, before);

        map.addLayer({
          id: "buildings-fill",
          type: "fill",
          source: "buildings-source",
          paint: { "fill-color": "#f0ebe3", "fill-opacity": 1.0 },
        }, before);

        map.addLayer({
          id: "buildings-outline",
          type: "line",
          source: "buildings-source",
          paint: { "line-color": "#c9beaf", "line-width": 0.7 },
        }, before);

        // Shade cafés (non-selected) — circle layer below sunny layer
        map.addLayer({
          id: "cafes",
          type: "circle",
          source: "cafes-source",
          filter: ["all", ["==", ["get", "inShadow"], true], ["==", ["get", "isSelected"], false]],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 5, 16, 6, 17, 7],
            "circle-color": "#374151",
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#ffffff",
          },
        }, beforePlace);

        // Sunny cafés (non-selected) + selected cafés on top — emoji loaded once
        loadSunEmoji(map, () => {
          if (!mapReadyRef.current) return;
          // Non-selected sunny cafés
          map.addLayer({
            id: "cafes-sunny",
            type: "symbol",
            source: "cafes-source",
            filter: ["all", ["==", ["get", "inShadow"], false], ["==", ["get", "isSelected"], false]],
            layout: {
              "icon-image": "cafe-sunny",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.13, 14, 0.17, 16, 0.22, 18, 0.26],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-anchor": "center",
            },
          }, beforePlace);

          // Selected shady café — rendered above all others
          map.addLayer({
            id: "cafes-selected-shadow",
            type: "circle",
            source: "cafes-source",
            filter: ["all", ["==", ["get", "inShadow"], true], ["==", ["get", "isSelected"], true]],
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 8, 16, 10, 17, 11],
              "circle-color": "#374151",
              "circle-stroke-width": 2.5,
              "circle-stroke-color": "#ffffff",
              "circle-radius-transition": { duration: 220, delay: 0 },
            },
          }, beforePlace);

          // Selected sunny café — rendered above all others
          map.addLayer({
            id: "cafes-selected-sunny",
            type: "symbol",
            source: "cafes-source",
            filter: ["all", ["==", ["get", "inShadow"], false], ["==", ["get", "isSelected"], true]],
            layout: {
              "icon-image": "cafe-sunny",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.19, 14, 0.25, 16, 0.31, 18, 0.38],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-anchor": "center",
            },
          }, beforePlace);
        });

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
        }, beforePlace);

        // ── interactions ──────────────────────────────────────────────────

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.on("click", "cafes-hit", (e: any) => {
          if (!e.features?.length) return;
          const id = e.features[0].properties?.id;
          const cafe = cafesRef.current.find((c) => c.id === id);
          if (cafe) {
            e.originalEvent.stopPropagation();
            selectFromMapRef.current = true;
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
      shadowRenderInFlightRef.current = false;
      pendingShadowTimeRef.current = null;
      shadowWorkerRef.current?.terminate();
      shadowWorkerRef.current = null;
      sunWorkerRef.current?.terminate();
      sunWorkerRef.current = null;
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
    scheduleSunDataRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeState]);

  // ── redraw when café list changes ─────────────────────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    // Only compute sun data if buildings are already loaded. If not,
    // loadStaticBuildings() will call updateCafesSource(true) once ready,
    // preventing onSunDataSettled from firing before we have real building data.
    const buildingsReady = buildingCacheRef.current.size > 0;
    updateCafesSource(buildingsReady);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cafes]);

  // ── redraw dots when selection changes ────────────────────────────────────
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateCafesSource(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCafe]);

  // ── visibility filter changed: update visible markers immediately, then
  // only compute sun data for newly-visible cafés (incremental).
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateCafesSource(false);

    const rafId = requestAnimationFrame(() => {
      setTimeout(() => {
        if (!mapInstanceRef.current || !mapReadyRef.current) return;
        updateCafesSource(true, true); // incremental: skip already-computed cafés
      }, 120);
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCafeIds]);

  useEffect(() => clearScheduledSunData, []);

  // ── pan/zoom to selected café ─────────────────────────────────────────────
  // List selection zooms to 17; map click keeps current zoom.
  useEffect(() => {
    if (!selectedCafe || !mapInstanceRef.current) return;
    const fromMap = selectFromMapRef.current;
    selectFromMapRef.current = false;
    mapInstanceRef.current.easeTo({
      center: [selectedCafe.lng, selectedCafe.lat],
      zoom: fromMap ? mapInstanceRef.current.getZoom() : 15,
      duration: 500,
    });
  }, [selectedCafe]);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full relative">
      <div ref={mapRef} className="w-full h-full" />


      {/* Compass + locate button stacked — bottom right */}
      <div className="absolute z-[500] flex flex-col gap-3 items-end" style={{ bottom: "24px", right: "16px" }}>
        <button
          onClick={() => {
            if (!mapInstanceRef.current) return;
            navigator.geolocation.getCurrentPosition(
              (pos) => {
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
              () => {},
              { enableHighAccuracy: true, timeout: 8000 },
            );
          }}
          className="w-[56px] h-[56px] bg-white rounded-full shadow-xl shadow-zinc-300/40 border border-zinc-100 flex items-center justify-center"
          style={{ marginRight: "5px" }}
          title="Meinen Standort anzeigen"
        >
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M21 3L3 10.53v.98l6.84 2.65L12.48 21h.98L21 3z" fill="#4285f4"/>
          </svg>
        </button>
        <SunCompass
          timeState={timeState}
          onNorth={() => mapInstanceRef.current?.easeTo({ bearing: 0, duration: 600 })}
        />
      </div>
    </div>
  );
}

// ─── sun compass ──────────────────────────────────────────────────────────────
function SunCompass({ timeState, onNorth }: { timeState: TimeState; onNorth?: () => void }) {
  const date = new Date(`${timeState.date}T${timeState.time}:00`);
  const pos  = getSunPosition(NEUBAU_CENTER[0], NEUBAU_CENTER[1], date);
  const isUp = pos.altitudeDeg > 0;

  const size         = 76;
  const r            = size / 2;
  const pad          = 13;
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
