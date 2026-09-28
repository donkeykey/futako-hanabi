// Build the app's static data from data-raw/ + scripts/spots.json.
//
//   node scripts/build-data.ts
//
// Outputs (public/data/):
//   site.json              launch areas, viewing spots and "hidden gem" buildings with per-level visibility
//   buildings.bin          every building in local metres (3D viewer + in-browser line of sight)
//   tiles/{z}/{x}/{y}.pbf  vector tiles of buildings with roof visibility (z14: 12 m+ only, z15-16: all)
//   ground-{both,tokyo,kanagawa}.png  ground-level visibility overlay (streets, parks, open ground)
//   terrain.json           20 m elevation grid (3D viewer)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import { encodeBuildings } from "../src/buildings-bin.ts";
import { interiorPoint, toLocal, toLonLat } from "../src/geo.ts";
import type { Building, Gem, LaunchArea, Level, SiteData, Spot, Terrain } from "../src/types.ts";
import { burstTargets, Occluders, visibilityFrom } from "../src/visibility.ts";

const root = new URL("..", import.meta.url).pathname;
const raw = (f: string) => JSON.parse(readFileSync(`${root}data-raw/${f}`, "utf8"));
const outDir = `${root}public/data`;
mkdirSync(outDir, { recursive: true });

const DEFAULT_HEIGHT = 3; // PLATEAU buildings with unknown height
const EYE = 1.6; // eye height above a floor or the ground
const FLOOR = 3.2; // storey height used for floor levels
const GEM_MIN_HEIGHT = 8;
const GEM_MIN_SCORE = 0.7;
const GEM_COUNT = 40;
const GEM_SPACING = 120; // metres between listed gems

// PLATEAU bldg:usage codes for buildings the public can usually enter
// (schools, clinics and offices are left out: they are closed on a Saturday evening)
const PUBLIC_USAGE: Record<string, string> = {
  "402": "商業施設",
  "403": "宿泊施設",
  "404": "商業系複合施設",
};
const POI_KIND: Record<string, string> = {
  restaurant: "飲食店", fast_food: "飲食店", izakaya: "飲食店", cafe: "カフェ", bar: "バー", pub: "居酒屋・バー",
  hotel: "ホテル", hostel: "ホテル", guest_house: "宿", mall: "商業施設", department_store: "百貨店",
  supermarket: "スーパー", community_centre: "公共施設", library: "図書館", townhall: "役所",
};
const MUNI: Record<string, string> = {
  "13110": "目黒区", "13111": "大田区", "13112": "世田谷区", "13219": "狛江市", "14131": "川崎市川崎区",
  "14132": "川崎市幸区", "14133": "川崎市中原区", "14134": "川崎市高津区", "14135": "川崎市多摩区",
  "14136": "川崎市宮前区", "14137": "川崎市麻生区",
};

type Raw = Building & { usage?: string; places: { name: string; kind: string; level?: number }[] };

// ---- load buildings
const t0 = Date.now();
const terrain5: Terrain = raw("terrain_5m.json");
const terrain20: Terrain = raw("terrain_20m.json");
const buildings: Raw[] = [];
for (const f of raw("buildings.geojson").features) {
  const p = f.properties;
  const ring = (f.geometry.coordinates[0] as [number, number][]).map(([lon, lat]) => toLocal(lon, lat));
  const height = p.height ?? DEFAULT_HEIGHT;
  if (height < 3 && polygonArea(ring) < 10) continue; // sheds and other tiny structures
  buildings.push({ id: p.id, name: p.name ?? undefined, usage: p.usage ?? undefined, height, ground: p.ground ?? 0, ring, places: [] });
}
const occ = new Occluders(buildings, terrain5);
for (const b of buildings) if (!b.ground) b.ground = occ.groundAt(b.ring[0][0], b.ring[0][1]);
log(`buildings: ${buildings.length}`);

