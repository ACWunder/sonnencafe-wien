export const DISTRICT_BOUNDS = {
  south: 48.175,
  west: 16.333,
  north: 48.23,
  east: 16.375,
} as const;

export const MAP_CENTER: [number, number] = [
  (DISTRICT_BOUNDS.south + DISTRICT_BOUNDS.north) / 2,
  (DISTRICT_BOUNDS.west + DISTRICT_BOUNDS.east) / 2,
];

export const DEFAULT_SUN_LOCATION = MAP_CENTER;
