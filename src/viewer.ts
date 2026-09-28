import * as THREE from "three";
import { FireworksShow, type LaunchSite } from "./fireworks.ts";
import type { Building, LaunchArea, Terrain } from "./types.ts";

// Draw every building within NEAR_RADIUS of the viewer, and only taller ones further away.
const NEAR_RADIUS = 1500;
const FAR_MIN_HEIGHT = 12;

// Local (x east, y north, z up) -> three.js (x east, y up, z south)
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

export class SpotViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 1, 12000);
  private show: FireworksShow;
  private city = new THREE.Group();
  private clock = new THREE.Clock();
  private yaw = 0;
  private pitch = 0.15;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private cityKey = "";
  private container: HTMLElement;
  private buildings: Building[];

  constructor(container: HTMLElement, buildings: Building[], terrain: Terrain) {
    this.container = container;
    this.buildings = buildings;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b1226);
    this.scene.fog = new THREE.Fog(0x0b1226, 2000, 7000);
    this.scene.add(new THREE.HemisphereLight(0x9fb0d8, 0x2a2a33, 1.6));
    const moon = new THREE.DirectionalLight(0xc0ceff, 1.0);
    moon.position.set(-1, 2, 1);
    this.scene.add(moon);

    this.scene.add(terrainMesh(terrain));
    this.scene.add(this.city);
    this.scene.add(skyStars());

    this.show = new FireworksShow([]);
    this.scene.add(this.show.points);

    this.bindLookControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  /**
   * Stand at (x, y) with eyes at `eye` m above sea level, facing the `focus` launch area.
   * `exclude` are the building parts we stand in (their walls would block the view).
   */
  view(x: number, y: number, eye: number, launches: LaunchArea[], focus: LaunchArea, exclude: Building[] = []) {
    // Rebuilding the city mesh is the slow part, so only do it when the standpoint moves.
    const key = `${Math.round(x)},${Math.round(y)}`;
    if (key !== this.cityKey) {
      this.cityKey = key;
      const near = NEAR_RADIUS * NEAR_RADIUS;
      const visible = this.buildings.filter((b) => {
        if (exclude.includes(b)) return false;
        const [bx, by] = b.ring[0];
        return b.height >= FAR_MIN_HEIGHT || (bx - x) ** 2 + (by - y) ** 2 < near;
      });
      for (const m of this.city.children as THREE.Mesh[]) m.geometry.dispose();
      this.city.clear();
      this.city.add(buildingsMesh(visible));
    }

    this.camera.position.copy(v3(x, y, eye));
    const sites: LaunchSite[] = launches.map((l) => ({ id: l.id, position: v3(l.x, l.y, l.ground) }));
    this.show.setSites(sites);

    this.face(focus);
  }

  /** Turn to face a launch area, aiming at a typical burst height. */
  face(focus: LaunchArea) {
    const target = v3(focus.x, focus.y, focus.ground + 170);
    const d = target.clone().sub(this.camera.position);
    this.yaw = Math.atan2(d.x, -d.z);
    // Cap the initial tilt so the horizon stays in frame even right next to the launch site.
    this.pitch = Math.min(Math.atan2(d.y, Math.hypot(d.x, d.z)), 0.42);
    this.applyLook();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    this.show.update(this.clock.getDelta());
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private applyLook() {
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  private bindLookControls() {
    const el = this.renderer.domElement;
    let last: { x: number; y: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!last) return;
      const k = (this.camera.fov * Math.PI) / 180 / this.container.clientHeight;
      this.yaw -= (e.clientX - last.x) * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - last.y) * k, -1.2, 1.4);
      last = { x: e.clientX, y: e.clientY };
      this.applyLook();
    });
    el.addEventListener("pointerup", () => (last = null));
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 15, 90);
        this.camera.updateProjectionMatrix();
      },
      { passive: false },
    );
  }
}

function buildingsMesh(buildings: Building[]): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const wall = new THREE.Color(0x5a6378);
  const roof = new THREE.Color(0x6b7488);
  const lit = new THREE.Color(0xc9a85a);

  for (const b of buildings) {
    const ring = b.ring[0][0] === b.ring.at(-1)![0] && b.ring[0][1] === b.ring.at(-1)![1] ? b.ring.slice(0, -1) : b.ring;
    if (ring.length < 3) continue;
    const z0 = b.ground;
    const z1 = b.ground + b.height;
    // Taller buildings get a warm "lit windows" tint so the skyline reads at night.
    const wallColor = b.height > 25 ? wall.clone().lerp(lit, 0.35) : wall;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % ring.length];
      const quad = [v3(ax, ay, z0), v3(bx, by, z0), v3(bx, by, z1), v3(ax, ay, z0), v3(bx, by, z1), v3(ax, ay, z1)];
      for (const p of quad) {
        positions.push(p.x, p.y, p.z);
        colors.push(wallColor.r, wallColor.g, wallColor.b);
      }
    }
    const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const t of tris) {
      for (const idx of t) {
        const p = v3(ring[idx][0], ring[idx][1], z1);
        positions.push(p.x, p.y, p.z);
        colors.push(roof.r, roof.g, roof.b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
}

function terrainMesh(t: Terrain): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(t.nx * t.ny * 3);
  const colors = new Float32Array(t.nx * t.ny * 3);
  const low = new THREE.Color(0x1d3f66); // riverbed / water
  const high = new THREE.Color(0x2c3d30);
  let minZ = Infinity;
  for (const z of t.z) if (z > -50) minZ = Math.min(minZ, z);
  for (let j = 0; j < t.ny; j++) {
    for (let i = 0; i < t.nx; i++) {
      const k = j * t.nx + i;
      const z = t.z[k] > -50 ? t.z[k] : minZ;
      const p = v3(t.x0 + i * t.step, t.y0 + j * t.step, z);
      positions.set([p.x, p.y, p.z], k * 3);
      const c = low.clone().lerp(high, THREE.MathUtils.clamp((z - minZ) / 8, 0, 1));
      colors.set([c.r, c.g, c.b], k * 3);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < t.ny - 1; j++) {
    for (let i = 0; i < t.nx - 1; i++) {
      const a = j * t.nx + i;
      index.push(a, a + 1, a + t.nx, a + 1, a + t.nx + 1, a + t.nx);
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

function skyStars(): THREE.Points {
  const n = 1500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.random() * Math.PI * 2;
    const u = 0.05 + Math.random() * 0.95;
    const r = 9000;
    pos.set([r * Math.cos(t) * Math.sqrt(1 - u * u), r * u, r * Math.sin(t) * Math.sqrt(1 - u * u)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899bb, size: 1.5, sizeAttenuation: false }));
}