// ---- attach named places (OpenStreetMap) to the building they are in
const index = new Map(buildings.map((b, i) => [b as Building, i]));
for (const poi of raw("osm_pois.json") as { name: string; kind: string; lat: number; lon: number; level?: string }[]) {
  const [x, y] = toLocal(poi.lon, poi.lat);
  const b = occ.buildingAt(x, y) as Raw | undefined;
  if (!POI_KIND[poi.kind] || ["community_centre", "library", "townhall"].includes(poi.kind)) continue; // closed or not a venue
  const level = poi.level && /^-?\d+$/.test(poi.level) ? Number(poi.level) : undefined;
  if (b && !b.places.some((q) => q.name === poi.name)) b.places.push({ name: poi.name, kind: poi.kind, level });
}

// ---- launches, spots
const input = JSON.parse(readFileSync(`${root}scripts/spots.json`, "utf8"));
const launches: LaunchArea[] = input.launches.map((l: LaunchArea) => {
  const [x, y] = toLocal(l.lon, l.lat);
  return { ...l, x, y, ground: occ.groundAt(x, y) };
});
const targets = burstTargets(launches);
const coarse = burstTargets(launches, true);

const spots: Spot[] = input.spots.map((s: any) => {
  const [x, y] = toLocal(s.lon, s.lat);
  const building = occ.buildingAt(x, y);
  const base = building?.ground ?? occ.groundAt(x, y);
  const defs: { label: string; aboveGround: number }[] = [...(s.levels ?? [])];
  for (const f of s.floors ?? []) defs.push({ label: `${f}F`, aboveGround: (f - 1) * FLOOR });
  if (s.roof && building) defs.push({ label: "屋上", aboveGround: building.height });
  if (!defs.length) defs.push({ label: "地上", aboveGround: 0 });
  const levels = defs.map((d) => level(d.label, x, y, base + d.aboveGround + EYE));
  const { floors: _f, roof: _r, levels: _l, ...rest } = s;
  return { ...rest, x: Math.round(x), y: Math.round(y), levels };
});
for (const s of spots) log(`  ${s.name}: ${s.levels.map((l) => `${l.label} T${pct(l.vis.tokyo)} K${pct(l.vis.kanagawa)}`).join(", ")}`);

// ---- roof visibility of every building (map colouring; coarse targets)
buildings.forEach((b, i) => {
  const [cx, cy] = interiorPoint(b.ring);
  b.vis = visibilityFrom(occ, cx, cy, b.ground + b.height + EYE, coarse, 8);
  if ((i + 1) % 50000 === 0) log(`  roofs ${i + 1}/${buildings.length}`);
});

// ---- hidden gems: publicly enterable buildings with a good view from some floor
const candidates = buildings.filter((b) => b.height >= GEM_MIN_HEIGHT && (PUBLIC_USAGE[b.usage ?? ""] || b.places.length));
log(`gem candidates: ${candidates.length}`);
const scored = candidates
  .filter((b) => Math.max(b.vis!.tokyo, b.vis!.kanagawa) >= 0.5) // quick roof pre-filter
  .map((b) => {
    const [x, y] = interiorPoint(b.ring);
    // Whole commercial buildings and hotels can be visited on any floor; in other buildings (e.g. a flat block with
    // a restaurant downstairs) only the floor the place is on (OSM level, 0 = ground floor), or up to 2F if unknown.
    const allFloors = Math.max(1, Math.round(b.height / FLOOR));
    const placeFloors = b.places.map((p) => (p.level ?? 1) + 1);
    const floors = PUBLIC_USAGE[b.usage ?? ""] ? allFloors : Math.min(allFloors, Math.max(2, ...placeFloors));
    const picks = new Set<number>();
    for (let k = 0; k <= 4; k++) picks.add(Math.max(2, Math.round(2 + ((floors - 2) * k) / 4)));
    const levels = [...picks].filter((f) => f <= floors).sort((a, c) => a - c)
      .map((f) => level(`${f}F`, x, y, b.ground + (f - 1) * FLOOR + EYE));
    const best = Math.max(...levels.map((l) => (l.vis.tokyo + l.vis.kanagawa) / 2));
    const named = b.name || b.places.length ? 1 : 0;
    const near = Math.min(...launches.map((l) => Math.hypot(l.x - x, l.y - y)));
    return { b, x, y, levels, best, named, near };
  })
  .filter((g) => g.best >= GEM_MIN_SCORE)
  // Best view first (in 10% steps), then closer to a launch site (bigger fireworks), then a known name.
  .sort((a, c) => Math.round(c.best * 10) - Math.round(a.best * 10) || Math.round(a.near / 500) - Math.round(c.near / 500) || c.named - a.named || a.near - c.near);

