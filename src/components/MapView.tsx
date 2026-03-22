// src/components/MapView.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Cafe, TimeState, SunTimelineData } from "@/types";
import { getSunPosition } from "@/lib/sun";
import { calcShadowPolygon } from "@/lib/buildingShadow";
import { VIENNA_BOUNDS, MAP_CENTER, MIN_MARKER_ZOOM, MIN_BUILDING_ZOOM, TILE_LAT, TILE_LNG, MAX_TILE_CACHE } from "@/lib/mapConfig";
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

// Shadow canvas: fixed 2048×2048 px offscreen canvas whose geographic extent
// follows the current viewport + a 50% buffer. Dynamic bounds are passed to the
// shadow worker per render; the MapLibre canvas source coordinates are updated
// after each render so the raster image maps to the right geo area.
const SHADOW_CANVAS_SIZE = 2048;

const EMPTY_FEATURE_COLLECTION: { type: "FeatureCollection"; features: never[] } = {
  type: "FeatureCollection",
  features: [],
};

// ─── types ────────────────────────────────────────────────────────────────────

export interface MapViewShadowHandle {
  updateShadow: (ts: TimeState) => void;
  startLiveLocation: () => void;
}

interface LiveLocationState {
  lat: number;
  lng: number;
  accuracy: number;
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
  onUserLocationChange?: (location: { lat: number; lng: number } | null) => void;
  // Called when a visible-cafe sun computation is about to start (use to show spinner)
  onSunComputeStarted?: () => void;
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
  bounds: { north: number; south: number; east: number; west: number },
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

  const bW = bounds.east - bounds.west;
  const bH = bounds.north - bounds.south;

