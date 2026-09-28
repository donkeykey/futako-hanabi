// Explain why a spot can or cannot see the launches: node scripts/debug-spot.ts <lat> <lon> [eyeAboveGround]
import { readFileSync } from "node:fs";
import { toLocal } from "../src/geo.ts";
import { decodeBuildings } from "../src/buildings-bin.ts";
import { Occluders } from "../src/visibility.ts";
import { pointInPolygon } from "../src/geo.ts";
import type { Building, Terrain } from "../src/types.ts";

const root = new URL("..", import.meta.url).pathname;
const terrain: Terrain = JSON.parse(readFileSync(`${root}data-raw/terrain_5m.json`, "utf8"));
const bin = readFileSync(`${root}public/data/buildings.bin`);
const buildings: Building[] = decodeBuildings(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const site = JSON.parse(readFileSync(`${root}public/data/site.json`, "utf8"));
const occ = new Occluders(buildings, terrain);
const [lat, lon, above = "1.6"] = process.argv.slice(2).map(String);
const [x, y] = toLocal(+lon, +lat);
const g = occ.groundAt(x, y);
const eye = g + +above;
console.log(`spot x=${x.toFixed(0)} y=${y.toFixed(0)} ground=${g.toFixed(1)} eye=${eye.toFixed(1)} inBuilding=${!!occ.buildingAt(x, y)}`);
for (const l of site.launches) {
  for (const h of [120, 220]) {
    const t = [l.x, l.y, l.ground + h];
    const d = Math.hypot(t[0] - x, t[1] - y);
    const n = Math.ceil(d / 6);
    let why = "clear";
    for (let s = 1; s < n; s++) {
      const f = s / n, px = x + (t[0] - x) * f, py = y + (t[1] - y) * f, pz = eye + (t[2] - eye) * f;
      const tg = occ.groundAt(px, py);
      if (tg > pz) { why = `terrain at ${(f * d).toFixed(0)}m: ground ${tg.toFixed(1)} > ray ${pz.toFixed(1)}`; break; }
      const b = buildings.find((b) => b.ground + b.height >= pz && pointInPolygon(px, py, b.ring));
      if (b) { why = `building at ${(f * d).toFixed(0)}m: top ${(b.ground + b.height).toFixed(1)} > ray ${pz.toFixed(1)} (h ${b.height})`; break; }
    }
    console.log(`  ${l.id} +${h}m (${d.toFixed(0)}m away): ${why}`);
  }
}