const chosen: typeof scored = [];
for (const g of scored) {
  if (chosen.length >= GEM_COUNT) break;
  if (chosen.some((c) => Math.hypot(c.x - g.x, c.y - g.y) < GEM_SPACING)) continue;
  if (spots.some((s) => Math.hypot(s.x - g.x, s.y - g.y) < 60)) continue; // already a curated spot
  chosen.push(g);
}
const gems: Gem[] = [];
for (const g of chosen) {
  const [lon, lat] = toLonLat(g.x, g.y);
  const places = g.b.places.map((p) => p.name);
  const kind = PUBLIC_USAGE[g.b.usage ?? ""] ?? POI_KIND[g.b.places[0]?.kind] ?? "施設";
  const address = await reverseGeocode(lat, lon);
  gems.push({
    index: index.get(g.b)!,
    name: g.b.name ?? places[0] ?? `${address}の${kind}`,
    named: Boolean(g.b.name ?? places[0]),
    kind,
    places: places.slice(0, 5),
    address,
    lon: round7(lon),
    lat: round7(lat),
    x: Math.round(g.x),
    y: Math.round(g.y),
    height: g.b.height,
    distance: Math.round(g.near / 10) * 10,
    levels: g.levels,
  });
}
for (const g of gems.slice(0, 10)) log(`  gem ${g.name} (${g.kind}, ${g.address}) best ${pct(Math.max(...g.levels.map((l) => (l.vis.tokyo + l.vis.kanagawa) / 2)))}`);

// ---- ground-level visibility (anywhere outside buildings), 25 m grid
const GRID = 25;
const HALF = 5000;
const n = Math.round((2 * HALF) / GRID);
const ground = new Float32Array(n * n * 2).fill(-1); // [tokyo, kanagawa] per cell, -1 = inside a building
for (let j = 0; j < n; j++) {
  const y = HALF - (j + 0.5) * GRID; // row 0 = north edge
  for (let i = 0; i < n; i++) {
    const x = -HALF + (i + 0.5) * GRID;
    if (occ.buildingAt(x, y)) continue;
    const v = visibilityFrom(occ, x, y, occ.groundAt(x, y) + EYE, coarse, 10);
    ground[(j * n + i) * 2] = v.tokyo;
    ground[(j * n + i) * 2 + 1] = v.kanagawa;
  }
  if ((j + 1) % 100 === 0) log(`  ground rows ${j + 1}/${n}`);
}
for (const mode of ["both", "tokyo", "kanagawa"] as const) {
  writeFileSync(`${outDir}/ground-${mode}.png`, groundPng(mode));
}
const [west, north] = toLonLat(-HALF, HALF);
const [east, south] = toLonLat(HALF, -HALF);
const groundBounds = [round7(west), round7(north), round7(east), round7(south)];

// ---- write
const site: SiteData = { generated: new Date().toISOString(), attribution: input.attribution, launches, spots, gems, groundBounds };
writeFileSync(`${outDir}/site.json`, JSON.stringify(site));
writeFileSync(`${outDir}/buildings.bin`, encodeBuildings(buildings));
writeFileSync(
  `${outDir}/terrain.json`,
  JSON.stringify({ ...terrain20, z: terrain20.z.map((z) => Math.round(z * 10) / 10) }),
);
const tileCount = writeTiles();
log(`wrote site.json (${spots.length} spots, ${gems.length} gems), buildings.bin, ${tileCount} tiles, terrain.json`);

