# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""Sample GSI elevation tiles (T.P. metres, bare earth) onto a regular local grid.

DEM5A (5 m, z15) is used first; river surface and other gaps fall back to DEM10B (10 m, z14).

    uv run scripts/fetch_dem.py   ->  data-raw/terrain_5m.json, data-raw/terrain_20m.json

Source: 国土地理院 標高タイル (https://maps.gsi.go.jp/development/ichiran.html)
"""

import io
import json
import math
import urllib.request
from functools import lru_cache
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data-raw"
ORIGIN = (35.6115, 139.6275)  # lat, lon (must match src/geo.ts)
HALF = 2400  # metres from origin to grid edge
EARTH_RADIUS = 6378137
M_PER_DEG_LAT = EARTH_RADIUS * math.pi / 180
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(ORIGIN[0]))
LAYERS = [("dem5a_png", 15), ("dem_png", 14)]


@lru_cache(maxsize=None)
def tile(layer: str, z: int, x: int, y: int):
    url = f"https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.png"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB").load()
    except urllib.error.HTTPError:
        return None


def elevation(lat: float, lon: float) -> float | None:
    for layer, z in LAYERS:
        n = 2**z
        px = (lon + 180) / 360 * n * 256
        py = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n * 256
        img = tile(layer, z, int(px // 256), int(py // 256))
        if img is None:
            continue
        r, g, b = img[int(px % 256), int(py % 256)]
        v = (r << 16) | (g << 8) | b
        if v == 1 << 23:  # no data
            continue
        return round((v - (1 << 24) if v > 1 << 23 else v) * 0.01, 2)
    return None


def grid(step: float) -> dict:
    n = int(2 * HALF / step) + 1
    z = []
    for j in range(n):
        y = -HALF + j * step
        lat = ORIGIN[0] + y / M_PER_DEG_LAT
        for i in range(n):
            x = -HALF + i * step
            lon = ORIGIN[1] + x / M_PER_DEG_LON
            e = elevation(lat, lon)
            z.append(e if e is not None else -9999)
    return {"x0": -HALF, "y0": -HALF, "step": step, "nx": n, "ny": n, "z": z}


def main():
    RAW.mkdir(exist_ok=True)
    for step in (5, 20):
        g = grid(step)
        missing = sum(1 for v in g["z"] if v == -9999)
        (RAW / f"terrain_{step}m.json").write_text(json.dumps(g, separators=(",", ":")))
        print(f"terrain {step} m: {g['nx']}x{g['ny']}, missing {missing}")


if __name__ == "__main__":
    main()
