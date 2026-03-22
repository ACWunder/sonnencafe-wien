// src/app/api/cafes/route.ts

import { NextResponse } from "next/server";
import { fetchCafesFromOverpass, VIENNA_FULL_BBOX } from "@/lib/overpass";
import { FALLBACK_CAFES } from "@/lib/fallback-cafes";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// In-memory cache for the full-Vienna response (shared across requests)
let cachedCafes: Awaited<ReturnType<typeof fetchCafesFromOverpass>> | null = null;
let cacheTimestamp = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bboxParam = searchParams.get("bbox");

  if (bboxParam) {
    // Viewport query — small bbox, no server-side cache (Overpass has its own cache).
    const parts = bboxParam.split(",").map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) {
      return NextResponse.json({ error: "invalid bbox" }, { status: 400 });
    }
    const [south, west, north, east] = parts;
    try {
      const cafes = await fetchCafesFromOverpass({ south, north, west, east });
      return NextResponse.json({ cafes, source: "overpass-viewport" });
    } catch {
      return NextResponse.json({ cafes: [], source: "error" });
    }
  }

  // Full Vienna — serve from cache if fresh
  if (cachedCafes && Date.now() - cacheTimestamp < CACHE_TTL) {
    return NextResponse.json({ cafes: cachedCafes, source: "cache" });
  }

  try {
    const cafes = await fetchCafesFromOverpass(VIENNA_FULL_BBOX);
    if (cafes.length === 0) {
      return NextResponse.json({ cafes: FALLBACK_CAFES, source: "fallback" });
    }
    cachedCafes = cafes;
    cacheTimestamp = Date.now();
    return NextResponse.json({ cafes, source: "overpass" });
  } catch (error) {
    console.error("Overpass API error:", error);
    return NextResponse.json(
      { cafes: FALLBACK_CAFES, source: "fallback", error: "Overpass unavailable" },
      { status: 200 }
    );
  }
}
