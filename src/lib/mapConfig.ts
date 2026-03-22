export const VIENNA_BOUNDS = {
  south: 48.10,
  west:  16.17,
  north: 48.33,
  east:  16.60,
} as const;

export const MAP_CENTER: [number, number] = [48.2093, 16.3728]; // Stephansdom

export const DEFAULT_SUN_LOCATION = MAP_CENTER;

// Zoom level below which café markers are hidden (avoids dot-soup when zoomed out)
export const MIN_MARKER_ZOOM = 12;

// Zoom level below which building tiles are not loaded (viewport too large)
export const MIN_BUILDING_ZOOM = 12;

// Tile dimensions for viewport-based building fetching
export const TILE_LAT = 0.04; // ~4.4 km
export const TILE_LNG = 0.06; // ~4.4 km at lat 48°

// Maximum number of building tiles kept in the LRU cache
export const MAX_TILE_CACHE = 50;
