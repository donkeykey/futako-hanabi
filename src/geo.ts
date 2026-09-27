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

export function pointInPolygon(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
