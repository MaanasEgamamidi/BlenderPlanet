// A star system: one star at the origin, course planets on inclined orbits.
import * as THREE from 'three';
import {
  loadGeometry,
  planetFile,
  planetSmoothEntry,
  loadSmoothTextures,
  smoothSphere,
  surfaceUniform,
  getManifest,
  createPlanetMaterial,
  createStarMaterial,
  createAtmosphere,
  glowTexture,
} from './assets.js';
import { progressOf, isSaved } from './data.js';

const STAR_RADIUS = 3.3;
const FIRST_ORBIT = 34;
const ORBIT_GAP = 11;

// Deterministic 0..1 random from a string, so a planet keeps its orbit phase.
function rand(str, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export class StarSystem {
  constructor(galaxy) {
    this.galaxy = galaxy;
    this.group = new THREE.Group();
    this.bodies = new Map();
    this.sunPos = new THREE.Vector3(0, 0, 0);
    this.time = 0;
    // When true, smooth-surface meshes are loaded alongside the hex meshes.
    this.smoothWanted = false;
  }

  async build(onProgress = () => {}) {
    const manifest = getManifest();
    const starInfo = manifest.stars[this.galaxy.star] ?? Object.values(manifest.stars)[0];
    const files = [starInfo.file, ...this.galaxy.planets.map((p) => planetFile(p.biome, p.variant))];
    let done = 0;
    await Promise.all(files.filter(Boolean).map((f) => loadGeometry(f).then(() => onProgress(++done / files.filter(Boolean).length))));

    await this.buildStar(starInfo);
    for (const p of this.galaxy.planets) await this.addPlanet(p, { spawn: false });
    this.layout(true);
    return this;
  }

  /** Load and attach the smooth-surface meshes for everything in the system. */
  async ensureSmooth() {
    this.smoothWanted = true;
    await Promise.all([this.attachStarSmooth(), ...[...this.bodies.values()].map((b) => this.attachSmooth(b))]);
  }

  async attachSmooth(b) {
    if (b.smooth) return;
    const entry = planetSmoothEntry(b.data.biome, b.data.variant);
    if (!entry) return;
    const textures = await loadSmoothTextures(entry);
    if (b.smooth || this.bodies.get(b.data.id) !== b) return; // replaced or removed meanwhile
    const mat = createPlanetMaterial({ smooth: true, uniforms: b.material.userData.uniforms, textures });
    b.smooth = new THREE.Mesh(smoothSphere(), mat);
    // Sit just above the hex field's sea level, like a real planet's near-perfect sphere.
    b.smooth.scale.setScalar(b.radius * 1.012);
    b.smooth.visible = surfaceUniform.value > 0;
    b.spin.add(b.smooth);
  }

  async attachStarSmooth() {
    const s = this.star;
    if (!s || s.smooth || typeof s.info.smooth !== 'object') return;
    const { albedo } = await loadSmoothTextures(s.info.smooth);
    if (s.smooth) return;
    const mat = createStarMaterial(s.info.glow, { smooth: true, surface: s.mesh.material.userData.surface, map: albedo });
    s.smooth = new THREE.Mesh(smoothSphere(), mat);
    s.smooth.scale.setScalar(STAR_RADIUS);
    s.spin.add(s.smooth);
  }

  async buildStar(info) {
    const { planet: geo } = await loadGeometry(info.file);
    const star = new THREE.Group();
    const spin = new THREE.Group();
    const mesh = new THREE.Mesh(geo, createStarMaterial(info.glow));
    mesh.scale.setScalar(STAR_RADIUS);
    spin.add(mesh);
    star.add(spin);

    const glowColor = new THREE.Color(info.glow);
    const corona = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: glowColor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    corona.scale.setScalar(STAR_RADIUS * 3.6);
    const outer = corona.clone();
    outer.material = corona.material.clone();
    outer.material.opacity = 0.16;
    outer.scale.setScalar(STAR_RADIUS * 8);
    star.add(corona, outer);

    const light = new THREE.PointLight(glowColor.clone().lerp(new THREE.Color('#ffffff'), 0.7), 4.2, 0, 0);
    star.add(light);

    this.star = { group: star, spin, mesh, smooth: null, info, corona, outer, light, radius: STAR_RADIUS, color: glowColor };
    this.group.add(star);
    if (this.smoothWanted) await this.attachStarSmooth();
  }

  async addPlanet(data, { spawn = true } = {}) {
    const manifest = getManifest();
    const biome = manifest.biomes[data.biome] ?? manifest.biomes.terran;
    const geos = await loadGeometry(planetFile(data.biome, data.variant));
    const radius = data.size ?? 1;

    const pivot = new THREE.Group(); // positioned on the orbit
    const tilt = new THREE.Group(); // axial tilt
    tilt.rotation.z = (rand(data.id, 3) - 0.5) * 0.7;
    tilt.rotation.x = (rand(data.id, 4) - 0.5) * 0.4;
    pivot.add(tilt);

    // Hex and smooth surfaces spin together so the sweep between them lines up.
    const spin = new THREE.Group();
    spin.rotation.y = rand(data.id, 5) * Math.PI * 2;
    tilt.add(spin);
    const material = createPlanetMaterial({ hue: data.hue ?? 0 });
    const mesh = new THREE.Mesh(geos.planet, material);
    mesh.scale.setScalar(radius);
    spin.add(mesh);

    let rings = null;
    if (geos.rings) {
      rings = new THREE.Mesh(geos.rings, material);
      rings.scale.setScalar(radius);
      rings.rotation.x = 0.08; // exported in the equatorial plane; slight wobble reads better
      tilt.add(rings);
    }

    const atmo = createAtmosphere(radius, biome.atmosphere, this.sunPos);
    pivot.add(atmo);

    // Invisible proxy that makes small, distant planets easy to click.
    const proxy = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.6, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.userData.planetId = data.id;
    pivot.add(proxy);

    const body = {
      data,
      pivot,
      tilt,
      spin,
      mesh,
      smooth: null,
      rings,
      atmo,
      proxy,
      material,
      radius,
      orbitRadius: 0,
      targetOrbit: 0,
      phase: rand(data.id, 1) * Math.PI * 2,
      incline: new THREE.Euler((rand(data.id, 2) - 0.5) * 0.09, 0, (rand(data.id, 6) - 0.5) * 0.09),
      spinSpeed: 0.05 + rand(data.id, 7) * 0.06,
      progress: progressOf(data),
      spawn: spawn ? 0 : 1,
      orbitLine: null,
      highlight: 0,
    };
    material.userData.uniforms.uProgress.value = body.progress;
    material.userData.uniforms.uSaved.value = isSaved(data) ? 1 : 0;
    material.userData.uniforms.uSpawn.value = body.spawn;
    if (spawn) pivot.scale.setScalar(0.001);

    this.bodies.set(data.id, body);
    this.group.add(pivot);
    this.layout(false);
    if (this.smoothWanted) await this.attachSmooth(body);
    return body;
  }

  removePlanet(id) {
    const b = this.bodies.get(id);
    if (!b) return;
    this.group.remove(b.pivot, b.orbitLine);
    b.material.dispose();
    b.smooth?.material.dispose(); // geometry and textures are shared/cached
    b.orbitLine?.geometry.dispose();
    this.bodies.delete(id);
    this.layout(false);
  }

  async updatePlanet(data, visual) {
    let b = this.bodies.get(data.id);
    if (!b) return;
    b.data = data;
    if (visual) {
      // Rebuild the mesh in place, keeping its spot on the orbit.
      const { phase, progress } = b;
      this.removePlanet(data.id);
      await loadGeometry(planetFile(data.biome, data.variant));
      b = await this.addPlanet(data, { spawn: false });
      b.phase = phase;
      b.progress = progress;
    }
    b.material.userData.uniforms.uSaved.value = isSaved(data) ? 1 : 0;
  }

  /** Assign orbit radii in list order and (re)draw orbit rings. */
  layout(immediate) {
    let r = FIRST_ORBIT;
    for (const id of this.galaxy.planets.map((p) => p.id)) {
      const b = this.bodies.get(id);
      if (!b) continue;
      r += Math.max(0, b.radius - 1) * 2.5;
      b.targetOrbit = r;
      if (immediate || !b.orbitRadius) b.orbitRadius = r;
      r += ORBIT_GAP + Math.max(0, b.radius - 1) * 2.5 + (b.rings ? 2 : 0);
      this.drawOrbit(b);
    }
  }

  drawOrbit(b) {
    if (b.orbitLine) {
      this.group.remove(b.orbitLine);
      b.orbitLine.geometry.dispose();
    }
    const pts = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * b.targetOrbit, 0, Math.sin(a) * b.targetOrbit).applyEuler(b.incline));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    line.renderOrder = 1;
    b.orbitLine = line;
    this.group.add(line);
  }

  orbitPosition(b, target = new THREE.Vector3()) {
    const a = b.phase;
    return target.set(Math.cos(a) * b.orbitRadius, 0, Math.sin(a) * b.orbitRadius).applyEuler(b.incline);
  }

  setFocus(id) {
    this.focusId = id;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;

    const mode = surfaceUniform.value;
    if (this.star) {
      const s = this.star;
      s.spin.rotation.y += dt * 0.02;
      const pulse = 1 + Math.sin(t * 0.8) * 0.03 + Math.sin(t * 2.3) * 0.015;
      s.corona.scale.setScalar(STAR_RADIUS * 3.6 * pulse);
      const glow = 1.7 + Math.sin(t * 1.3) * 0.1;
      s.mesh.material.color.setScalar(glow);
      s.mesh.material.userData.surface.value = s.smooth ? mode : 0;
      s.mesh.visible = mode < 1 || !s.smooth;
      if (s.smooth) {
        s.smooth.material.color.setScalar(glow);
        s.smooth.visible = mode > 0;
      }
    }

    for (const b of this.bodies.values()) {
      b.orbitRadius += (b.targetOrbit - b.orbitRadius) * Math.min(1, dt * 2);
      b.phase += dt * (2.6 / Math.pow(b.orbitRadius, 1.5));
      this.orbitPosition(b, b.pivot.position);
      b.spin.rotation.y += dt * b.spinSpeed;
      // Only draw the surface(s) currently on screen; both during a sweep.
      b.mesh.visible = mode < 1 || !b.smooth;
      if (b.smooth) b.smooth.visible = mode > 0;
      if (b.rings) b.rings.rotation.z += dt * 0.01;

      const u = b.material.userData.uniforms;
      u.uSurface.value = b.smooth ? mode : 0;
      const target = progressOf(b.data);
      b.progress += (target - b.progress) * Math.min(1, dt * 1.1);
      if (Math.abs(target - b.progress) < 0.0005) b.progress = target;
      u.uProgress.value = b.progress;
      u.uTime.value = t;

      if (b.spawn < 1) {
        b.spawn = Math.min(1, b.spawn + dt * 0.55);
        const e = 1 - Math.pow(1 - b.spawn, 3);
        b.pivot.scale.setScalar(Math.max(0.001, Math.min(1, e * 1.6)));
        u.uSpawn.value = e * 1.02;
      }

      const focused = b.data.id === this.focusId;
      b.highlight += ((focused ? 1 : 0) - b.highlight) * Math.min(1, dt * 3);
      b.orbitLine.material.opacity = 0.13 + b.highlight * 0.14;
      b.atmo.userData.uniforms.uIntensity.value = 0.6 + b.highlight * 0.2;
    }
  }

  pickables() {
    return [...this.bodies.values()].map((b) => b.proxy);
  }

  dispose() {
    for (const id of [...this.bodies.keys()]) this.removePlanet(id);
    this.group.removeFromParent();
  }
}
