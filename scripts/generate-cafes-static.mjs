#!/usr/bin/env node
// scripts/generate-cafes-static.mjs
// Pre-generates public/cafes.json so the app never hits Overpass at runtime.
// Run: node scripts/generate-cafes-static.mjs
// Optional env: CITY_BBOX="south,west,north,east"  (default: Vienna)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE  = path.join(__dirname, "..", "public", "cafes.json");

const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const DELAY_MS = 2000;

// ── bbox ─────────────────────────────────────────────────────────────────────

const VIENNA = { south: 48.10, north: 48.33, west: 16.17, east: 16.60 };
let BBOX = VIENNA;
if (process.env.CITY_BBOX) {
  const [s, w, n, e] = process.env.CITY_BBOX.split(",").map(Number);
  if ([s, w, n, e].every((v) => !isNaN(v))) BBOX = { south: s, north: n, west: w, east: e };
}

// ── Overpass query ────────────────────────────────────────────────────────────

function buildQuery(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:55];(node["amenity"~"cafe|coffee_shop|bistro|ice_cream"](${b});way["amenity"~"cafe|coffee_shop|bistro|ice_cream"](${b});node["shop"~"coffee|tea|pastry|bakery"](${b});way["shop"~"coffee|tea|pastry|bakery"](${b});node["amenity"~"restaurant|bar"]["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast",i](${b});way["amenity"~"restaurant|bar"]["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast",i](${b});node["amenity"="restaurant"](${b});way["amenity"="restaurant"](${b});node["amenity"="bar"](${b});way["amenity"="bar"](${b});node["amenity"="pub"](${b});way["amenity"="pub"](${b}););out body;>;out body qt;`;
}

async function fetchFromOverpass(bbox, attempt = 0) {
  for (let s = 0; s < OVERPASS_SERVERS.length; s++) {
    const server = OVERPASS_SERVERS[s];
    try {
      process.stdout.write(`  Trying ${server.replace("https://", "")}… `);
      const res = await fetch(server, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(buildQuery(bbox))}`,
        signal: AbortSignal.timeout(65_000),
      });
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        console.log(`${res.status} — trying next`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log(`OK (${data.elements.length} elements)`);
      return data;
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }
  if (attempt < 2) {
    const wait = (attempt + 1) * 8000;
    console.log(`  All servers failed — waiting ${wait / 1000}s before retry ${attempt + 1}/2…`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchFromOverpass(bbox, attempt + 1);
  }
  throw new Error("All Overpass servers failed after retries");
}

// ── tag helpers ───────────────────────────────────────────────────────────────

function isCafeElement(tags) {
  if (["cafe", "coffee_shop", "bistro", "ice_cream"].includes(tags.amenity ?? "")) return true;
  if (["coffee", "tea", "pastry", "bakery"].includes(tags.shop ?? "")) return true;
  if (/coffee_shop|espresso|cappuccino|kaffeehaus|teahouse|pastry|cake|breakfast/i.test(tags.cuisine ?? "")) return true;
  if (/restaurant|bar/i.test(tags.amenity ?? "") &&
      /coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast/i.test(tags.cuisine ?? "")) return true;
  if (["restaurant", "bar", "pub"].includes(tags.amenity ?? "")) return true;
  return false;
}

function postcodeDistrict(postcode) {
  if (!postcode) return null;
  const m = String(postcode).match(/^1(\d{2})0$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return (num >= 1 && num <= 23) ? `${num}. Bezirk` : null;
}

function streetFacingPoint(nodeIds, nodeCoords, centLat, centLon) {
  const pts = nodeIds.map((id) => nodeCoords.get(id)).filter(Boolean);
  if (pts.length < 2) return null;
  let bestDist = -1, best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    const d = Math.hypot(mid.lat - centLat, mid.lon - centLon);
    if (d > bestDist) { bestDist = d; best = mid; }
  }
  return best;
}

function parseCafes(data) {
  const nodeCoords = new Map();
  const entranceNodes = new Set();
  for (const el of data.elements) {
    if (el.type === "node" && el.lat !== undefined) {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
      if (el.tags?.entrance) entranceNodes.add(el.id);
    }
  }

  const seen = new Set();
  const cafes = [];
  for (const el of data.elements) {
    if (!el.tags || !isCafeElement(el.tags)) continue;
    const rawLat = el.lat ?? el.center?.lat;
    const rawLon = el.lon ?? el.center?.lon;
    if (rawLat === undefined) continue;
    const key = `${el.type}-${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let lat = rawLat, lon = rawLon;
    const tags = el.tags ?? {};
    if (el.type === "way" && el.nodes?.length) {
      const entranceId = el.nodes.find((id) => entranceNodes.has(id));
      if (entranceId) { const c = nodeCoords.get(entranceId); if (c) { lat = c.lat; lon = c.lon; } }
      else { const ext = streetFacingPoint(el.nodes, nodeCoords, lat, lon); if (ext) { lat = ext.lat; lon = ext.lon; } }
    }

    const district = postcodeDistrict(tags["addr:postcode"]);
    const name = tags.name || tags["name:de"] || tags["brand"] || `${tags.amenity ?? "Café"} (unbenannt)`;
    const addr = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
    // Keep only the tags actually used at runtime (amenity + opening_hours)
    const slimTags = {};
    if (tags.amenity)        slimTags.amenity        = tags.amenity;
    if (tags.opening_hours)  slimTags.opening_hours  = tags.opening_hours;
    cafes.push({ id: key, name, lat, lng: lon, address: addr || undefined, district: district ?? undefined, tags: slimTags, amenity: tags.amenity });
  }
  return cafes;
}

// ── Split into quadrants to avoid Overpass timeouts ───────────────────────────

function splitBbox(bbox) {
  const midLat = (bbox.south + bbox.north) / 2;
  const midLon = (bbox.west  + bbox.east)  / 2;
  return [
    { south: bbox.south, north: midLat, west: bbox.west,  east: midLon }, // SW
    { south: bbox.south, north: midLat, west: midLon,     east: bbox.east }, // SE
    { south: midLat,     north: bbox.north, west: bbox.west,  east: midLon }, // NW
    { south: midLat,     north: bbox.north, west: midLon,     east: bbox.east }, // NE
  ];
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const quads = splitBbox(BBOX);
  console.log(`Fetching cafés in ${quads.length} quadrants…\n`);

  const allById = new Map();

  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    console.log(`Quadrant ${i + 1}/${quads.length}: ${JSON.stringify(q)}`);
    const data = await fetchFromOverpass(q);
    const cafes = parseCafes(data);
    for (const c of cafes) allById.set(c.id, c);
    console.log(`  → ${cafes.length} cafés (total unique: ${allById.size})\n`);
    if (i < quads.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const cafes = Array.from(allById.values());
  console.log(`Total: ${cafes.length} cafés`);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ cafes }));
  const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
  console.log(`Saved → ${OUT_FILE}  (${kb} KB)\nDone!`);
}

main().catch((err) => { console.error(err); process.exit(1); });
