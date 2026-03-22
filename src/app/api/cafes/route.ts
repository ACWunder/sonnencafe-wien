// src/app/api/cafes/route.ts

import { NextResponse } from "next/server";
import { fetchCafesFromOverpass, INNER_DISTRICTS_BBOX, VIENNA_FULL_BBOX } from "@/lib/overpass";
import { FALLBACK_CAFES } from "@/lib/fallback-cafes";

type CafeList = Awaited<ReturnType<typeof fetchCafesFromOverpass>>;

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Separate caches for inner (districts 1–9) and full Vienna
const cache: Record<"inner" | "full", { data: CafeList | null; ts: number }> = {
  inner: { data: null, ts: 0 },
  full:  { data: null, ts: 0 },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // ?area=inner → districts 1–9 only (fast); default → full Vienna
  const area = searchParams.get("area") === "inner" ? "inner" : "full";
  const bbox = area === "inner" ? INNER_DISTRICTS_BBOX : VIENNA_FULL_BBOX;

  const bucket = cache[area];
  if (bucket.data && Date.now() - bucket.ts < CACHE_TTL) {
    return NextResponse.json({ cafes: bucket.data, source: "cache" });
  }

  try {
    const cafes = await fetchCafesFromOverpass(bbox);

    if (cafes.length === 0) {
      return NextResponse.json({ cafes: FALLBACK_CAFES, source: "fallback" });
    }

    bucket.data = cafes;
    bucket.ts   = Date.now();

    return NextResponse.json({ cafes, source: "overpass" });
  } catch (error) {
    console.error("Overpass API error:", error);
    return NextResponse.json(
      { cafes: FALLBACK_CAFES, source: "fallback", error: "Overpass API unavailable, using fallback data" },
      { status: 200 }
    );
  }
}
