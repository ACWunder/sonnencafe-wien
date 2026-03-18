// src/lib/overpass.ts

import type { Cafe, OverpassResponse } from "@/types";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// OSM bounding box for districts 5 (Margareten), 6 (Mariahilf), 7 (Neubau), 8 (Josefstadt)
export const VIENNA_BBOX = {
  south: 48.175,
  west: 16.333,
  north: 48.230,
  east: 16.375,
};

export const VIENNA_FULL_BBOX = VIENNA_BBOX;

export function buildOverpassQuery(): string {
  const bbox = `${VIENNA_FULL_BBOX.south},${VIENNA_FULL_BBOX.west},${VIENNA_FULL_BBOX.north},${VIENNA_FULL_BBOX.east}`;

  // Cast the net wide:
  // 1. amenity=cafe (standard)
  // 2. amenity=restaurant with a coffee/kaffeehaus cuisine tag
  // 3. shop=coffee (roasters / coffee bars)
  // Both node and way so area-mapped places are included.
  return `
[out:json][timeout:30];
(
  node["amenity"="cafe"](${bbox});
  way["amenity"="cafe"](${bbox});
  node["amenity"="coffee_shop"](${bbox});
  way["amenity"="coffee_shop"](${bbox});
  node["amenity"="bistro"](${bbox});
  way["amenity"="bistro"](${bbox});
  node["amenity"="ice_cream"](${bbox});
  way["amenity"="ice_cream"](${bbox});
  node["shop"="coffee"](${bbox});
  way["shop"="coffee"](${bbox});
  node["shop"="tea"](${bbox});
  way["shop"="tea"](${bbox});
  node["shop"="pastry"](${bbox});
  way["shop"="pastry"](${bbox});
  node["shop"="bakery"](${bbox});
  way["shop"="bakery"](${bbox});
  node["amenity"~"restaurant|bar"]["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast",i](${bbox});
  way["amenity"~"restaurant|bar"]["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast",i](${bbox});
  node["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|teahouse|pastry|cake|breakfast",i](${bbox});
  way["cuisine"~"coffee_shop|espresso|cappuccino|kaffeehaus|teahouse|pastry|cake|breakfast",i](${bbox});
);
out body;
>;
out body qt;
  `.trim();
}

export async function fetchCafesFromOverpass(): Promise<Cafe[]> {
  const query = buildOverpassQuery();

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    next: { revalidate: 3600 }, // Cache for 1 hour in Next.js
  });

  if (!response.ok) {
    throw new Error(`Overpass API error: ${response.status}`);
  }

  const data: OverpassResponse = await response.json();
  return parseOverpassCafes(data);
}

// Tags that identify a café-type element (as opposed to plain geometry nodes
// or entrance nodes that arrive in the response via `>; out body qt`)
function isCafeElement(tags: Record<string, string>): boolean {
  if (["cafe", "coffee_shop", "bistro", "ice_cream"].includes(tags.amenity ?? "")) return true;
  if (["coffee", "tea", "pastry", "bakery"].includes(tags.shop ?? "")) return true;
  if (/coffee_shop|espresso|cappuccino|kaffeehaus|teahouse|pastry|cake|breakfast/i.test(tags.cuisine ?? "")) return true;
  if (
    /restaurant|bar/i.test(tags.amenity ?? "") &&
    /coffee_shop|espresso|cappuccino|kaffeehaus|cafe|brunch|teahouse|pastry|cake|breakfast/i.test(tags.cuisine ?? "")
  ) return true;
  return false;
}

