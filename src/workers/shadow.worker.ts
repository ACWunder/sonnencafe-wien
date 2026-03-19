// src/workers/shadow.worker.ts
// Offloads shadow canvas rendering to a background thread.
//
// Protocol (messages TO worker):
//   { type: 'init',   buildings: BuildingFeature[] }
//   { type: 'render', timeState: TimeState, bounds: DistrictBounds, width: number, height: number }
//
// Protocol (messages FROM worker):
//   { type: 'rendered', bitmap: ImageBitmap }   (bitmap is transferred, not copied)

import { getSunPosition } from "@/lib/sun";
import type { BuildingFeature } from "@/app/api/buildings/route";
import type { TimeState } from "@/types";

type DistrictBounds = { south: number; west: number; north: number; east: number };

const FALLBACK_HEIGHT = 18;

// Pre-computed per-building data that never changes with time
interface PreparedBuilding {
  hull: [number, number][];   // convex hull of footprint (computed once at init)
  cosLat: number;             // Math.cos(refLat * PI/180) for dlng computation
  bldgHeight: number;
}

let preparedBuildings: PreparedBuilding[] = [];

function convexHull(pts: [number, number][]): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: "init"; buildings: BuildingFeature[] }
    | { type: "render"; timeState: TimeState; bounds: DistrictBounds; width: number; height: number };

  if (msg.type === "init") {
    // Pre-compute convex hulls once — they never change with time.
    preparedBuildings = msg.buildings.map((b) => {
      const polygon = b.polygon as [number, number][];
      const verts: [number, number][] =
        polygon[0][0] === polygon[polygon.length - 1][0] &&
        polygon[0][1] === polygon[polygon.length - 1][1]
          ? polygon.slice(0, -1)
          : polygon;
      const hull = convexHull(verts);
      const refLat = polygon[0][0];
      return {
        hull,
        cosLat: Math.cos((refLat * Math.PI) / 180),
        bldgHeight: b.height ?? FALLBACK_HEIGHT,
      };
    });
    return;
  }

  if (msg.type === "render") {
    const { timeState, bounds, width, height: canvasH } = msg;

    const canvas = new OffscreenCanvas(width, canvasH);
    const ctx = canvas.getContext("2d")!;

    const date = new Date(`${timeState.date}T${timeState.time}:00`);
    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.west  + bounds.east)  / 2;
    const sunPos = getSunPosition(centerLat, centerLng, date);

    ctx.clearRect(0, 0, width, canvasH);
    ctx.fillStyle = "#334155";

    if (sunPos.altitudeDeg <= 0) {
      ctx.fillRect(0, 0, width, canvasH);
    } else {
      const bW = bounds.east - bounds.west;
      const bH = bounds.north - bounds.south;

      // Direction constants shared across all buildings for this sun position
      const altRad = (sunPos.altitudeDeg * Math.PI) / 180;
      const azRad  = (sunPos.azimuthDeg  * Math.PI) / 180;
      const tanAlt  = Math.tan(altRad);
      const sinAz   = Math.sin(azRad);
      const cosAz   = Math.cos(azRad);
      const inv111k = 1 / 111_000;

      ctx.beginPath();
      for (const { hull, cosLat, bldgHeight } of preparedBuildings) {
        if (hull.length < 3) continue;

        const shadowLen  = Math.min(bldgHeight / tanAlt, 300);
        const dlat = -shadowLen * cosAz * inv111k;
        const dlng = -shadowLen * sinAz * inv111k / cosLat;

        // Convex hull of footprint hull + shadow-shifted hull
        const combined: [number, number][] = new Array(hull.length * 2);
        for (let i = 0; i < hull.length; i++) {
          combined[i] = hull[i];
          combined[hull.length + i] = [hull[i][0] + dlat, hull[i][1] + dlng];
        }
        const shadow = convexHull(combined);
        if (shadow.length < 3) continue;

        let first = true;
        for (const [lat, lng] of shadow) {
          const x = (lng - bounds.west)  / bW * width;
          const y = (bounds.north - lat) / bH * canvasH;
          if (first) { ctx.moveTo(x, y); first = false; }
          else         ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fill();
    }

    const bitmap = canvas.transferToImageBitmap();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage({ type: "rendered", bitmap }, [bitmap]);
  }
};
