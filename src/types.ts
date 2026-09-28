// Shapes of the preprocessed files in public/data (written by scripts/build-data.ts).

export type Side = "tokyo" | "kanagawa";

export type Building = {
  id: string;
  name?: string;
  height: number; // metres above its ground
  ground: number; // ground elevation (m above sea level)
  ring: [number, number][]; // outer footprint in local metres (x east, y north)
  vis?: Record<Side, number>; // 0..1 share of burst points visible from the roof
};

export type Terrain = {
  x0: number; // local x of the first column (m)
  y0: number; // local y of the first row (m)
  step: number; // grid spacing (m)
  nx: number;
  ny: number;
  z: number[]; // row-major elevations (m), rows go north from y0
};

export type Level = {
  label: string; // e.g. "地上", "屋上", "8F"
  eye: number; // eye height above sea level (m)
  vis: Record<Side, number>;
};

export type SpotKind = "park" | "riverbank" | "bridge" | "building" | "station" | "other";
export type Access = "public" | "customers" | "paid" | "restricted";

export type Spot = {
  id: string;
  name: string;
  kind: SpotKind;
  access: Access;
  side: Side; // which bank of the river the spot is on
  lon: number;
  lat: number;
  x: number;
  y: number;
  levels: Level[];
  note: string;
  caution?: string;
  source?: string;
};

export type LaunchArea = {
  id: string;
  side: Side;
  name: string;
  lon: number;
  lat: number;
  x: number;
  y: number;
  ground: number;
};

/** A building computed to have a good view, where the public may be able to go in (shops, hotels, public). */
export type Gem = {
  index: number; // index into buildings.bin
  name: string;
  named: boolean; // false when the name is only an address + usage
  kind: string; // e.g. "商業施設", "飲食店あり"
  places: string[]; // named places inside (from OpenStreetMap)
  address: string;
  lon: number;
  lat: number;
  x: number;
  y: number;
  height: number;
  distance: number; // metres to the nearest launch site
  levels: Level[];
};

export type SiteData = {
  generated: string;
  attribution: string[];
  launches: LaunchArea[];
  spots: Spot[];
  gems: Gem[];
  groundBounds: [number, number, number, number]; // west, north, east, south of the ground overlay
};