// For a Way polygon, find the midpoint of the edge that is farthest from the
// polygon's centroid.  This selects the building's most exterior face —
// typically the street-facing facade — without needing any road data.
function streetFacingPoint(
  nodeIds: number[],
  nodeCoords: Map<number, { lat: number; lon: number }>,
  centLat: number,
  centLon: number,
): { lat: number; lon: number } | null {
  const pts = nodeIds
    .map((id) => nodeCoords.get(id))
    .filter((p): p is { lat: number; lon: number } => p !== undefined);

  if (pts.length < 2) return null;

  let bestDist = -1;
  let best: { lat: number; lon: number } | null = null;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const midLat = (a.lat + b.lat) / 2;
    const midLon = (a.lon + b.lon) / 2;
    // Use degree-space distance (equirectangular, fine for <1 km)
    const dist = Math.hypot(midLat - centLat, midLon - centLon);
    if (dist > bestDist) {
      bestDist = dist;
      best = { lat: midLat, lon: midLon };
    }
  }

  return best;
}

function parseOverpassCafes(data: OverpassResponse): Cafe[] {
  // Build lookup tables from constituent nodes returned by `>; out body qt`.
  // These nodes have coordinates; entrance-tagged ones also carry tags.
  const nodeCoords = new Map<number, { lat: number; lon: number }>();
  const entranceNodes = new Set<number>();

  for (const el of data.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
      if (el.tags?.entrance) entranceNodes.add(el.id);
    }
  }

  const seen = new Set<string>();

  return data.elements
    .filter((el) => {
      // Keep only real café-type elements (exclude plain geometry / entrance nodes)
      if (!el.tags || !isCafeElement(el.tags)) return false;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      return lat !== undefined && lon !== undefined;
    })
    .filter((el) => {
      const key = `${el.type}-${el.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((el) => {
      // Start with OSM-provided position (node: direct coords; way: centroid)
      let lat = el.lat ?? el.center!.lat;
      let lon = el.lon ?? el.center!.lon;
      const tags = el.tags ?? {};

      // Refine position for Way elements:
      if (el.type === "way" && el.nodes?.length) {
        // Priority 1 — OSM entrance node (most precise: actual door position)
        const entranceId = el.nodes.find((id) => entranceNodes.has(id));
        if (entranceId) {
          const c = nodeCoords.get(entranceId);
          if (c) { lat = c.lat; lon = c.lon; }
        } else {
          // Priority 2 — midpoint of the most exterior building edge
          // (street-facing facade heuristic, no road data needed)
          const exterior = streetFacingPoint(el.nodes, nodeCoords, lat, lon);
          if (exterior) { lat = exterior.lat; lon = exterior.lon; }
        }
        // Priority 3 — fall through to centroid (already set above)
      }

      const district = guessDistrict(lat, lon);
      const name =
        tags.name ||
        tags["name:de"] ||
        tags["brand"] ||
        `${tags.amenity ?? "Café"} (unbenannt)`;

      const addr = [tags["addr:street"], tags["addr:housenumber"]]
        .filter(Boolean)
        .join(" ");

      return {
        id: `${el.type}-${el.id}`,
        name,
        lat,
        lng: lon,
        address: addr || undefined,
        district,
        tags,
        amenity: tags.amenity,
      } satisfies Cafe;
    });
}

// ── Exact district polygons from OpenStreetMap (simplified via Ramer-Douglas-Peucker) ──
// Polygon vertices are [lat, lng]. Source: OSM relations, fetched 2026-03-18.
const DISTRICT_POLYGONS: Array<{ name: string; ring: [number, number][] }> = [
  {
    name: "1. Bezirk",
    ring: [[48.199953,16.375215],[48.200319,16.376653],[48.204354,16.380963],[48.209078,16.384408],[48.211355,16.384895],[48.211394,16.384507],[48.211815,16.384077],[48.211671,16.381579],[48.211872,16.379039],[48.212578,16.376544],[48.213483,16.375191],[48.216150,16.373211],[48.218489,16.370149],[48.217957,16.369429],[48.213814,16.360418],[48.214341,16.356510],[48.208649,16.355211],[48.207516,16.355489],[48.206908,16.355888],[48.202647,16.361538],[48.200699,16.364924],[48.199850,16.366006],[48.199527,16.365974],[48.200440,16.367607],[48.200705,16.368607],[48.199631,16.373719],[48.199953,16.375215]],
  },
  {
    name: "2. Bezirk",
    ring: [[48.225108,16.367458],[48.225825,16.370372],[48.226172,16.370421],[48.227833,16.372161],[48.229571,16.377519],[48.227914,16.381306],[48.225636,16.383103],[48.226085,16.384700],[48.227832,16.387966],[48.228166,16.388181],[48.229372,16.387915],[48.230368,16.386783],[48.236348,16.398134],[48.229863,16.406061],[48.222110,16.416269],[48.207513,16.436736],[48.182564,16.473845],[48.175352,16.485052],[48.167181,16.498462],[48.165090,16.495228],[48.168852,16.484492],[48.175573,16.467773],[48.188112,16.425100],[48.189347,16.422093],[48.194379,16.413445],[48.196119,16.410865],[48.197211,16.409775],[48.199883,16.407855],[48.200887,16.406658],[48.201583,16.404979],[48.202475,16.400336],[48.203402,16.398374],[48.205046,16.397082],[48.207861,16.396516],[48.209727,16.395653],[48.211249,16.394658],[48.212373,16.393136],[48.213111,16.390395],[48.213118,16.388369],[48.211994,16.385245],[48.211355,16.384895],[48.211394,16.384507],[48.211815,16.384077],[48.211679,16.381065],[48.211959,16.378550],[48.212369,16.377040],[48.213082,16.375668],[48.216150,16.373211],[48.219146,16.369188],[48.220086,16.368354],[48.221555,16.367964],[48.224167,16.367809],[48.225108,16.367458]],
  },
  {
    name: "3. Bezirk",
    ring: [[48.211355,16.384895],[48.211994,16.385245],[48.212842,16.387168],[48.213161,16.388803],[48.212891,16.391533],[48.212063,16.393721],[48.211249,16.394658],[48.208709,16.396199],[48.204419,16.397394],[48.203088,16.398797],[48.202475,16.400336],[48.201583,16.404979],[48.200887,16.406658],[48.199883,16.407855],[48.196546,16.410360],[48.194379,16.413445],[48.189347,16.422093],[48.188112,16.425100],[48.186342,16.431099],[48.185872,16.430780],[48.185979,16.429800],[48.185240,16.428783],[48.185163,16.428264],[48.186311,16.422610],[48.187271,16.420453],[48.185529,16.419739],[48.185868,16.417783],[48.184821,16.416924],[48.185442,16.415042],[48.183165,16.412835],[48.185062,16.406255],[48.184757,16.405704],[48.185690,16.404605],[48.184793,16.402831],[48.183450,16.404148],[48.182547,16.402991],[48.182240,16.403442],[48.181569,16.402708],[48.181803,16.402261],[48.179888,16.400247],[48.178505,16.397739],[48.175376,16.397068],[48.175527,16.395454],[48.179320,16.389959],[48.182917,16.385506],[48.184716,16.384154],[48.186878,16.381672],[48.188118,16.380999],[48.188480,16.381130],[48.191858,16.379206],[48.194653,16.377031],[48.197846,16.375076],[48.199529,16.375447],[48.199953,16.375215],[48.200319,16.376653],[48.204354,16.380963],[48.209078,16.384408],[48.211355,16.384895]],
  },
  {
    name: "4. Bezirk",
    ring: [[48.192160,16.364014],[48.193933,16.361710],[48.194199,16.361992],[48.194880,16.360883],[48.196711,16.359371],[48.197359,16.361694],[48.199682,16.365941],[48.199527,16.365974],[48.200661,16.368288],[48.200665,16.369480],[48.199631,16.373719],[48.199953,16.375215],[48.199529,16.375447],[48.197740,16.375128],[48.194642,16.377038],[48.192012,16.379108],[48.188480,16.381130],[48.188118,16.380999],[48.186079,16.373963],[48.185736,16.373550],[48.185138,16.373561],[48.183835,16.368834],[48.187970,16.364788],[48.190138,16.362173],[48.192160,16.364014]],
  },
  {
    name: "5. Bezirk",
    ring: [[48.196925,16.359193],[48.194880,16.360883],[48.194199,16.361992],[48.193933,16.361710],[48.192160,16.364014],[48.190138,16.362173],[48.187970,16.364788],[48.183835,16.368834],[48.180283,16.357970],[48.179787,16.355757],[48.179221,16.349725],[48.188467,16.341752],[48.188727,16.345408],[48.189982,16.351958],[48.190853,16.353178],[48.192232,16.354204],[48.193108,16.354466],[48.194713,16.354348],[48.195388,16.354708],[48.196283,16.356145],[48.196925,16.359193]],
  },
  {
    name: "6. Bezirk",
    ring: [[48.188467,16.341752],[48.188727,16.345408],[48.189982,16.351958],[48.190853,16.353178],[48.191956,16.354058],[48.193108,16.354466],[48.194858,16.354387],[48.195795,16.355191],[48.196422,16.356606],[48.196925,16.359193],[48.196711,16.359371],[48.197359,16.361694],[48.199850,16.366006],[48.201326,16.364039],[48.202647,16.361538],[48.201192,16.359527],[48.199642,16.353593],[48.197653,16.348198],[48.195847,16.339161],[48.195070,16.339400],[48.194268,16.339191],[48.191352,16.337488],[48.190583,16.337368],[48.188994,16.338187],[48.188315,16.339057],[48.188467,16.341752]],
  },
  {
    name: "7. Bezirk",
    ring: [[48.204193,16.337014],[48.201837,16.337232],[48.195875,16.339241],[48.197653,16.348198],[48.199642,16.353593],[48.201192,16.359527],[48.202647,16.361538],[48.206908,16.355888],[48.206322,16.351593],[48.206405,16.349446],[48.208578,16.338452],[48.206325,16.337017],[48.204193,16.337014]],
  },
  {
    name: "8. Bezirk",
    ring: [[48.215167,16.340870],[48.215362,16.346172],[48.214739,16.355818],[48.214341,16.356510],[48.208649,16.355211],[48.207516,16.355489],[48.206908,16.355888],[48.206322,16.351593],[48.206405,16.349446],[48.208578,16.338452],[48.209428,16.338833],[48.211655,16.339021],[48.215167,16.340870]],
  },
  {
    name: "9. Bezirk",
    ring: [[48.215167,16.340870],[48.217889,16.342352],[48.218479,16.342594],[48.218547,16.342319],[48.221727,16.343629],[48.222808,16.347761],[48.223552,16.348853],[48.229908,16.350408],[48.230456,16.350739],[48.231333,16.352121],[48.232182,16.354066],[48.231907,16.354449],[48.232525,16.355411],[48.233556,16.356009],[48.236125,16.356742],[48.236309,16.361621],[48.234203,16.361132],[48.233261,16.361149],[48.232262,16.361485],[48.228673,16.363503],[48.226167,16.366671],[48.225339,16.367322],[48.224167,16.367809],[48.221555,16.367964],[48.220086,16.368354],[48.218489,16.370149],[48.217957,16.369429],[48.213814,16.360418],[48.214341,16.356510],[48.214739,16.355818],[48.215362,16.346172],[48.215167,16.340870]],
  },
];

/** Ray-casting point-in-polygon test. Polygon vertices are [lat, lng]. */
function pointInDistrict(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Returns the exact Viennese district ("1. Bezirk" … "9. Bezirk") or "Wien". */
function guessDistrict(lat: number, lng: number): string {
  for (const { name, ring } of DISTRICT_POLYGONS) {
    if (pointInDistrict(lat, lng, ring)) return name;
  }
  return "Wien";
}