  ctx.beginPath();
  for (const b of allBuildings) {
    const shadow = calcShadowPolygon(
      b.polygon, b.height ?? FALLBACK_HEIGHT,
      sunPos.altitudeDeg, sunPos.azimuthDeg,
    );
    if (shadow.length < 3) continue;
    let first = true;
    for (const [lat, lng] of shadow as [number, number][]) {
      const x = (lng - bounds.west) / bW * canvas.width;
      const y = (bounds.north - lat) / bH * canvas.height;
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

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function bearingDegrees(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const dLng = toRad(bLng - aLng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function makeAccuracyCircle(lng: number, lat: number, radiusM: number) {
  const steps = 48;
  const latRadius = radiusM / 111_320;
  const lngRadius = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: number[][] = [];

  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    ring.push([
      lng + lngRadius * Math.cos(angle),
      lat + latRadius * Math.sin(angle),
    ]);
  }

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {},
    }],
  } as const;
}

function createLocationPuck() {
  const root = document.createElement("div");
  root.style.cssText = [
    "position:relative",
    "width:18px",
    "height:18px",
    "pointer-events:none",
  ].join(";");

  const pulse = document.createElement("div");
  pulse.style.cssText = [
    "width:18px",
    "height:18px",
    "border-radius:9999px",
    "background:#4285f4",
    "border:2.5px solid rgba(255,255,255,0.96)",
    "box-shadow:0 0 0 4px rgba(66,133,244,0.25)",
    "animation:locationPulse 2s ease-in-out infinite",
  ].join(";");
  root.appendChild(pulse);

  return { root };
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadMoonEmoji(map: any) {
  if (map.hasImage("cafe-shady")) return;
  const canvas = document.createElement("canvas");
  canvas.width = 56;
  canvas.height = 56;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = '40px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.fillText("🌑", 28, 30);
  map.addImage("cafe-shady", ctx.getImageData(0, 0, 56, 56), { pixelRatio: 2 });
}

// ─── component ────────────────────────────────────────────────────────────────

export function MapView({
  timeState, cafes, sunRemaining, selectedCafe, onCafeSelect, onSunRemaining, onSunTimeline, onSunDataSettled, shadowHandleRef, visibleCafeIds, onUserLocationChange, onSunComputeStarted,
}: MapViewProps) {
  const mapRef         = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maplibreRef    = useRef<any>(null);
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
  const locationWatchIdRef = useRef<number | null>(null);
  const locationStateRef = useRef<LiveLocationState | null>(null);
  const centerOnNextLocationRef = useRef(false);
  const [isTrackingLocation, setIsTrackingLocation] = useState(false);

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
  const onSunComputeStartedRef = useRef(onSunComputeStarted);
  onSunComputeStartedRef.current = onSunComputeStarted;
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

  // Viewport-based shadow bounds — updated on every render dispatch
  type Bounds = { north: number; south: number; east: number; west: number };
  const shadowBoundsRef       = useRef<Bounds | null>(null);
  const shadowRenderBoundsRef = useRef<Bounds | null>(null); // bounds used for in-flight render

  // Tile LRU cache
  const loadedTilesRef   = useRef<Set<string>>(new Set());          // tile keys fetched or in-flight
  const tileBuildingsRef = useRef<Map<string, BuildingFeature[]>>(new Map()); // key → buildings
  const tileOrderRef     = useRef<string[]>([]);                      // LRU order (oldest first)
  const tileLoadTimerRef = useRef<number | null>(null);               // debounce tile loading on moveend

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
    shadowHandleRef.current = {
      updateShadow: shadowUpdateFnRef.current,
      startLiveLocation: startLiveLocationTracking,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  // Viewport bounds + percentage buffer, clamped to Vienna's outer envelope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getViewportBounds(map: any, bufferFraction = 0.5) {
    const b = map.getBounds();
    const n = b.getNorth(), s = b.getSouth();
    const e = b.getEast(),  w = b.getWest();
    const dLat = (n - s) * bufferFraction;
    const dLng = (e - w) * bufferFraction;
    return {
      north: Math.min(n + dLat, 48.42),
      south: Math.max(s - dLat, 48.05),
      east:  Math.min(e + dLng, 16.78),
      west:  Math.max(w - dLng, 16.08),
    };
  }

  // Return all tile keys that overlap the given bounds.
  function getTilesForBounds(bounds: { north: number; south: number; east: number; west: number }): string[] {
    const keys: string[] = [];
    const r0 = Math.floor(bounds.south / TILE_LAT);
    const r1 = Math.floor(bounds.north / TILE_LAT);
    const c0 = Math.floor(bounds.west  / TILE_LNG);
    const c1 = Math.floor(bounds.east  / TILE_LNG);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        keys.push(`${r},${c}`);
    return keys;
  }

  // Geographic bbox for a tile key (with a small overlap to catch edge buildings).
  function tileBoundsForKey(key: string) {
    const [r, c] = key.split(",").map(Number);
    return {
      south: r * TILE_LAT - 0.001,
      north: (r + 1) * TILE_LAT + 0.001,
      west:  c * TILE_LNG - 0.001,
      east:  (c + 1) * TILE_LNG + 0.001,
    };
  }

  // Move a tile to the "most recently used" end of the LRU list.
  function touchTile(key: string) {
    const idx = tileOrderRef.current.indexOf(key);
    if (idx !== -1) tileOrderRef.current.splice(idx, 1);
    tileOrderRef.current.push(key);
  }

  // Evict the least-recently-used tiles until we're under the cache limit.
  function evictLruTiles() {
    while (tileOrderRef.current.length > MAX_TILE_CACHE) {
      const evictKey = tileOrderRef.current.shift()!;
      const evicted  = tileBuildingsRef.current.get(evictKey);
      if (evicted) for (const b of evicted) buildingCacheRef.current.delete(b.id);
      tileBuildingsRef.current.delete(evictKey);
      loadedTilesRef.current.delete(evictKey);
    }
  }

  function clearScheduledSunData() {
    if (sunDataTimeoutRef.current !== null) {
      window.clearTimeout(sunDataTimeoutRef.current);
      sunDataTimeoutRef.current = null;
    }
  }

  function scheduleSunDataRefresh(delay = 100) {
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
    const map    = mapInstanceRef.current;
    if (!worker || !canvas || !map || !mapReadyRef.current) return;

    const bounds = getViewportBounds(map, 0.5);
    shadowBoundsRef.current       = bounds;
    shadowRenderBoundsRef.current = bounds; // snapshot for onmessage handler

    shadowRenderInFlightRef.current = true;
    worker.postMessage({
      type: "render",
      timeState: ts,
      bounds,
      width:  canvas.width,
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
    if (!incrementalOnly) onSunComputeStartedRef.current?.();
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
    const bounds = shadowBoundsRef.current ?? VIENNA_BOUNDS;
    renderShadowCanvas(canvas, allBuildings, ts, bounds);
    map.triggerRepaint();
  }

  // Update café dot colors after pan/zoom. Shadow check uses per-café nearby buildings.
  function refreshViewportShadows() {
    updateCafesSource(false);
  }

  // Fetch building tiles for the current viewport (plus buffer). Missing tiles are
  // fetched in parallel via /api/buildings?bbox=…. Results are merged into
  // buildingCacheRef and both workers are re-initialised with the full set.
  async function loadTilesForViewport() {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;
    if (map.getZoom() < MIN_BUILDING_ZOOM) return;

    const vpBounds = getViewportBounds(map, 0.3);
    const tileKeys = getTilesForBounds(vpBounds);

    // Keep existing tiles fresh in LRU
    for (const key of tileKeys) {
      if (tileBuildingsRef.current.has(key)) touchTile(key);
    }

    const missing = tileKeys.filter((k) => !loadedTilesRef.current.has(k));
    if (missing.length === 0) return;

    // Mark as in-flight so concurrent calls don't double-fetch
    for (const key of missing) loadedTilesRef.current.add(key);

    const results = await Promise.allSettled(
      missing.map(async (key) => {
        // Static pre-generated tile (fast, no server round-trip to Overpass)
        const staticKey = key.replace(",", "_");
        try {
          const r = await fetch(`/tiles/${staticKey}.json`);
          if (r.ok) {
            const { buildings } = await r.json() as { buildings: BuildingFeature[] };
            return { key, buildings };
          }
        } catch { /* network error on static file — fall through to API */ }

        // Fallback: live /api/buildings (for areas without pre-generated tiles)
        const tb = tileBoundsForKey(key);
        try {
          const r = await fetch(`/api/buildings?bbox=${tb.south},${tb.west},${tb.north},${tb.east}`);
          if (!r.ok) throw new Error(`${r.status}`);
          const { buildings } = await r.json() as { buildings: BuildingFeature[] };
          return { key, buildings };
        } catch (err) {
          loadedTilesRef.current.delete(key); // allow retry on next pan
          throw err;
        }
      })
    );

    let anyNew = false;
    for (const res of results) {
      if (res.status !== "fulfilled") continue;
      const { key, buildings } = res.value;
      tileBuildingsRef.current.set(key, buildings);
      touchTile(key);
      for (const b of buildings) buildingCacheRef.current.set(b.id, b);
      anyNew = true;
    }

    evictLruTiles();
    if (!mapReadyRef.current) return;

    const allBuildings = Array.from(buildingCacheRef.current.values());
    buildingGridRef.current = new BuildingGrid(allBuildings);

    // Always re-send viewport buildings to workers even when no new tiles were
    // loaded — the viewport may have moved to a cached area whose buildings the
    // shadow/sun workers haven't seen yet, causing shadows to be missing.
    const wb = getViewportBounds(map, 0.5);
    const vpBuildings = allBuildings.filter((b) => {
      const [bLat, bLng] = b.polygon[0];
      return bLat >= wb.south && bLat <= wb.north && bLng >= wb.west && bLng <= wb.east;
    });
    if (vpBuildings.length > 0) {
      shadowWorkerRef.current?.postMessage({ type: "init", buildings: vpBuildings });
      sunWorkerRef.current?.postMessage({ type: "init", buildings: vpBuildings });
    }

    // Update building footprint visuals only when new tiles arrived
    if (anyNew) {
      const bldgSrc = mapInstanceRef.current?.getSource("buildings-source") as any;
      if (bldgSrc) {
        bldgSrc.setData({
          type: "FeatureCollection",
          features: allBuildings
            .filter((b) => polygonAreaM2(b.polygon as [number, number][]) >= 80)
            .map((b) => ({
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [polygonToGeoJSON(b.polygon as [number, number][])] },
              properties: { id: b.id },
            })),
        });
      }
    }

    // Always trigger shadow re-render and café sun recomputation
    updateShadowSource([], timeStateRef.current);
    updateCafesSource(true);
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

  function updateLiveLocationVisual(state: LiveLocationState) {
    const map = mapInstanceRef.current;
    if (!map || !mapReadyRef.current) return;

    if (!locationMarkerRef.current && maplibreRef.current) {
      const { root } = createLocationPuck();
      locationMarkerRef.current = new maplibreRef.current.Marker({ element: root, anchor: "center" })
        .setLngLat([state.lng, state.lat])
        .addTo(map);
    } else {
      locationMarkerRef.current?.setLngLat([state.lng, state.lat]);
    }

    const accuracySource = map.getSource("user-location-accuracy-source");
    if (accuracySource) {
      accuracySource.setData(makeAccuracyCircle(state.lng, state.lat, Math.max(3, state.accuracy)));
    }
  }

  function acceptLocationUpdate(pos: GeolocationPosition) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const prev = locationStateRef.current;
    const movement = prev ? distanceMeters(prev.lat, prev.lng, lat, lng) : Infinity;

    if (prev && accuracy > prev.accuracy * 1.8 && prev.accuracy <= 25 && movement < Math.max(6, prev.accuracy * 0.35)) {
      return;
    }

    const nextState: LiveLocationState = { lat, lng, accuracy };
    locationStateRef.current = nextState;
    onUserLocationChange?.({ lat, lng });
    updateLiveLocationVisual(nextState);

    if (centerOnNextLocationRef.current && mapInstanceRef.current) {
      centerOnNextLocationRef.current = false;
      mapInstanceRef.current.easeTo({
        center: [lng, lat],
        zoom: Math.max(mapInstanceRef.current.getZoom(), 17),
        duration: 700,
      });
    }
  }

  function ensureLiveLocationWatch() {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    if (locationWatchIdRef.current !== null) return;

    locationWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => acceptLocationUpdate(pos),
      () => {
        setIsTrackingLocation(false);
        locationWatchIdRef.current = null;
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      },
    );
  }

  function startLiveLocationTracking() {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    centerOnNextLocationRef.current = true;
    setIsTrackingLocation(true);

    if (locationStateRef.current && mapInstanceRef.current) {
      const { lng, lat } = locationStateRef.current;
      mapInstanceRef.current.easeTo({
        center: [lng, lat],
        zoom: Math.max(mapInstanceRef.current.getZoom(), 17),
        duration: 500,
      });
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        acceptLocationUpdate(pos);
        ensureLiveLocationWatch();
      },
      () => {
        setIsTrackingLocation(false);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15000,
      },
    );
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

        // Update the canvas source coordinates to match what was just rendered.
        // Using the snapshotted bounds from when this render was dispatched avoids
        // placing old canvas content at new viewport coordinates.
        const rendered = shadowRenderBoundsRef.current;
        if (rendered) {
          const src = map.getSource("shadow-source") as any;
          src?.setCoordinates([
            [rendered.west, rendered.north],
            [rendered.east, rendered.north],
            [rendered.east, rendered.south],
            [rendered.west, rendered.south],
          ]);
        }

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

        // Drain pending (time-change) request first; if none, run background batch.
        // IMPORTANT: only signal settled when there is no further pending compute —
        // otherwise the first result (stale) would hide the spinner while the dots
        // still show wrong data until the next compute finishes.
        const next = pendingSunComputeRef.current;
        pendingSunComputeRef.current = null;
        if (next) {
          pendingBackgroundRef.current = null; // stale background, discard
          sunComputeInFlightRef.current = true;
          sunWorker.postMessage({ type: "compute", cafes: next.cafes, date: next.date, time: next.time });
          // Don't settle yet — another compute is in flight
        } else {
          if (!wasBackground) {
            onSunDataSettledRef.current?.();
          }
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
      maplibreRef.current = maplibregl;

      const map = new maplibregl.Map({
        container: mapRef.current,
        style: MAP_STYLE,
        center: [MAP_CENTER[1], MAP_CENTER[0]], // MapLibre: [lng, lat]
        zoom: 13,
        minZoom: 10,
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
        shadowCanvas.width  = SHADOW_CANVAS_SIZE;
        shadowCanvas.height = SHADOW_CANVAS_SIZE;
        shadowCanvasRef.current = shadowCanvas;

        // Initial shadow viewport covers the starting map view + 50% buffer.
        const initShadowBounds = getViewportBounds(map, 0.5);
        shadowBoundsRef.current = initShadowBounds;

        // ── sources ────────────────────────────────────────────────────────

        map.addSource("green-areas-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        // Shadow source: offscreen canvas raster. Coordinates are updated after
        // each render dispatch so the image always maps to the correct geo area.
        map.addSource("shadow-source", {
          type: "canvas",
          canvas: shadowCanvas,
          animate: true,
          coordinates: [
            [initShadowBounds.west, initShadowBounds.north],
            [initShadowBounds.east, initShadowBounds.north],
            [initShadowBounds.east, initShadowBounds.south],
            [initShadowBounds.west, initShadowBounds.south],
          ],
        });

        map.addSource("buildings-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addSource("cafes-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addSource("user-location-accuracy-source", {
          type: "geojson",
          data: EMPTY_FEATURE_COLLECTION,
        });

        // ── layers (z-order: bottom → top, all inserted before base labels) ─

        map.addLayer({
          id: "green-areas",
          type: "fill",
          source: "green-areas-source",
          paint: { "fill-color": "#aad3a0", "fill-opacity": 0.55 },
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

        map.addLayer({
          id: "user-location-accuracy-fill",
          type: "fill",
          source: "user-location-accuracy-source",
          paint: {
            "fill-color": "#4285f4",
            "fill-opacity": 0.14,
          },
        }, beforePlace);

        map.addLayer({
          id: "user-location-accuracy-outline",
          type: "line",
          source: "user-location-accuracy-source",
          paint: {
            "line-color": "#4285f4",
            "line-opacity": 0.28,
            "line-width": 1.5,
          },
        }, beforePlace);

        // Sunny cafés (non-selected) + selected cafés on top — emoji loaded once
        loadSunEmoji(map, () => {
          if (!mapReadyRef.current) return;
          loadMoonEmoji(map);

          // Non-selected shady cafés
          map.addLayer({
            id: "cafes",
            type: "symbol",
            source: "cafes-source",
            filter: ["all", ["==", ["get", "inShadow"], true], ["==", ["get", "isSelected"], false]],
            layout: {
              "icon-image": "cafe-shady",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.44, 14, 0.56, 16, 0.68, 18, 0.8],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-anchor": "center",
            },
          }, beforePlace);

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
            type: "symbol",
            source: "cafes-source",
            filter: ["all", ["==", ["get", "inShadow"], true], ["==", ["get", "isSelected"], true]],
            layout: {
              "icon-image": "cafe-shady",
              "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.58, 14, 0.72, 16, 0.86, 18, 1.02],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "icon-anchor": "center",
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

        // Toggle marker + shadow visibility based on zoom level.
        const markerLayers = ["cafes", "cafes-sunny", "cafes-selected-shadow", "cafes-selected-sunny", "cafes-hit"];
        const applyZoomVisibility = () => {
          const zoom = map.getZoom();
          const markerVis = zoom >= MIN_MARKER_ZOOM ? "visible" : "none";
          const shadowVis = zoom >= MIN_BUILDING_ZOOM ? "visible" : "none";
          for (const id of markerLayers) {
            if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", markerVis);
          }
          if (map.getLayer("shadows")) map.setLayoutProperty("shadows", "visibility", shadowVis);
        };
        map.on("zoom", applyZoomVisibility);

        // After any pan/zoom: refresh café dots, re-render shadow for new viewport,
        // and load any building tiles that entered the viewport.
        // Tile loading is debounced so rapid panning/zooming doesn't fire many
        // parallel fetch storms before the user has settled on a position.
        map.on("moveend", () => {
          refreshViewportShadows();
          updateShadowSource([], timeStateRef.current);
          if (tileLoadTimerRef.current !== null) window.clearTimeout(tileLoadTimerRef.current);
          tileLoadTimerRef.current = window.setTimeout(() => {
            tileLoadTimerRef.current = null;
            loadTilesForViewport();
          }, 300);
        });

        // ── load data ─────────────────────────────────────────────────────

        loadTilesForViewport(); // async — fires and forgets; triggers shadow + sun on completion
        loadGreenAreas();
        if (locationStateRef.current) updateLiveLocationVisual(locationStateRef.current);
      });
    });

    return () => {
      mounted = false;
      mapReadyRef.current = false;
      shadowRenderInFlightRef.current = false;
      pendingShadowTimeRef.current = null;
      if (locationWatchIdRef.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
        locationWatchIdRef.current = null;
      }
      onUserLocationChange?.(null);
      locationMarkerRef.current?.remove();
      locationMarkerRef.current = null;
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
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    // Worker renders for current viewport; empty [] is fine — worker has its own building cache.
    updateShadowSource([], timeState);
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
          onClick={startLiveLocationTracking}
          className={`w-[56px] h-[56px] rounded-full shadow-xl shadow-zinc-300/40 border flex items-center justify-center transition-colors ${
            isTrackingLocation
              ? "bg-blue-50 border-blue-200"
              : "bg-white border-zinc-100"
          }`}
          style={{ marginRight: "5px" }}
          title="Live-Standort anzeigen"
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
          <text
            x={sx}
            y={sy + 5}
            textAnchor="middle"
            fontSize="16"
            style={{ fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif" }}
          >
            ☀️
          </text>
        ) : (
          <text x={r} y={r + 5} textAnchor="middle" fontSize="16" fill="#94a3b8">🌙</text>
        )}
      </svg>
    </div>
  );
}
