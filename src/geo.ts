// Local metric coordinates around the festival area.
// x = metres east, y = metres north of ORIGIN, z = metres above sea level.
// An equirectangular projection is accurate to well under 1 m within the ~3 km area we use.

export const ORIGIN = { lon: 139.6275, lat: 35.6115 };

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS * DEG;
const M_PER_DEG_LON = EARTH_RADIUS * DEG * Math.cos(ORIGIN.lat * DEG);

export function toLocal(lon: number, lat: number): [number, number] {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, (lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

export function toLonLat(x: number, y: number): [number, number] {
  return [ORIGIN.lon + x / M_PER_DEG_LON, ORIGIN.lat + y / M_PER_DEG_LAT];
}

/** Centroid if it is inside the footprint (true for most buildings), otherwise the nearest inside point on a grid. */
export function interiorPoint(ring: [number, number][]): [number, number] {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  if (pointInPolygon(cx, cy, ring)) return [cx, cy];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best: [number, number] = ring[0];
  let bestD = Infinity;
  for (let i = 1; i < 12; i++) {
    for (let j = 1; j < 12; j++) {
      const x = x0 + ((x1 - x0) * i) / 12;
      const y = y0 + ((y1 - y0) * j) / 12;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD && pointInPolygon(x, y, ring)) [best, bestD] = [[x, y], d];
    }
  }
  return best;
}

export function pointInPolygon(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
