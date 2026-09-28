// Compact binary encoding of all buildings (used by the 3D viewer and in-browser line-of-sight).
//
// header: "FHB2" (4 bytes) + count (uint32)
// per building: nPoints uint16, height uint16 (dm), ground int16 (dm), visTokyo uint8 (%), visKanagawa uint8 (%),
//               nPoints x (x int16, y int16) in 0.5 m units (local metres, open ring)

import type { Building } from "./types.ts";

const MAGIC = 0x32424846; // "FHB2" little-endian
const UNIT = 0.5;

export function encodeBuildings(buildings: Building[]): Uint8Array {
  let size = 8;
  for (const b of buildings) size += 10 + openRing(b.ring).length * 4;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, buildings.length, true);
  let o = 8;
  for (const b of buildings) {
    const ring = openRing(b.ring);
    v.setUint16(o, ring.length, true);
    v.setUint16(o + 2, Math.min(65535, Math.round(b.height * 10)), true);
    v.setInt16(o + 4, Math.round(b.ground * 10), true);
    v.setUint8(o + 6, Math.round((b.vis?.tokyo ?? 0) * 100));
    v.setUint8(o + 7, Math.round((b.vis?.kanagawa ?? 0) * 100));
    o += 10; // 2 bytes padding keeps points 4-byte aligned
    for (const [x, y] of ring) {
      v.setInt16(o, Math.round(x / UNIT), true);
      v.setInt16(o + 2, Math.round(y / UNIT), true);
      o += 4;
    }
  }
  return new Uint8Array(buf);
}

export function decodeBuildings(buf: ArrayBuffer): Building[] {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== MAGIC) throw new Error("buildings.bin: bad header");
  const count = v.getUint32(4, true);
  const out: Building[] = new Array(count);
  let o = 8;
  for (let i = 0; i < count; i++) {
    const n = v.getUint16(o, true);
    const height = v.getUint16(o + 2, true) / 10;
    const ground = v.getInt16(o + 4, true) / 10;
    const vis = { tokyo: v.getUint8(o + 6) / 100, kanagawa: v.getUint8(o + 7) / 100 };
    o += 10;
    const ring: [number, number][] = new Array(n);
    for (let k = 0; k < n; k++) {
      ring[k] = [v.getInt16(o, true) * UNIT, v.getInt16(o + 2, true) * UNIT];
      o += 4;
    }
    out[i] = { id: String(i), height, ground, ring, vis };
  }
  return out;
}

function openRing(ring: [number, number][]): [number, number][] {
  const a = ring[0];
  const z = ring[ring.length - 1];
  return a[0] === z[0] && a[1] === z[1] ? ring.slice(0, -1) : ring;
}