// ---- helpers
function level(label: string, x: number, y: number, eye: number): Level {
  const vis = visibilityFrom(occ, x, y, eye, targets);
  return { label, eye: Math.round(eye * 10) / 10, vis: { tokyo: r2(vis.tokyo), kanagawa: r2(vis.kanagawa) } };
}
function lowestGoodFloor(levels: Level[]) {
  const i = levels.findIndex((l) => (l.vis.tokyo + l.vis.kanagawa) / 2 >= GEM_MIN_SCORE);
  return i < 0 ? 99 : parseInt(levels[i].label);
}
function writeTiles(): number {
  rmSync(`${outDir}/tiles`, { recursive: true, force: true });
  const features = buildings.map((b, i) => ({
    type: "Feature" as const,
    properties: { i, h: Math.round(b.height * 10) / 10, t: Math.round(b.vis!.tokyo * 100), k: Math.round(b.vis!.kanagawa * 100) },
    geometry: { type: "Polygon" as const, coordinates: [closed(b.ring).map(([x, y]) => toLonLat(x, y).map(round7))] },
  }));
  const opts = { maxZoom: 16, indexMaxZoom: 16, indexMaxPoints: 0, buffer: 32, tolerance: 1 };
  const all = new (geojsonvt as any)({ type: "FeatureCollection", features }, opts);
  const tall = new (geojsonvt as any)({ type: "FeatureCollection", features: features.filter((f) => f.properties.h >= 12) }, opts);
  let n = 0;
  for (let z = 14; z <= 16; z++) {
    const index = z === 14 ? tall : all;
    const [x0, y0] = tileXY(139.5715, 35.656, z);
    const [x1, y1] = tileXY(139.6835, 35.567, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const tile = index.getTile(z, x, y);
        if (!tile || !tile.features.length) continue;
        mkdirSync(`${outDir}/tiles/${z}/${x}`, { recursive: true });
        writeFileSync(`${outDir}/tiles/${z}/${x}/${y}.pbf`, vtpbf.fromGeojsonVt({ buildings: tile }, { version: 2 }));
        n++;
      }
    }
  }
  return n;
}
// Colour ramp matching the map legend: grey (0) -> yellow (0.6) -> orange (1); transparent when nothing is visible.
function groundPng(mode: "both" | "tokyo" | "kanagawa"): Buffer {
  const stops: [number, number[]][] = [[0, [138, 148, 166]], [0.6, [255, 212, 59]], [1, [232, 89, 12]]];
  const rows: Buffer[] = [];
  for (let j = 0; j < n; j++) {
    const row = Buffer.alloc(1 + n * 4); // filter byte 0 + RGBA
    for (let i = 0; i < n; i++) {
      const t = ground[(j * n + i) * 2];
      const k = ground[(j * n + i) * 2 + 1];
      if (t < 0) continue;
      const v = mode === "both" ? (t + k) / 2 : mode === "tokyo" ? t : k;
      if (v < 0.05) continue;
      const s = v <= 0.6 ? 0 : 1;
      const f = (v - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
      const c = stops[s][1].map((a, q) => Math.round(a + (stops[s + 1][1][q] - a) * f));
      row.set([...c, Math.round(90 + 110 * v)], 1 + i * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return [x, y];
}
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
    const j = await r.json();
    return `${MUNI[j.results.muniCd] ?? ""}${j.results.lv01Nm ?? ""}`;
  } catch {
    return "";
  }
}
function closed(ring: [number, number][]) {
  const [a, z] = [ring[0], ring[ring.length - 1]];
  return a[0] === z[0] && a[1] === z[1] ? ring : [...ring, a];
}
function polygonArea(ring: [number, number][]) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}
function r2(n: number) {
  return Math.round(n * 100) / 100;
}
function round7(n: number) {
  return Math.round(n * 1e7) / 1e7;
}
function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}
function log(msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
}
