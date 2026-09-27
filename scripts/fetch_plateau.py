# /// script
# requires-python = ">=3.10"
# ///
"""Fetch PLATEAU building footprints + heights around Futako-Tamagawa.

Pulls only the per-mesh building CityGML files out of the official PLATEAU ZIPs
(HTTP range requests, ~27 MB instead of ~2.8 GB), converts them to GeoJSON.

    uv run scripts/fetch_plateau.py      ->  data-raw/buildings.geojson

Source: 3D都市モデル（Project PLATEAU）世田谷区（2025年度）・川崎市（2022年度）（国土交通省）
"""

import io
import json
import math
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
CENTER = (35.6115, 139.6275)  # lat, lon
RADIUS_M = 2200

CITIES = {
    "13112": {
        "zip": "https://assets.cms.plateau.reearth.io/assets/4d/e9ecc6-42d0-47ad-84a7-93d07c7766a8/13112_setagaya-ku_pref_2025_citygml_1_op.zip",
        "meshes": ["53393438", "53393439", "53393448", "53393449", "53393458", "53393459", "53393511",
                   "53393520", "53393521", "53393530", "53393531", "53393540", "53393541", "53393550", "53393551"],
    },
    "14130": {
        "zip": "https://assets.cms.plateau.reearth.io/assets/40/25bd0a-f174-4f55-a9bd-0e6868ece0ae/14130_kawasaki-shi_city_2022_citygml_4_op.zip",
        "meshes": ["53393418", "53393419", "53393428", "53393429", "53393438", "53393439", "53393510",
                   "53393511", "53393520"],
    },
}

NS = {"bldg": "http://www.opengis.net/citygml/building/2.0", "gml": "http://www.opengis.net/gml"}
B = "{%s}" % NS["bldg"]


class HttpFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests (enough for zipfile)."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size:
            return 0
        end = min(self.pos + len(buf), self.size) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        with urllib.request.urlopen(req) as r:
            data = r.read()
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)


def download(city: str) -> list[Path]:
    info = CITIES[city]
    out_dir = RAW / "gml" / city  # per city: meshes 53393438/39 exist in both cities
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = {f"udx/bldg/{m}_bldg_6697_op.gml" for m in info["meshes"]}
    paths = []
    with zipfile.ZipFile(io.BufferedReader(HttpFile(info["zip"]), buffer_size=1 << 20)) as z:
        for name in z.namelist():
            if not any(name.endswith(w) for w in wanted):
                continue
            path = out_dir / Path(name).name
            if not path.exists():
                print(f"  {city} {path.name}", flush=True)
                path.write_bytes(z.read(name))
            paths.append(path)
    return paths


def local_dist(lat, lon):
    dy = (lat - CENTER[0]) * 111320
    dx = (lon - CENTER[1]) * 111320 * math.cos(math.radians(CENTER[0]))
    return math.hypot(dx, dy)


def convert(paths: list[Path]) -> list[dict]:
    feats = []
    for fn in paths:
        for _, el in ET.iterparse(fn):
            if el.tag != B + "Building":
                continue
            ring = None
            for tag in ("bldg:lod0RoofEdge", "bldg:lod0FootPrint"):
                p = el.find(tag + "//gml:posList", NS)
                if p is not None:
                    ring = p.text.split()
                    break
            if ring is None:
                el.clear()
                continue
            coords = [[round(float(ring[i + 1]), 7), round(float(ring[i]), 7)] for i in range(0, len(ring), 3)]
            lat, lon = coords[0][1], coords[0][0]
            if local_dist(lat, lon) > RADIUS_M:
                el.clear()
                continue

            zs = [float(v) for p in el.findall("bldg:lod1Solid//gml:posList", NS) for v in p.text.split()[2::3]]
            ground = min(zs) if zs else None
            top = max(zs) if zs else None
            h_el = el.find("bldg:measuredHeight", NS)
            height = float(h_el.text) if h_el is not None and h_el.text else None
            if height is not None and height <= 0:  # Kawasaki uses -9999 for unknown
                height = None
            storeys_el = el.find("bldg:storeysAboveGround", NS)
            storeys = int(storeys_el.text) if storeys_el is not None and storeys_el.text not in (None, "9999") else None
            if height is None and storeys:
                height = storeys * 3.2
            if height is None and ground is not None and top is not None and top - ground > 3.01:
                height = top - ground
            name_el = el.find("gml:name", NS)
            feats.append({
                "type": "Feature",
                "properties": {
                    "id": el.get("{%s}id" % NS["gml"]),
                    "name": name_el.text if name_el is not None else None,
                    "height": round(height, 1) if height else None,
                    "storeys": storeys,
                    "ground": round(ground, 2) if ground is not None else None,
                },
                "geometry": {"type": "Polygon", "coordinates": [coords]},
            })
            el.clear()
    return feats


def main():
    paths = []
    for city in CITIES:
        print(f"download {city}", flush=True)
        paths += download(city)
    feats = convert(paths)
    out = RAW / "buildings.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))
    with_h = sum(1 for f in feats if f["properties"]["height"])
    print(f"{len(feats)} buildings ({with_h} with height) -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
