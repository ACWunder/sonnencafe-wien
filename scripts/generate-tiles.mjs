#!/usr/bin/env node
// scripts/generate-tiles.mjs
// Pre-generates building tile JSON files for all of Vienna.
// Output: public/tiles/{r}_{c}.json  (one file per tile)
//
// Run: node scripts/generate-tiles.mjs
//
// Tile grid parameters must match src/lib/mapConfig.ts:
//   TILE_LAT = 0.04, TILE_LNG = 0.06
//   Vienna: 48.10–48.33°N, 16.17–16.60°E

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, "..", "public", "tiles");

const TILE_LAT    = 0.04;
const TILE_LNG    = 0.06;
const FALLBACK_H  = 18;
const OVERPASS    = "https://overpass-api.de/api/interpreter";
const DELAY_MS    = 1500; // polite pause between Overpass requests

// Vienna bounds
const VIENNA = { south: 48.10, north: 48.33, west: 16.17, east: 16.60 };

// ── Overpass parsing (mirrors src/app/api/buildings/route.ts) ───────────────

function parseHeight(tags) {
  if (tags?.height) {
    const h = parseFloat(String(tags.height));
    if (!isNaN(h) && h > 0) return h;
  }
  if (tags?.["building:levels"]) {
    const levels = parseFloat(String(tags["building:levels"]));
    if (!isNaN(levels) && levels > 0) return Math.round(levels * 3.2);
  }
  return FALLBACK_H;
}

function assembleRing(wayIds, wayNodes, nodeCoords) {
  if (wayIds.length === 0) return [];
  const segments = wayIds.map((id) => wayNodes.get(id) ?? []).filter((s) => s.length >= 2);
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    return segments[0].map((id) => nodeCoords.get(id)).filter(Boolean);
  }
  const ring = [...segments[0]];
  const remaining = segments.slice(1);
  for (let iter = 0; iter < remaining.length * 2; iter++) {
    const tail = ring[ring.length - 1];
    const idx  = remaining.findIndex((s) => s[0] === tail || s[s.length - 1] === tail);
    if (idx === -1) break;
    const seg = remaining.splice(idx, 1)[0];
    if (seg[0] === tail) ring.push(...seg.slice(1));
    else ring.push(...seg.slice(0, -1).reverse());
  }
  return ring.map((id) => nodeCoords.get(id)).filter(Boolean);
}

function parseOverpass(data) {
  const nodeCoords = new Map();
  const wayNodes   = new Map();
  for (const el of data.elements) {
    if (el.type === "node") nodeCoords.set(el.id, [el.lat, el.lon]);
    else if (el.type === "way") wayNodes.set(el.id, el.nodes);
  }
  const buildings = [];
  for (const el of data.elements) {
    if (el.type === "way" && el.tags?.building) {
      const polygon = (el.nodes).map((id) => nodeCoords.get(id)).filter(Boolean);
      if (polygon.length >= 3) buildings.push({ id: el.id, polygon, height: parseHeight(el.tags) });
    } else if (el.type === "relation" && el.tags?.building) {
      const outerIds = (el.members ?? []).filter((m) => m.type === "way" && m.role === "outer").map((m) => m.ref);
      if (outerIds.length === 0) continue;
      const polygon = assembleRing(outerIds, wayNodes, nodeCoords);
      if (polygon.length >= 3) buildings.push({ id: el.id, polygon, height: parseHeight(el.tags) });
    }
  }
  return buildings;
}

// ── tile fetching ────────────────────────────────────────────────────────────

async function fetchTile(r, c, attempt = 1) {
  const south = r * TILE_LAT - 0.001;
  const north = (r + 1) * TILE_LAT + 0.001;
  const west  = c * TILE_LNG - 0.001;
  const east  = (c + 1) * TILE_LNG + 0.001;

  const query = `[out:json][timeout:40];(way["building"](${south},${west},${north},${east});relation["building"](${south},${west},${north},${east}););out body;>;out skel qt;`;

  const res = await fetch(OVERPASS, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(50000),
  });

  if (res.status === 429 || res.status === 503) {
    if (attempt >= 3) throw new Error(`Overpass ${res.status} after ${attempt} attempts`);
    const wait = attempt * 5000;
    console.log(`  ⚠️  Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/3…`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchTile(r, c, attempt + 1);
  }

  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  return parseOverpass(data);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rMin = Math.floor(VIENNA.south / TILE_LAT);
  const rMax = Math.floor(VIENNA.north / TILE_LAT);
  const cMin = Math.floor(VIENNA.west  / TILE_LNG);
  const cMax = Math.floor(VIENNA.east  / TILE_LNG);

  const tiles = [];
  for (let r = rMin; r <= rMax; r++)
    for (let c = cMin; c <= cMax; c++)
      tiles.push([r, c]);

  console.log(`Generating ${tiles.length} tiles (${rMax - rMin + 1} rows × ${cMax - cMin + 1} cols)…`);

  let done = 0, skipped = 0, failed = 0;

  for (const [r, c] of tiles) {
    const file = path.join(OUT_DIR, `${r}_${c}.json`);

    if (fs.existsSync(file)) {
      console.log(`  ✓ skip  tile ${r}_${c}  (already exists)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ⬇  tile ${r}_${c}  (${done + skipped + 1}/${tiles.length})… `);
    try {
      const buildings = await fetchTile(r, c);
      fs.writeFileSync(file, JSON.stringify({ buildings }));
      console.log(`${buildings.length} buildings`);
      done++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }

    // Polite delay between requests
    if (done + failed > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. ${done} generated, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) console.log("Re-run the script to retry failed tiles.");
}

main().catch((err) => { console.error(err); process.exit(1); });
