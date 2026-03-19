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
import { calcShadowPolygon } from "@/lib/buildingShadow";
import type { BuildingFeature } from "@/app/api/buildings/route";
import type { TimeState } from "@/types";

type DistrictBounds = { south: number; west: number; north: number; east: number };

const FALLBACK_HEIGHT = 18;

let storedBuildings: BuildingFeature[] = [];

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: "init"; buildings: BuildingFeature[] }
    | { type: "render"; timeState: TimeState; bounds: DistrictBounds; width: number; height: number };

  if (msg.type === "init") {
    storedBuildings = msg.buildings;
    return;
  }

  if (msg.type === "render") {
    const { timeState, bounds, width, height } = msg;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;

    const date = new Date(`${timeState.date}T${timeState.time}:00`);
    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.west  + bounds.east)  / 2;
    const sunPos = getSunPosition(centerLat, centerLng, date);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#334155";

    if (sunPos.altitudeDeg <= 0) {
      ctx.fillRect(0, 0, width, height);
    } else {
      const bW = bounds.east - bounds.west;
      const bH = bounds.north - bounds.south;

      ctx.beginPath();
      for (const b of storedBuildings) {
        const shadow = calcShadowPolygon(
          b.polygon as [number, number][],
          b.height ?? FALLBACK_HEIGHT,
          sunPos.altitudeDeg,
          sunPos.azimuthDeg,
        );
        if (shadow.length < 3) continue;
        let first = true;
        for (const [lat, lng] of shadow as [number, number][]) {
          const x = (lng - bounds.west)  / bW * width;
          const y = (bounds.north - lat) / bH * height;
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
