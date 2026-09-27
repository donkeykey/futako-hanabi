import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { toLocal } from "./geo.ts";
import type { Access, Building, Level, Side, SiteData, Spot, Terrain } from "./types.ts";
import { SpotViewer } from "./viewer.ts";
import { burstTargets, Occluders, visibilityFrom } from "./visibility.ts";

type Want = "both" | "tokyo" | "kanagawa";
type Viewpoint = { title: string; sub: string; x: number; y: number; levels: Level[] };

const ACCESS_LABEL: Record<Access, string> = {
  public: "無料",
  customers: "店舗・ホテル",
  paid: "有料席",
  restricted: "当日立入不可",
};
const FLOOR = 3.2;
const EYE = 1.6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const [site, buildings, terrain] = await Promise.all([
  loadJson<SiteData>("site.json"),
  loadJson<Building[]>("buildings.json"),
  loadJson<Terrain>("terrain.json"),
]);

let occluders: Occluders | null = null;
const occ = () => (occluders ??= new Occluders(buildings, terrain));
const targets = burstTargets(site.launches);

// ---------------------------------------------------------------- scoring

function score(vis: Level["vis"], want: Want): number {
  return want === "both" ? (vis.tokyo + vis.kanagawa) / 2 : vis[want];
}
function bestLevel(levels: Level[], want: Want): Level {
  return levels.reduce((a, b) => (score(b.vis, want) > score(a.vis, want) ? b : a));
}
const pct = (n: number) => `${Math.round(n * 100)}%`;

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      gsi: {
        type: "raster",
        tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
      },
    },
    layers: [{ id: "gsi", type: "raster", source: "gsi" }],
  },
  center: [139.6245, 35.6095],
  zoom: 14.6,
  pitch: 50,
  bearing: -20,
  maxBounds: [
    [139.585, 35.585],
    [139.67, 35.64],
  ],
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

map.on("load", () => {
  map.addSource("buildings", { type: "geojson", data: `${import.meta.env.BASE_URL}data/map-buildings.json` });
  map.addLayer({
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "buildings",
    paint: {
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 0.88,
      "fill-extrusion-color": colorExpr("both"),
    },
  });

  map.on("click", "buildings-3d", (e) => {
    const f = e.features?.[0];
    if (f) openBuildingPopup(f.properties as Record<string, unknown>, e.lngLat);
  });
  map.on("mouseenter", "buildings-3d", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "buildings-3d", () => (map.getCanvas().style.cursor = ""));
});

function colorExpr(want: Want): maplibregl.ExpressionSpecification {
  const value: maplibregl.ExpressionSpecification =
    want === "both" ? ["/", ["+", ["get", "tokyo"], ["get", "kanagawa"]], 2] : ["get", want];
  return ["interpolate", ["linear"], value, 0, "#8a94a6", 0.6, "#ffd43b", 1, "#e8590c"];
}

for (const l of site.launches) {
  const el = document.createElement("div");
  el.className = "launch-marker";
  el.textContent = "🎆";
  el.title = l.name;
  new maplibregl.Marker({ element: el }).setLngLat([l.lon, l.lat]).setPopup(new maplibregl.Popup().setText(l.name)).addTo(map);
}

const markers = new Map<string, HTMLElement>();
for (const s of site.spots) {
  const el = document.createElement("div");
  el.className = `marker ${s.access}`;
  el.title = s.name;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectSpot(s.id, true);
  });
  new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map);
  markers.set(s.id, el);
}

// ---------------------------------------------------------------- list + detail

const onlyOpen = $<HTMLInputElement>("only-open");
const wantSel = $<HTMLSelectElement>("want");
let selected: string | null = null;

function want(): Want {
  return wantSel.value as Want;
}

