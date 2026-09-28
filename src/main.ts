import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "./style.css";
import { decodeBuildings } from "./buildings-bin.ts";
import { interiorPoint, toLocal, toLonLat } from "./geo.ts";
import type { Access, Building, Gem, Level, Side, SiteData, Spot, Terrain } from "./types.ts";
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
const BASE = import.meta.env.BASE_URL;

// MapLibre finds its worker next to its own module, which breaks once bundled.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const site: SiteData = await (await fetch(`${BASE}data/site.json`)).json();
const targets = burstTargets(site.launches);

// ---------------------------------------------------------------- heavy data, loaded on first use

let world: Promise<{ buildings: Building[]; terrain: Terrain; occ: Occluders }> | null = null;

function loadWorld() {
  world ??= (async () => {
    const [bin, terrain] = await Promise.all([
      fetch(`${BASE}data/buildings.bin`).then((r) => r.arrayBuffer()),
      fetch(`${BASE}data/terrain.json`).then((r) => r.json() as Promise<Terrain>),
    ]);
    const buildings = decodeBuildings(bin);
    return { buildings, terrain, occ: new Occluders(buildings, terrain) };
  })();
  return world;
}

/** Run slow work behind a spinner, after the browser has painted it. */
async function busy<T>(text: string, work: () => Promise<T> | T): Promise<T> {
  $("loading-text").textContent = text;
  $("loading").hidden = false;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    return await work();
  } finally {
    $("loading").hidden = true;
  }
}

function googleMapsUrl(lat: number, lon: number, query?: string) {
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
}
const gmapLink = (url: string, label = "Googleマップで開く") =>
  `<a class="gmap" href="${url}" target="_blank" rel="noopener">📍 ${label}</a>`;

// ---------------------------------------------------------------- scoring

function score(vis: Level["vis"], want: Want): number {
  return want === "both" ? (vis.tokyo + vis.kanagawa) / 2 : vis[want];
}
function bestLevel(levels: Level[], want: Want): Level {
  return levels.reduce((a, b) => (score(b.vis, want) > score(a.vis, want) ? b : a));
}
function bars(vis: Level["vis"]) {
  return `<div class="bars">
    <span>世田谷側</span><div class="bar tokyo"><span style="width:${pct(vis.tokyo)}"></span></div><span>${pct(vis.tokyo)}</span>
    <span>川崎側</span><div class="bar kanagawa"><span style="width:${pct(vis.kanagawa)}"></span></div><span>${pct(vis.kanagawa)}</span>
  </div>`;
}

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
  minZoom: 12,
  pitch: 50,
  bearing: -20,
  maxBounds: [
    [139.55, 35.56],
    [139.705, 35.665],
  ],
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const want = (): Want => $<HTMLSelectElement>("want").value as Want;

function roofColor(w: Want): maplibregl.ExpressionSpecification {
  const v: maplibregl.ExpressionSpecification =
    w === "both" ? ["/", ["+", ["get", "t"], ["get", "k"]], 200] : ["/", ["get", w === "tokyo" ? "t" : "k"], 100];
  return ["interpolate", ["linear"], v, 0, "#8a94a6", 0.6, "#ffd43b", 1, "#e8590c"];
}

