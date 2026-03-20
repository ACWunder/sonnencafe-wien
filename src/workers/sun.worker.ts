// src/workers/sun.worker.ts
// Precomputes shadow state for every café at every 10-minute slot across
// the full daylight window — done once when buildings load (or when the date
// changes).  After this, time-slider changes become O(1) table lookups with
// no main-thread computation at all.
//
// Protocol (messages TO worker):
//   { type: 'precompute', cafes: Cafe[], buildings: BuildingFeature[], date: string }
//
// Protocol (messages FROM worker):
//   { type: 'done', table: Record<string, boolean[]>, minutes: number[] }
//      table[cafeId][i] = true  → café is in shadow at minutes[i]

import { getSunPosition, getSunTimes } from "@/lib/sun";
import { calcShadowPolygon } from "@/lib/buildingShadow";
import type { Cafe } from "@/types";
import type { BuildingFeature } from "@/app/api/buildings/route";

const INTERVAL_MIN  = 10;  // must match calcSunRemaining step size
const OFFSET_M      = 10;  // metres — match calcSunRemaining OFFSET_M
const FALLBACK_H    = 18;
const GRID_CELL     = 0.004;

// ── lightweight building grid ─────────────────────────────────────────────────

class BuildingGrid {
  private cells = new Map<string, BuildingFeature[]>();

  constructor(buildings: BuildingFeature[]) {
    for (const b of buildings) {
      const key = this.key(b.polygon[0][0], b.polygon[0][1]);
      let cell = this.cells.get(key);
      if (!cell) { cell = []; this.cells.set(key, cell); }
      cell.push(b);
    }
  }

  private key(lat: number, lng: number) {
    return `${Math.floor(lat / GRID_CELL)},${Math.floor(lng / GRID_CELL)}`;
  }

  getNearby(lat: number, lng: number): BuildingFeature[] {
    const result: BuildingFeature[] = [];
    const row = Math.floor(lat / GRID_CELL);
    const col = Math.floor(lng / GRID_CELL);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const bs = this.cells.get(`${row + dr},${col + dc}`);
        if (bs) result.push(...bs);
      }
    return result;
  }
}

function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [lati, lngi] = poly[i];
    const [latj, lngj] = poly[j];
    if ((lngi > lng) !== (lngj > lng) &&
        lat < ((latj - lati) * (lng - lngi)) / (lngj - lngi) + lati)
      inside = !inside;
  }
  return inside;
}

// ── main handler ──────────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as {
    type: "precompute";
    cafes: Cafe[];
    buildings: BuildingFeature[];
    date: string; // YYYY-MM-DD
  };
  if (msg.type !== "precompute") return;

  const { cafes, buildings, date: dateStr } = msg;

  const grid = new BuildingGrid(buildings);

  // Use the geographic centre of the district as the reference point for
  // sunrise/sunset times (individual café times differ by < 1 second).
  const refLat = cafes.reduce((s, c) => s + c.lat, 0) / cafes.length;
  const refLng = cafes.reduce((s, c) => s + c.lng, 0) / cafes.length;
  const refDate = new Date(`${dateStr}T12:00:00`);

  const times      = getSunTimes(refLat, refLng, refDate);
  const startMin   = times.sunrise.getHours() * 60 + times.sunrise.getMinutes();
  const endMin     = times.sunset.getHours()  * 60 + times.sunset.getMinutes();

  // Build minute slots array
  const minutes: number[] = [];
  for (let m = startMin; m <= endMin; m += INTERVAL_MIN) minutes.push(m);

  const table: Record<string, boolean[]> = {};

  for (const cafe of cafes) {
    const nearby = grid.getNearby(cafe.lat, cafe.lng);
    const cosLat = Math.cos((cafe.lat * Math.PI) / 180);
    const slots: boolean[] = [];

    for (const minute of minutes) {
      const slotDate = new Date(
        refDate.getFullYear(), refDate.getMonth(), refDate.getDate(),
        Math.floor(minute / 60), minute % 60, 0, 0,
      );
      const sunPos = getSunPosition(cafe.lat, cafe.lng, slotDate);

      if (sunPos.altitudeDeg <= 0) { slots.push(true); continue; }

      const az     = (sunPos.azimuthDeg * Math.PI) / 180;
      const chkLat = cafe.lat + (OFFSET_M * Math.cos(az)) / 111_000;
      const chkLng = cafe.lng + (OFFSET_M * Math.sin(az)) / (111_000 * cosLat);

      const inShadow = nearby.some((b) => {
        const poly = calcShadowPolygon(
          b.polygon as [number, number][],
          b.height ?? FALLBACK_H,
          sunPos.altitudeDeg,
          sunPos.azimuthDeg,
        );
        return poly.length >= 3 && pointInPolygon(chkLat, chkLng, poly);
      });

      slots.push(inShadow);
    }

    table[cafe.id] = slots;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage({ type: "done", table, minutes });
};
