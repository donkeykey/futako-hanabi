// Line-of-sight checks between a viewer and firework burst points,
// against building volumes (extruded footprints) and the terrain grid.

import { pointInPolygon } from "./geo.ts";
import type { Building, LaunchArea, Side, Terrain } from "./types.ts";

type Box = { b: Building; minX: number; minY: number; maxX: number; maxY: number; top: number };

export class Occluders {
  private cells = new Map<string, Box[]>();
  private terrain: Terrain;
  private cellSize: number;

  constructor(buildings: Building[], terrain: Terrain, cellSize = 50) {
    this.terrain = terrain;
    this.cellSize = cellSize;
    for (const b of buildings) {
      const xs = b.ring.map((p) => p[0]);
      const ys = b.ring.map((p) => p[1]);
      const box: Box = {
        b,
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        top: b.ground + b.height,
      };
      for (let cx = Math.floor(box.minX / cellSize); cx <= Math.floor(box.maxX / cellSize); cx++) {
        for (let cy = Math.floor(box.minY / cellSize); cy <= Math.floor(box.maxY / cellSize); cy++) {
          const key = `${cx},${cy}`;
          (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(box);
        }
      }
    }
  }

  groundAt(x: number, y: number): number {
    const t = this.terrain;
    const fi = (x - t.x0) / t.step;
    const fj = (y - t.y0) / t.step;
    const i = Math.max(0, Math.min(t.nx - 2, Math.floor(fi)));
    const j = Math.max(0, Math.min(t.ny - 2, Math.floor(fj)));
    const u = Math.max(0, Math.min(1, fi - i));
    const v = Math.max(0, Math.min(1, fj - j));
    const z = (a: number, b: number) => {
      const val = t.z[b * t.nx + a];
      return val > -50 ? val : 0;
    };
    return (
      z(i, j) * (1 - u) * (1 - v) + z(i + 1, j) * u * (1 - v) + z(i, j + 1) * (1 - u) * v + z(i + 1, j + 1) * u * v
    );
  }

  /** Building that contains (x, y), if any. */
  buildingAt(x: number, y: number): Building | undefined {
    const cell = this.cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`) ?? [];
    return cell.find((c) => x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY && pointInPolygon(x, y, c.b.ring))
      ?.b;
  }

  /** True if the straight line from `from` to `to` (x, y, z) is not blocked. `ignore` is the viewer's own building. */
  clear(from: [number, number, number], to: [number, number, number], ignore?: Building, step = 6): boolean {
    const [x0, y0, z0] = from;
    const [x1, y1, z1] = to;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let s = 1; s < n; s++) {
      const f = s / n;
      const x = x0 + (x1 - x0) * f;
      const y = y0 + (y1 - y0) * f;
      const z = z0 + (z1 - z0) * f;
      if (this.groundAt(x, y) > z) return false;
      const cell = this.cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`);
      if (!cell) continue;
      for (const c of cell) {
        if (c.b === ignore || c.top < z) continue;
        if (x < c.minX || x > c.maxX || y < c.minY || y > c.maxY) continue;
        if (pointInPolygon(x, y, c.b.ring)) return false;
      }
    }
    return true;
  }
}

/** Burst points a viewer should see: several positions over each launch area at typical burst heights. */
export function burstTargets(launches: LaunchArea[]): { side: Side; p: [number, number, number] }[] {
  const heights = [120, 160, 190, 220]; // 3号-6号 burst heights (m above the launch site)
  const offsets: [number, number][] = [
    [0, 0],
    [-80, 0],
    [80, 0],
    [0, -80],
    [0, 80],
  ];
  const out: { side: Side; p: [number, number, number] }[] = [];
  for (const l of launches) {
    for (const h of heights) {
      for (const [dx, dy] of offsets) out.push({ side: l.side, p: [l.x + dx, l.y + dy, l.ground + h] });
    }
  }
  return out;
}

/** Share (0..1) of each side's burst points visible from a viewpoint. */
export function visibilityFrom(
  occ: Occluders,
  x: number,
  y: number,
  eye: number,
  targets: ReturnType<typeof burstTargets>,
): Record<Side, number> {
  const ignore = occ.buildingAt(x, y);
  const count = { tokyo: 0, kanagawa: 0 };
  const seen = { tokyo: 0, kanagawa: 0 };
  for (const t of targets) {
    count[t.side]++;
    if (occ.clear([x, y, eye], t.p, ignore)) seen[t.side]++;
  }
  return {
    tokyo: count.tokyo ? seen.tokyo / count.tokyo : 0,
    kanagawa: count.kanagawa ? seen.kanagawa / count.kanagawa : 0,
  };
}