map.on("load", () => {
  const [w, n, e, s] = site.groundBounds;
  for (const mode of ["both", "tokyo", "kanagawa"] as const) {
    map.addSource(`ground-${mode}`, {
      type: "image",
      url: `${BASE}data/ground-${mode}.png`,
      coordinates: [
        [w, n],
        [e, n],
        [e, s],
        [w, s],
      ],
    });
    map.addLayer({
      id: `ground-${mode}`,
      type: "raster",
      source: `ground-${mode}`,
      paint: { "raster-opacity": 0.75, "raster-resampling": "nearest" },
      layout: { visibility: mode === "both" ? "visible" : "none" },
    });
  }
  // MapLibre fetches tiles from its worker, so the URL template must be absolute.
  const tileUrl = `${new URL(`${BASE}data/tiles/`, location.href).href}{z}/{x}/{y}.pbf`;
  map.addSource("bldg", { type: "vector", tiles: [tileUrl], minzoom: 14, maxzoom: 16 });
  map.addLayer({
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "bldg",
    "source-layer": "buildings",
    minzoom: 14,
    paint: {
      "fill-extrusion-height": ["get", "h"],
      "fill-extrusion-opacity": 0.88,
      "fill-extrusion-color": roofColor("both"),
    },
  });

  map.on("click", (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["buildings-3d"] })[0];
    if (f) openBuildingPopup(Number(f.properties.i), f.properties as Record<string, number>, e.lngLat);
    else openGroundPopup(e.lngLat);
  });
  map.on("mouseenter", "buildings-3d", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "buildings-3d", () => (map.getCanvas().style.cursor = "crosshair"));
  map.getCanvas().style.cursor = "crosshair";
  applyWant();
});

function applyWant() {
  const w = want();
  if (map.getLayer("buildings-3d")) map.setPaintProperty("buildings-3d", "fill-extrusion-color", roofColor(w));
  const show = $<HTMLInputElement>("show-ground").checked;
  for (const mode of ["both", "tokyo", "kanagawa"]) {
    if (map.getLayer(`ground-${mode}`)) map.setLayoutProperty(`ground-${mode}`, "visibility", show && mode === w ? "visible" : "none");
  }
}
$("show-ground").addEventListener("change", applyWant);

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

// ---------------------------------------------------------------- popups: any building, any point on the ground

let popup: maplibregl.Popup | null = null;
function showPopup(lngLat: maplibregl.LngLatLike, html: HTMLElement) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setDOMContent(html).addTo(map);
}

function openBuildingPopup(index: number, p: Record<string, number>, lngLat: maplibregl.LngLat) {
  const gem = site.gems.find((g) => g.index === index);
  const title = gem ? gem.name : "建物";
  const el = document.createElement("div");
  el.className = "popup";
  el.innerHTML = `
    <h3>${esc(title)}（高さ約${Math.round(p.h)}m・約${Math.max(1, Math.round(p.h / FLOOR))}階建て相当）</h3>
    <div>屋上から見える割合</div>${bars({ tokyo: p.t / 100, kanagawa: p.k / 100 })}
    <p>${gem ? esc(gem.kind) + "。入れる階はお店によります。" : "私有地や屋上には通常立ち入れません。入れる建物か確認してください。"}</p>
    <div class="actions">
      <button type="button">階ごとの見え方を見る</button>
      ${gmapLink(gem ? gemMapUrl(gem) : googleMapsUrl(lngLat.lat, lngLat.lng))}
    </div>`;
  el.querySelector("button")!.addEventListener("click", () => openBuilding(index, title));
  showPopup(lngLat, el);
}

async function openBuilding(index: number, title: string) {
  const { buildings, occ } = await busy("建物データを読み込み中…", loadWorld);
  const b = buildings[index];
  if (!b) return;
  const [x, y] = interiorPoint(b.ring);
  const levels = await busy("階ごとの見え方を計算中…", () => floorLevels(occ, b, x, y));
  history.replaceState(null, "", `#b=${index}`);
  openViewer({ title, sub: "地図上の建物（計算は概算）", x, y, levels });
}

