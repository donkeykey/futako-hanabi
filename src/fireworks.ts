import * as THREE from "three";

// Three.js axes used across the app: x = east, y = up, z = south (so -z is north).

export type Shell = { name: string; burstHeight: number; burstRadius: number };

// Typical values for Japanese warimono shells (height above launch site, burst radius), in metres.
// 2026: Setagaya's largest shell is 6号 (down from 10号); Kawasaki publishes no maximum.
export const SHELLS: Shell[] = [
  { name: "3号", burstHeight: 120, burstRadius: 32 },
  { name: "4号", burstHeight: 160, burstRadius: 60 },
  { name: "5号", burstHeight: 190, burstRadius: 80 },
  { name: "6号", burstHeight: 220, burstRadius: 95 },
];

export type LaunchSite = { id: string; position: THREE.Vector3 }; // position at ground level

const MAX_PARTICLES = 24000;
const GRAVITY = 9.8 * 0.35; // stars fall slower than free fall because of drag
const PALETTE = [0xffd27a, 0xff6b6b, 0x7ad7ff, 0xb98cff, 0x9dff8a, 0xffffff, 0xffa24d];

type Rocket = { pos: THREE.Vector3; vel: THREE.Vector3; target: number; shell: Shell; color: THREE.Color };

export class FireworksShow {
  readonly points: THREE.Points;
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES); // seconds left, <= 0 means free
  private readonly baseColor = new Float32Array(MAX_PARTICLES * 3);
  private cursor = 0;
  private rockets: Rocket[] = [];
  private untilNextLaunch = 0;
  private sites: LaunchSite[];

  constructor(sites: LaunchSite[]) {
    this.sites = sites;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 11,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      map: glowTexture(),
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  setSites(sites: LaunchSite[]) {
    this.sites = sites;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    this.untilNextLaunch -= dt;
    if (this.untilNextLaunch <= 0 && this.sites.length) {
      this.launch();
      this.untilNextLaunch = 0.35 + Math.random() * 1.1;
    }

    for (const r of this.rockets) {
      r.vel.y -= GRAVITY * dt * 0.2;
      r.pos.addScaledVector(r.vel, dt);
      this.spawn(r.pos, new THREE.Vector3(0, -2, 0), 0.4, new THREE.Color(0xffc38a));
      if (r.pos.y >= r.target) this.burst(r);
    }
    this.rockets = this.rockets.filter((r) => r.pos.y < r.target);

    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      this.velocities[k] *= drag;
      this.velocities[k + 1] = this.velocities[k + 1] * drag - GRAVITY * dt;
      this.velocities[k + 2] *= drag;
      this.positions[k] += this.velocities[k] * dt;
      this.positions[k + 1] += this.velocities[k + 1] * dt;
      this.positions[k + 2] += this.velocities[k + 2] * dt;
      const fade = Math.max(this.life[i], 0) / 2.2;
      const flicker = this.life[i] < 0.8 ? 0.6 + Math.random() * 0.4 : 1;
      this.colors[k] = this.baseColor[k] * fade * flicker;
      this.colors[k + 1] = this.baseColor[k + 1] * fade * flicker;
      this.colors[k + 2] = this.baseColor[k + 2] * fade * flicker;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  private launch() {
    const site = this.sites[Math.floor(Math.random() * this.sites.length)];
    // Smaller shells are far more common than 10号.
    const roll = Math.random();
    const shell = SHELLS[roll < 0.45 ? 0 : roll < 0.8 ? 1 : roll < 0.95 ? 2 : 3];
    const jitter = () => (Math.random() - 0.5) * 60;
    const pos = site.position.clone().add(new THREE.Vector3(jitter(), 0, jitter()));
    const speed = Math.sqrt(2 * GRAVITY * 0.2 * shell.burstHeight) + 40;
    this.rockets.push({
      pos,
      vel: new THREE.Vector3((Math.random() - 0.5) * 4, speed, (Math.random() - 0.5) * 4),
      target: site.position.y + shell.burstHeight,
      shell,
      color: new THREE.Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]),
    });
  }

  private burst(r: Rocket) {
    const stars = 120 + Math.round(r.shell.burstRadius * 1.6);
    // With exponential drag k, a star travels v0 / k before stopping: pick v0 so stars reach the burst radius.
    const v0 = r.shell.burstRadius * 1.6;
    const second = Math.random() < 0.4 ? new THREE.Color(PALETTE[Math.floor(Math.random() * PALETTE.length)]) : null;
    for (let i = 0; i < stars; i++) {
      const dir = randomUnitVector();
      const color = second && i % 2 ? second : r.color;
      this.spawn(r.pos, dir.multiplyScalar(v0 * (0.92 + Math.random() * 0.08)), 2.2 + Math.random() * 0.6, color);
    }
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, color: THREE.Color) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    const k = i * 3;
    this.positions.set([pos.x, pos.y, pos.z], k);
    this.velocities.set([vel.x, vel.y, vel.z], k);
    this.baseColor.set([color.r, color.g, color.b], k);
    this.life[i] = life;
  }
}

function randomUnitVector(): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t));
}

function glowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
