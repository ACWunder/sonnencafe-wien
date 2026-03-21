// src/workers/sun.worker.ts
// Runs calcSunRemaining + calcDayTimeline for all cafés in one shot on a
// background thread — no requestIdleCallback chunking, no main-thread blocking.
//
// Day timelines are cached by date: repeated time-slider moves on the same day
// skip the timeline computation entirely (~halves the work per call).
//
// Protocol (messages TO worker):
//   { type: 'init',    buildings: BuildingFeature[] }
//   { type: 'compute', cafes: Cafe[], date: string, time: string }
//
// Protocol (messages FROM worker):
//   { type: 'computed', remaining: Record<string, number|null>, timelines: SunTimelineData }

import { getSunPosition, getSunTimes } from "@/lib/sun";
import { calcShadowPolygon } from "@/lib/buildingShadow";
import type { Cafe, SunTimeline, SunTimelineData } from "@/types";
import type { BuildingFeature } from "@/app/api/buildings/route";

const FALLBACK_H = 18;
const GRID_CELL  = 0.004;

// ── building grid (identical to MapView's) ────────────────────────────────────

class BuildingGrid {
  private cells = new Map<string, BuildingFeature[]>();
  constructor(buildings: BuildingFeature[]) {
    for (const b of buildings) {
      const k = this.key(b.polygon[0][0], b.polygon[0][1]);
      let c = this.cells.get(k);
      if (!c) { c = []; this.cells.set(k, c); }
      c.push(b);
    }
  }
  private key(lat: number, lng: number) {
    return `${Math.floor(lat / GRID_CELL)},${Math.floor(lng / GRID_CELL)}`;
  }
  getNearby(lat: number, lng: number): BuildingFeature[] {
    const out: BuildingFeature[] = [];
    const r = Math.floor(lat / GRID_CELL), c = Math.floor(lng / GRID_CELL);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const bs = this.cells.get(`${r + dr},${c + dc}`);
        if (bs) out.push(...bs);
      }
    return out;
  }
}

function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [li, gi] = poly[i], [lj, gj] = poly[j];
    if ((gi > lng) !== (gj > lng) && lat < ((lj - li) * (lng - gi)) / (gj - gi) + li)
      inside = !inside;
  }
  return inside;
}

// ── sun calculation helpers (mirrors MapView functions) ───────────────────────

function calcSunRemaining(cafe: Cafe, currentDate: Date, nearby: BuildingFeature[]): number | null {
  const STEP_MS   = 10 * 60 * 1000;
  const MAX_STEPS = 24;
  const OFFSET_M  = 10;
  const LAT_MAX   = 200 / 111_000;
  const LNG_MAX   = 200 / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));

  const sunTimes = getSunTimes(cafe.lat, cafe.lng, currentDate);
  const minsUntilSunset = Math.max(0, Math.floor((sunTimes.sunset.getTime() - currentDate.getTime()) / 60_000));
  if (minsUntilSunset === 0) return null;

  const close = nearby.filter((b) => {
    const [bLat, bLng] = b.polygon[0];
    return Math.abs(bLat - cafe.lat) < LAT_MAX && Math.abs(bLng - cafe.lng) < LNG_MAX;
  });

  for (let step = 0; step <= MAX_STEPS; step++) {
    const date   = new Date(currentDate.getTime() + step * STEP_MS);
    const sunPos = getSunPosition(cafe.lat, cafe.lng, date);
    if (sunPos.altitudeDeg <= 0) return step === 0 ? null : Math.min((step - 1) * 10, minsUntilSunset);

    const azRad  = (sunPos.azimuthDeg * Math.PI) / 180;
    const cosLat = Math.cos((cafe.lat * Math.PI) / 180);
    const chkLat = cafe.lat + (OFFSET_M * Math.cos(azRad)) / 111_000;
    const chkLng = cafe.lng + (OFFSET_M * Math.sin(azRad)) / (111_000 * cosLat);

    const inShadow = close.some((b) => {
      const poly = calcShadowPolygon(b.polygon as [number,number][], b.height ?? FALLBACK_H, sunPos.altitudeDeg, sunPos.azimuthDeg);
      return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
    });
    if (inShadow) return step === 0 ? null : Math.min((step - 1) * 10, minsUntilSunset);
  }
  return Math.min(MAX_STEPS * 10, minsUntilSunset);
}

function calcDayTimeline(cafe: Cafe, date: Date, nearby: BuildingFeature[]): SunTimeline {
  const INTERVAL_MIN = 20;
  const OFFSET_M     = 10;
  const LAT_MAX      = 200 / 111_000;
  const LNG_MAX      = 200 / (111_000 * Math.cos((cafe.lat * Math.PI) / 180));

  const close = nearby.filter((b) => {
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
    const cosLat = Math.cos((cafe.lat * Math.PI) / 180);
    const chkLat = cafe.lat + (OFFSET_M * Math.cos(azRad)) / 111_000;
    const chkLng = cafe.lng + (OFFSET_M * Math.sin(azRad)) / (111_000 * cosLat);

    const inShadow = close.some((b) => {
      const poly = calcShadowPolygon(b.polygon as [number,number][], b.height ?? FALLBACK_H, sunPos.altitudeDeg, sunPos.azimuthDeg);
      return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
    });
    inSun.push(!inShadow);
  }

  return { inSun, startMinute, intervalMin: INTERVAL_MIN };
}

// ── worker state ──────────────────────────────────────────────────────────────

let grid: BuildingGrid | null = null;
let allBuildings: BuildingFeature[] = [];
// Timeline cache: reused across time changes on the same date
let timelineCache: { date: string; timelines: SunTimelineData } | null = null;

// ── message handler ───────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: "init";    buildings: BuildingFeature[] }
    | { type: "compute"; cafes: Cafe[]; date: string; time: string };

  if (msg.type === "init") {
    allBuildings  = msg.buildings;
    grid          = new BuildingGrid(allBuildings);
    timelineCache = null; // invalidate on buildings reload
    return;
  }

  if (msg.type === "compute") {
    const { cafes, date, time } = msg;
    const currentDate = new Date(`${date}T${time}:00`);
    const dayDate     = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 12, 0, 0);

    const remaining: Record<string, number | null> = {};
    const dateChanged = !timelineCache || timelineCache.date !== date;
    const freshTimelines: SunTimelineData = {};

    for (const cafe of cafes) {
      const nearby = grid?.getNearby(cafe.lat, cafe.lng) ?? allBuildings;
      remaining[cafe.id] = calcSunRemaining(cafe, currentDate, nearby);
      // Compute timeline if date changed OR this café isn't cached yet
      if (dateChanged || !timelineCache!.timelines[cafe.id]) {
        freshTimelines[cafe.id] = calcDayTimeline(cafe, dayDate, nearby);
      }
    }

    if (dateChanged) {
      timelineCache = { date, timelines: freshTimelines };
    } else if (Object.keys(freshTimelines).length > 0) {
      timelineCache = { date, timelines: { ...timelineCache!.timelines, ...freshTimelines } };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage({
      type: "computed",
      remaining,
      timelines: timelineCache!.timelines,
    });
  }
};