function openGroundPopup(lngLat: maplibregl.LngLat) {
  const el = document.createElement("div");
  el.className = "popup";
  el.innerHTML = `
    <h3>この場所（地上）</h3>
    <div class="ground-vis"><p>見え方を計算中…</p></div>
    <p>道路や線路の上、私有地での立ち止まりはできません。当日の交通規制にも注意してください。</p>
    <div class="actions">
      <button type="button" disabled>ここからの見え方を見る</button>
      ${gmapLink(googleMapsUrl(lngLat.lat, lngLat.lng))}
    </div>`;
  showPopup(lngLat, el);
  const [x, y] = toLocal(lngLat.lng, lngLat.lat);
  loadWorld().then(({ occ }) => {
    const eye = occ.groundAt(x, y) + EYE;
    const level: Level = { label: "地上", eye: Math.round(eye * 10) / 10, vis: visibilityFrom(occ, x, y, eye, targets) };
    el.querySelector(".ground-vis")!.innerHTML = bars(level.vis);
    const btn = el.querySelector("button")!;
    btn.disabled = false;
    btn.addEventListener("click", () => {
      history.replaceState(null, "", `#p=${lngLat.lat.toFixed(6)},${lngLat.lng.toFixed(6)}`);
      openViewer({ title: "地図上の地点（地上）", sub: `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`, x, y, levels: [level] });
    });
  });
}

function floorLevels(occ: Occluders, b: Building, x: number, y: number): Level[] {
  const floors = Math.max(1, Math.round(b.height / FLOOR));
  const picks = new Set<number>([1]);
  const steps = Math.min(5, floors - 1);
  for (let i = 1; i <= steps; i++) picks.add(Math.round(1 + ((floors - 1) * i) / steps));
  const levels: Level[] = [...picks]
    .sort((a, c) => a - c)
    .map((f) => {
      const eye = b.ground + (f - 1) * FLOOR + EYE;
      return { label: `${f}F`, eye: Math.round(eye), vis: visibilityFrom(occ, x, y, eye, targets) };
    });
  const roofEye = b.ground + b.height + EYE;
  levels.push({ label: "屋上", eye: Math.round(roofEye), vis: visibilityFrom(occ, x, y, roofEye, targets) });
  return levels;
}

// ---------------------------------------------------------------- side panel: spots and gems

const onlyOpen = $<HTMLInputElement>("only-open");
let selected: string | null = null;
let tab: "spots" | "gems" = "spots";

for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  t.addEventListener("click", () => setTab(t.dataset.tab as typeof tab));
}
function setTab(next: typeof tab) {
  tab = next;
  for (const t of document.querySelectorAll<HTMLButtonElement>(".tab")) t.classList.toggle("active", t.dataset.tab === tab);
  $("spot-list").hidden = tab !== "spots";
  $("gems-pane").hidden = tab !== "gems";
  onlyOpen.parentElement!.style.visibility = tab === "spots" ? "" : "hidden";
}

function renderLists() {
  const w = want();
  const spots = site.spots
    .filter((s) => !onlyOpen.checked || s.access !== "restricted")
    .map((s) => ({ s, best: bestLevel(s.levels, w) }))
    .sort((a, b) => score(b.best.vis, w) - score(a.best.vis, w));
  $("spot-list").innerHTML = spots
    .map(
      ({ s, best }) => `
      <li data-spot="${s.id}" class="${s.id === selected ? "active" : ""}">
        <span class="spot-name">${esc(s.name)}</span>
        <span class="score">${pct(score(best.vis, w))}</span>
        <span class="spot-meta"><span class="badge ${s.access}">${ACCESS_LABEL[s.access]}</span>${
          s.side === "tokyo" ? "東京側" : "神奈川側"
        }・${best.label}で 世田谷${pct(best.vis.tokyo)} / 川崎${pct(best.vis.kanagawa)}</span>
        <span class="links">${gmapLink(googleMapsUrl(s.lat, s.lon))}</span>
      </li>`,
    )
    .join("");

  const gems = site.gems
    .map((g) => ({ g, best: bestLevel(g.levels, w) }))
    .sort((a, b) => Math.round(score(b.best.vis, w) * 10) - Math.round(score(a.best.vis, w) * 10) || a.g.distance - b.g.distance);
  $("gem-list").innerHTML = gems
    .map(
      ({ g, best }) => `
      <li data-gem="${g.index}" class="${`gem-${g.index}` === selected ? "active" : ""}">
        <span class="spot-name">${esc(g.name)}</span>
        <span class="score">${pct(score(best.vis, w))}</span>
        <span class="spot-meta">${esc(g.kind)}・${esc(g.address)}・打上地点まで約${(g.distance / 1000).toFixed(1)}km<br>${best.label}で 世田谷${pct(
          best.vis.tokyo,
        )} / 川崎${pct(best.vis.kanagawa)}${g.places.length > 1 ? `<br>入っている店: ${esc(g.places.join("、"))}` : ""}</span>
        <span class="links">${gmapLink(gemMapUrl(g))}</span>
      </li>`,
    )
    .join("");

  for (const [id, el] of markers) {
    const s = site.spots.find((x) => x.id === id)!;
    el.style.display = onlyOpen.checked && s.access === "restricted" ? "none" : "";
  }
}

