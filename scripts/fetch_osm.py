# /// script
# requires-python = ">=3.10"
# ///
"""Fetch named places people can actually enter (restaurants, cafes, hotels, malls, public buildings)
from OpenStreetMap, to name PLATEAU buildings and find publicly accessible "hidden gem" buildings.

    uv run scripts/fetch_osm.py   ->  data-raw/osm_pois.json

Source: © OpenStreetMap contributors (ODbL)
"""

import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CENTER = (35.6115, 139.6275)
RADIUS_M = 5000

FILTERS = [
    '["amenity"~"^(restaurant|cafe|bar|pub|fast_food|izakaya|community_centre|library|townhall)$"]',
    '["tourism"~"^(hotel|hostel|guest_house)$"]',
    '["shop"~"^(mall|department_store|supermarket)$"]',
    '["building"~"^(commercial|retail|hotel|office|public|civic)$"]["name"]',
]


def main():
    around = f"(around:{RADIUS_M},{CENTER[0]},{CENTER[1]})"
    body = "".join(f"nwr{f}[\"name\"]{around};" for f in FILTERS)
    query = f"[out:json][timeout:120];({body});out center tags;"
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "futako-hanabi (https://github.com/donkeykey/futako-hanabi)"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        elements = json.load(r)["elements"]

    pois = []
    for e in elements:
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        t = e.get("tags", {})
        if lat is None or not t.get("name"):
            continue
        kind = t.get("amenity") or t.get("tourism") or t.get("shop") or t.get("building")
        pois.append({"name": t["name"], "kind": kind, "lat": lat, "lon": lon, "level": t.get("level"),
                     "osm": f"{e['type']}/{e['id']}"})
    out = ROOT / "data-raw" / "osm_pois.json"
    out.write_text(json.dumps(pois, ensure_ascii=False, indent=0))
    print(f"{len(pois)} named places -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
