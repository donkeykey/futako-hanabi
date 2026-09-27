// Build the app's static data from data-raw/ + scripts/spots.json.
//
//   node scripts/build-data.ts
//
// Outputs (public/data/):
//   site.json           launch areas and viewing spots with per-level visibility
//   buildings.json      all buildings in local metres (3D viewer)
//   map-buildings.json  GeoJSON of taller buildings with roof visibility (map colouring)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { toLocal, toLonLat } from "../src/geo.ts";
import type { Building, LaunchArea, Level, SiteData, Spot, Terrain } from "../src/types.ts";
import { burstTargets, Occluders, visibilityFrom } from "../src/visibility.ts";

const root = new URL("..", import.meta.url).pathname;
const raw = (f: string) => JSON.parse(readFileSync(`${root}data-raw/${f}`, "utf8"));
const out = (f: string, data: unknown) => writeFileSync(`${root}public/data/${f}`, JSON.stringify(data));
mkdirSync(`${root}public/data`, { recursive: true });

const DEFAULT_HEIGHT = 3; // PLATEAU buildings with unknown height
const MAP_MIN_HEIGHT = 10; // buildings coloured on the map
const EYE = 1.6; // eye height above a floor or the ground
const FLOOR = 3.2; // storey height used for floor levels

type SpotInput = Omit<Spot, "x" | "y" | "levels"> & {
  levels?: { label: string; aboveGround: number }[]; // metres above ground, eye height included by us
  floors?: number[]; // shortcut for building floors, e.g. [1, 5, 10]
  roof?: boolean;
};
type Input = { launches: Omit<LaunchArea, "x" | "y" | "ground">[]; spots: SpotInput[]; attribution: string[] };

// ---- load
const terrain5: Terrain = raw("terrain_5m.json");
const terrain20: Terrain = raw("terrain_20m.json");
const geo = raw("buildings.geojson");

const buildings: Building[] = [];
for (const f of geo.features) {
  const ring = (f.geometry.coordinates[0] as [number, number][]).map(([lon, lat]) => {
    const [x, y] = toLocal(lon, lat);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number];
  });
  buildings.push({
    id: f.properties.id,
    name: f.properties.name ?? undefined,
    height: f.properties.height ?? DEFAULT_HEIGHT,
    ground: f.properties.ground ?? 0,
    ring,
  });
}
const occ = new Occluders(buildings, terrain5);
for (const b of buildings) if (!b.ground) b.ground = occ.groundAt(b.ring[0][0], b.ring[0][1]);
console.log(`buildings: ${buildings.length}`);

const input: Input = JSON.parse(readFileSync(`${root}scripts/spots.json`, "utf8"));
const launches: LaunchArea[] = input.launches.map((l) => {
  const [x, y] = toLocal(l.lon, l.lat);
  return { ...l, x, y, ground: occ.groundAt(x, y) };
});
const targets = burstTargets(launches);

// ---- spots
const spots: Spot[] = input.spots.map((s) => {
  const [x, y] = toLocal(s.lon, s.lat);
  const ground = occ.groundAt(x, y);
  const building = occ.buildingAt(x, y);
  const base = building?.ground ?? ground;
  const defs: { label: string; aboveGround: number }[] = [...(s.levels ?? [])];
  for (const f of s.floors ?? []) defs.push({ label: `${f}F`, aboveGround: (f - 1) * FLOOR });
  if (s.roof && building) defs.push({ label: "屋上", aboveGround: building.height });
  if (!defs.length) defs.push({ label: "地上", aboveGround: 0 });
  const levels: Level[] = defs.map((d) => {
    const eye = base + d.aboveGround + EYE;
    return { label: d.label, eye: Math.round(eye * 10) / 10, vis: round(visibilityFrom(occ, x, y, eye, targets)) };
  });
  const { floors: _f, roof: _r, levels: _l, ...rest } = s;
  return { ...rest, x: Math.round(x), y: Math.round(y), levels };
});
for (const s of spots) console.log(`  ${s.name}: ${s.levels.map((l) => `${l.label} T${pct(l.vis.tokyo)} K${pct(l.vis.kanagawa)}`).join(", ")}`);

// ---- roof visibility of taller buildings (map colouring)
const tall = buildings.filter((b) => b.height >= MAP_MIN_HEIGHT);
let done = 0;
for (const b of tall) {
  const [cx, cy] = centroid(b.ring);
  b.vis = round(visibilityFrom(occ, cx, cy, b.ground + b.height + EYE, targets));
  if (++done % 1000 === 0) console.log(`  roofs ${done}/${tall.length}`);
}

const mapBuildings = {
  type: "FeatureCollection",
  features: tall.map((b) => ({
    type: "Feature",
    properties: {
      id: b.id,
      name: b.name ?? null,
      height: b.height,
      floors: Math.max(1, Math.round(b.height / FLOOR)),
      tokyo: b.vis!.tokyo,
      kanagawa: b.vis!.kanagawa,
      best: Math.max(b.vis!.tokyo, b.vis!.kanagawa),
    },
    geometry: { type: "Polygon", coordinates: [b.ring.map(([x, y]) => toLonLat(x, y).map((v) => Math.round(v * 1e7) / 1e7))] },
  })),
};

// ---- write
const site: SiteData = { generated: new Date().toISOString(), attribution: input.attribution, launches, spots };
out("site.json", site);
out("buildings.json", buildings.map(({ vis: _v, name: _n, ...b }) => ({ ...b, ring: b.ring.map(([x, y]) => [Math.round(x), Math.round(y)]) })));
out("map-buildings.json", mapBuildings);
out("terrain.json", terrain20);
console.log(`wrote site.json (${spots.length} spots), buildings.json, map-buildings.json (${tall.length}), terrain.json`);

// ---- helpers
function round(v: Record<string, number>) {
  return Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n * 100) / 100])) as Level["vis"];
}
function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}
function centroid(ring: [number, number][]): [number, number] {
  const n = ring.length;
  return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
}