function gemMapUrl(g: Gem) {
  return g.named ? googleMapsUrl(g.lat, g.lon, `${g.name} ${g.address}`) : googleMapsUrl(g.lat, g.lon);
}

for (const list of ["spot-list", "gem-list"]) {
  $(list).addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) return; // let the Google Maps link open
    const li = (e.target as HTMLElement).closest("li");
    if (li?.dataset.spot) selectSpot(li.dataset.spot, true);
    if (li?.dataset.gem) selectGem(Number(li.dataset.gem), true);
  });
}
onlyOpen.addEventListener("change", renderLists);
$("want").addEventListener("change", () => {
  renderLists();
  applyWant();
});

function showDetail(html: string, onView: () => void) {
  const detail = $("detail");
  detail.hidden = false;
  detail.innerHTML = html;
  detail.querySelector("button.view")!.addEventListener("click", onView);
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function selectSpot(id: string, fly: boolean) {
  selected = id;
  const s = site.spots.find((x) => x.id === id)!;
  setTab("spots");
  renderLists();
  if (fly) map.flyTo({ center: [s.lon, s.lat], zoom: 16, pitch: 55 });
  history.replaceState(null, "", `#spot=${id}`);
  showDetail(
    `
    <h2>${esc(s.name)}</h2>
    <div><span class="badge ${s.access}">${ACCESS_LABEL[s.access]}</span>${s.side === "tokyo" ? "東京側" : "神奈川側"}</div>
    <p>${esc(s.note)}</p>
    ${s.caution ? `<p class="caution">⚠️ ${esc(s.caution)}</p>` : ""}
    ${s.levels.map((l) => `<div class="level-row"><h3>${l.label}（目の高さ 標高${l.eye}m）</h3>${bars(l.vis)}</div>`).join("")}
    <button class="view">3Dで見え方を見る</button>
    <div class="links">${gmapLink(googleMapsUrl(s.lat, s.lon))}</div>
    ${s.source ? `<p><small>出典: <a href="${s.source}" target="_blank" rel="noopener">${esc(s.source)}</a></small></p>` : ""}
  `,
    () => openViewer(spotViewpoint(s)),
  );
}

function selectGem(index: number, fly: boolean) {
  selected = `gem-${index}`;
  const g = site.gems.find((x) => x.index === index)!;
  setTab("gems");
  renderLists();
  if (fly) map.flyTo({ center: [g.lon, g.lat], zoom: 16.5, pitch: 55 });
  history.replaceState(null, "", `#gem=${index}`);
  showDetail(
    `
    <h2>${esc(g.name)}</h2>
    <p>${esc(g.kind)}・${esc(g.address)}・高さ約${Math.round(g.height)}m・打上地点まで約${(g.distance / 1000).toFixed(1)}km</p>
    ${g.places.length ? `<p>入っている店・施設: ${esc(g.places.join("、"))}</p>` : ""}
    <p class="caution">入れる階や営業時間はお店によります。住居部分や屋上には入れません。</p>
    ${g.levels.map((l) => `<div class="level-row"><h3>${l.label}（目の高さ 標高${l.eye}m）</h3>${bars(l.vis)}</div>`).join("")}
    <button class="view">3Dで見え方を見る</button>
    <div class="links">${gmapLink(gemMapUrl(g))}</div>
  `,
    () => openGemViewer(g),
  );
}

async function openGemViewer(g: Gem) {
  openViewer({ title: g.name, sub: `${g.kind}・${g.address}`, x: g.x, y: g.y, levels: g.levels });
}

function spotViewpoint(s: Spot): Viewpoint {
  return { title: s.name, sub: `${ACCESS_LABEL[s.access]}・${s.note}`, x: s.x, y: s.y, levels: s.levels };
}

// ---------------------------------------------------------------- 3D viewer

let viewer: SpotViewer | null = null;

async function openViewer(v: Viewpoint) {
  const { buildings, terrain, occ } = await busy("建物データを読み込み中…", loadWorld);
  const exclude = occ.buildingsAt(v.x, v.y); // every part of the building we stand in
  $("viewer-modal").hidden = false;
  viewer ??= new SpotViewer($("viewer"), buildings, terrain);
  $("viewer-title").textContent = v.title;
  const launchOf = (side: Side) => site.launches.find((l) => l.side === side)!;
  const w = want();
  let level = bestLevel(v.levels, w);
  // Face the requested side, or whichever side is easier to see from here.
  let side: Side = w !== "both" ? w : level.vis.tokyo >= level.vis.kanagawa ? "tokyo" : "kanagawa";

  const controls = $("viewer-levels");
  const render = () => {
    viewer!.view(v.x, v.y, level.eye, site.launches, launchOf(side), exclude);
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
  for (const [s, label] of [
    ["tokyo", "世田谷の方を見る"],
    ["kanagawa", "川崎の方を見る"],
  ] as const) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.dataset.side = s;
    btn.addEventListener("click", () => ((side = s), render()));
    controls.append(btn);
  }
  const [lon, lat] = toLonLat(v.x, v.y);
  const gm = document.createElement("a");
  gm.className = "gmap";
  gm.href = googleMapsUrl(lat, lon);
  gm.target = "_blank";
  gm.rel = "noopener";
  gm.textContent = "📍 Googleマップ";
  controls.append(gm);
  await busy("3Dを準備中…", render);
}

function closeViewer() {
  $("viewer-modal").hidden = true;
}
$("viewer-close").addEventListener("click", closeViewer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeViewer();
});

// ---------------------------------------------------------------- footer + shareable links

$("attribution").innerHTML = [
  ...site.attribution,
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  "店名 © OpenStreetMap contributors",
  "見える割合は建物と地形だけで計算（木・看板・人混みは含まない）",
].join(" ／ ");

renderLists();

// #spot=<id> | #gem=<index> | #b=<building index> | #p=<lat>,<lon>, plus &view=1 to open the 3D view
function applyHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const view = params.get("view") === "1";
  const spot = site.spots.find((s) => s.id === params.get("spot"));
  if (spot) {
    selectSpot(spot.id, true);
    if (view) openViewer(spotViewpoint(spot));
    return;
  }
  const gem = site.gems.find((g) => String(g.index) === params.get("gem"));
  if (gem) {
    selectGem(gem.index, true);
    if (view) openGemViewer(gem);
    return;
  }
  if (params.get("b")) {
    openBuilding(Number(params.get("b")), "建物");
    return;
  }
  const p = params.get("p")?.split(",").map(Number);
  if (p?.length === 2) {
    const lngLat = new maplibregl.LngLat(p[1], p[0]);
    map.flyTo({ center: lngLat, zoom: 16 });
    map.once("idle", () => openGroundPopup(lngLat));
  }
}
applyHash();