function renderList() {
  const w = want();
  const list = site.spots
    .filter((s) => !onlyOpen.checked || s.access !== "restricted")
    .map((s) => ({ s, best: bestLevel(s.levels, w) }))
    .sort((a, b) => score(b.best.vis, w) - score(a.best.vis, w));
  $("spot-list").innerHTML = list
    .map(
      ({ s, best }) => `
      <li data-id="${s.id}" class="${s.id === selected ? "active" : ""}">
        <span class="spot-name">${s.name}</span>
        <span class="score">${pct(score(best.vis, w))}</span>
        <span class="spot-meta"><span class="badge ${s.access}">${ACCESS_LABEL[s.access]}</span>${
          s.side === "tokyo" ? "東京側" : "神奈川側"
        }・${best.label}で 世田谷${pct(best.vis.tokyo)} / 川崎${pct(best.vis.kanagawa)}</span>
      </li>`,
    )
    .join("");
  for (const [id, el] of markers) {
    const s = site.spots.find((x) => x.id === id)!;
    el.style.display = onlyOpen.checked && s.access === "restricted" ? "none" : "";
  }
  if (map.getLayer("buildings-3d")) map.setPaintProperty("buildings-3d", "fill-extrusion-color", colorExpr(w));
}

$("spot-list").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (li?.dataset.id) selectSpot(li.dataset.id, true);
});
onlyOpen.addEventListener("change", renderList);
wantSel.addEventListener("change", () => {
  renderList();
  if (selected) selectSpot(selected, false);
});

function bars(vis: Level["vis"]) {
  return `<div class="bars">
    <span>世田谷側</span><div class="bar tokyo"><span style="width:${pct(vis.tokyo)}"></span></div><span>${pct(vis.tokyo)}</span>
    <span>川崎側</span><div class="bar kanagawa"><span style="width:${pct(vis.kanagawa)}"></span></div><span>${pct(vis.kanagawa)}</span>
  </div>`;
}

function selectSpot(id: string, fly: boolean) {
  selected = id;
  const s = site.spots.find((x) => x.id === id)!;
  renderList();
  if (fly) map.flyTo({ center: [s.lon, s.lat], zoom: 16, pitch: 55 });
  const detail = $("detail");
  detail.hidden = false;
  detail.innerHTML = `
    <h2>${s.name}</h2>
    <div><span class="badge ${s.access}">${ACCESS_LABEL[s.access]}</span>${s.side === "tokyo" ? "東京側" : "神奈川側"}</div>
    <p>${s.note}</p>
    ${s.caution ? `<p class="caution">⚠️ ${s.caution}</p>` : ""}
    ${s.levels.map((l) => `<div class="level-row"><h3>${l.label}（目の高さ 標高${l.eye}m）</h3>${bars(l.vis)}</div>`).join("")}
    <button class="view">3Dで見え方を見る</button>
    ${s.source ? `<p><small>出典: <a href="${s.source}" target="_blank" rel="noopener">${s.source}</a></small></p>` : ""}
  `;
  detail.querySelector("button.view")!.addEventListener("click", () => openViewer(spotViewpoint(s)));
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function spotViewpoint(s: Spot): Viewpoint {
  return { title: s.name, sub: `${ACCESS_LABEL[s.access]}・${s.note}`, x: s.x, y: s.y, levels: s.levels };
}

// ---------------------------------------------------------------- any building on the map

function openBuildingPopup(p: Record<string, unknown>, lngLat: maplibregl.LngLat) {
  const height = Number(p.height);
  const floors = Number(p.floors);
  const vis = { tokyo: Number(p.tokyo), kanagawa: Number(p.kanagawa) };
  const html = document.createElement("div");
  html.className = "building-popup";
  html.innerHTML = `
    <h3>${p.name && p.name !== "null" ? p.name : "建物"}（高さ約${Math.round(height)}m・約${floors}階相当）</h3>
    <div>屋上から見える割合</div>${bars(vis)}
    <p><small>私有地・屋上は通常立ち入れません。店舗やホテルなど、入れる場所か確認してください。</small></p>
    <button>階ごとの見え方を見る</button>`;
  html.querySelector("button")!.addEventListener("click", () => {
    const [x, y] = toLocal(lngLat.lng, lngLat.lat);
    const b = occ().buildingAt(x, y);
    if (!b) return;
    const [cx, cy] = [b.ring.reduce((s, q) => s + q[0], 0) / b.ring.length, b.ring.reduce((s, q) => s + q[1], 0) / b.ring.length];
    openViewer({ title: html.querySelector("h3")!.textContent!, sub: "地図上の建物（計算は概算）", x: cx, y: cy, levels: floorLevels(b, cx, cy) });
  });
  new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(lngLat).setDOMContent(html).addTo(map);
}

function floorLevels(b: Building, x: number, y: number): Level[] {
  const floors = Math.max(1, Math.round(b.height / FLOOR));
  const picks = new Set<number>([1]);
  const steps = Math.min(5, floors - 1);
  for (let i = 1; i <= steps; i++) picks.add(Math.round(1 + ((floors - 1) * i) / steps));
  const levels: Level[] = [...picks].sort((a, c) => a - c).map((f) => {
    const eye = b.ground + (f - 1) * FLOOR + EYE;
    return { label: `${f}F`, eye: Math.round(eye), vis: visibilityFrom(occ(), x, y, eye, targets) };
  });
  const roofEye = b.ground + b.height + EYE;
  levels.push({ label: "屋上", eye: Math.round(roofEye), vis: visibilityFrom(occ(), x, y, roofEye, targets) });
  return levels;
}

// ---------------------------------------------------------------- 3D viewer

let viewer: SpotViewer | null = null;

function openViewer(v: Viewpoint) {
  const modal = $("viewer-modal");
  modal.hidden = false;
  viewer ??= new SpotViewer($("viewer"), buildings, terrain);
  $("viewer-title").textContent = v.title;
  const launchOf = (side: Side) => site.launches.find((l) => l.side === side)!;
  const w = want();
  let level = bestLevel(v.levels, w);
  // Face the requested side, or whichever side is easier to see from here.
  let side: Side = w !== "both" ? w : level.vis.tokyo >= level.vis.kanagawa ? "tokyo" : "kanagawa";

  const controls = $("viewer-levels");
  const render = () => {
    viewer!.view(v.x, v.y, level.eye, site.launches, launchOf(side));
    $("viewer-sub").textContent = `${level.label}（標高${level.eye}m）から ／ 世田谷側 ${pct(level.vis.tokyo)}・川崎側 ${pct(level.vis.kanagawa)} が見える計算`;
    for (const b of controls.querySelectorAll<HTMLButtonElement>("button")) {
      b.classList.toggle("active", b.dataset.level === level.label || b.dataset.side === side);
    }
  };
  controls.innerHTML = "";
  for (const l of v.levels) {
    const btn = document.createElement("button");
    btn.textContent = l.label;
    btn.dataset.level = l.label;
    btn.addEventListener("click", () => ((level = l), render()));
    controls.append(btn);
  }
  for (const [s, label] of [["tokyo", "世田谷の方を見る"], ["kanagawa", "川崎の方を見る"]] as const) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.dataset.side = s;
    btn.addEventListener("click", () => ((side = s), render()));
    controls.append(btn);
  }
  render();
}

$("viewer-close").addEventListener("click", () => ($("viewer-modal").hidden = true));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("viewer-modal").hidden = true;
});

// ---------------------------------------------------------------- footer

$("attribution").innerHTML = [
  ...site.attribution,
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  "見える割合は建物と地形だけで計算（木・看板・人混みは含まない）",
].join(" ／ ");

renderList();

// Shareable links: #spot=<id> selects a spot, #spot=<id>&view=1 opens its 3D view.
function applyHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const spot = site.spots.find((s) => s.id === params.get("spot"));
  if (!spot) return;
  selectSpot(spot.id, true);
  if (params.get("view") === "1") openViewer(spotViewpoint(spot));
}
window.addEventListener("hashchange", applyHash);
applyHash();
