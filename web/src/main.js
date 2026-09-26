import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { store, isSaved, NEBULAE } from './data.js';
import { loadManifest, CLAIM_COLOR, surfaceUniform, setMaxAnisotropy } from './assets.js';
import { createStarfield, createNebula } from './background.js';
import { StarSystem } from './system.js';
import { FocusRig } from './camera.js';
import * as ui from './ui.js';

// --------------------------------------------------------------------------- //
//  Renderer / scene
// --------------------------------------------------------------------------- //

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 6000);
scene.add(camera);

const nebula = createNebula();
const stars = createStarfield();
scene.add(nebula, stars);

// The star is the key light. The fills stand in for starlight and nebula glow so
// night hemispheres stay readable. Both are specular-free, so oceans only glint toward the star.
scene.add(new THREE.AmbientLight('#4a5578', 0.08));
// Aimed from over the viewer's shoulder each frame, so the night side still shades as a sphere.
const fill = new THREE.HemisphereLight('#8fa2d0', '#15131d', 0.75);
const FILL_DIR = new THREE.Vector3(-0.6, 0.5, 1).normalize();
scene.add(fill);

// Multisampled HDR target: keeps thin orbit lines and hex seams smooth
// (the composer's default target has no MSAA).
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.75, 0.5, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const rig = new FocusRig(camera, canvas);

// --------------------------------------------------------------------------- //
//  App state
// --------------------------------------------------------------------------- //

const SURFACE_KEY = 'course-galaxy/surface';
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function loadSurfacePref() {
  try {
    return localStorage.getItem(SURFACE_KEY) === 'smooth' ? 'smooth' : 'hex';
  } catch {
    return 'hex';
  }
}

const app = {
  system: null,
  focusId: null,
  history: [],
  switching: false,
  // 'hex' or 'smooth'. surfaceT runs 0..1 linearly and is eased into the shader uniform.
  surface: loadSurfacePref(),
  surfaceT: 0,
  surfaceReady: true,

  async setSurface(mode) {
    if (mode !== 'hex' && mode !== 'smooth') return;
    this.surface = mode;
    try {
      localStorage.setItem(SURFACE_KEY, mode);
    } catch {
      /* preference just won't persist */
    }
    ui.renderSurfaceToggle(mode, mode === 'smooth');
    if (mode === 'smooth' && this.system) {
      // Hold the sweep until the smooth meshes are in, then run it.
      this.surfaceReady = false;
      const system = this.system;
      await system.ensureSmooth();
      if (system !== this.system || this.surface !== 'smooth') return;
    } else if (this.system) {
      this.system.smoothWanted = false;
    }
    this.surfaceReady = true;
    ui.renderSurfaceToggle(this.surface, false);
    emit('surface', { surface: this.surface });
  },

  toggleSurface() {
    this.setSurface(this.surface === 'smooth' ? 'hex' : 'smooth');
  },

  focusedPlanet() {
    return store.galaxy.planets.find((p) => p.id === this.focusId) ?? null;
  },

  focus(id, { immediate = false, remember = true } = {}) {
    const body = this.system?.bodies.get(id);
    if (!body) return;
    if (remember && this.focusId && this.focusId !== id) this.history.push(this.focusId);
    this.history = this.history.slice(-30);
    this.focusId = id;
    this.system.setFocus(id);
    rig.focus(body, { immediate });
    ui.renderPlanetList();
    ui.renderInfo();
    emit('focus', { planet: body.data, galaxy: store.galaxy });
  },

  focusStar(immediate = true) {
    this.focusId = null;
    const s = this.system.star;
    rig.focus({ pivot: s.group, radius: s.radius * 1.5, rings: null, data: null }, { immediate });
    ui.renderPlanetList();
    ui.renderInfo();
  },

  cycle(dir) {
    const list = store.galaxy.planets;
    if (!list.length) return;
    const i = list.findIndex((p) => p.id === this.focusId);
    this.focus(list[(i + dir + list.length) % list.length].id);
  },

  back() {
    if (!emit('back', { planet: this.focusedPlanet(), galaxy: store.galaxy })) return;
    let prev;
    while ((prev = this.history.pop())) {
      if (this.system.bodies.has(prev)) return this.focus(prev, { remember: false });
    }
    ui.toast('No previous planet', { kicker: 'NAVIGATION' });
  },

  launch() {
    const p = this.focusedPlanet();
    if (!p) return;
    rig.targetZoom = 0.8;
    setTimeout(() => (rig.targetZoom = 1), 450);
    if (emit('launch', { planet: p, galaxy: store.galaxy })) ui.launchModal(p);
  },

  async addPlanet(data) {
    const p = store.addPlanet(store.galaxy.id, data);
    await this.system.addPlanet(p, { spawn: true });
    this.focus(p.id);
    ui.toast(`${p.name} charted`, { kicker: 'PLANET DISCOVERED' });
  },

  async updatePlanet(id, patch) {
    store.updatePlanet(id, patch);
  },

  setProgress(id, completed) {
    store.updatePlanet(id, { completed });
  },

  removePlanet(id) {
    const list = store.galaxy.planets;
    const i = list.findIndex((p) => p.id === id);
    store.removePlanet(id);
    this.system.removePlanet(id);
    this.history = this.history.filter((h) => h !== id);
    const next = store.galaxy.planets[Math.min(i, store.galaxy.planets.length - 1)];
    if (next) this.focus(next.id, { remember: false });
    else this.focusStar(false);
  },

  createGalaxy(opts) {
    const g = store.addGalaxy(opts);
    this.switchGalaxy(g.id);
  },

  async switchGalaxy(id, { initial = false } = {}) {
    if (this.switching || (!initial && id === store.galaxy.id)) return;
    this.switching = true;
    const warp = document.getElementById('warp');
    if (!initial) {
      rig.targetZoom = 2.2;
      await animate(700, (t) => {
        warp.style.opacity = String(t * t);
        camera.fov = 45 + t * t * 55;
        camera.updateProjectionMatrix();
      });
    }
    store.setActiveGalaxy(id);
    const g = store.galaxy;
    this.system?.dispose();
    this.system = new StarSystem(g);
    // Keep smooth meshes loaded while the smooth surface is showing (or sweeping out).
    this.system.smoothWanted = this.surface === 'smooth' || this.surfaceT > 0;
    await this.system.build((f) => initial && ui.setLoading(0.3 + f * 0.7));
    scene.add(this.system.group);
    const neb = NEBULAE[g.nebula] ?? NEBULAE.violet;
    nebula.material.uniforms.uA.value.set(neb.a);
    nebula.material.uniforms.uB.value.set(neb.b);
    this.history = [];
    rig.targetZoom = 1;
    if (g.planets.length) this.focus(g.planets[0].id, { immediate: true, remember: false });
    else this.focusStar(true);
    ui.renderAll();
    emit('galaxy', { galaxy: g });
    if (!initial) {
      rig.zoom = 1.8;
      await animate(900, (t) => {
        warp.style.opacity = String(1 - t);
        camera.fov = 100 - (1 - Math.pow(1 - t, 3)) * 55;
        camera.updateProjectionMatrix();
      });
    }
    this.switching = false;
  },
};

// Dispatches a cancelable window event; returns false if a host app handled it.
function emit(name, detail) {
  const ev = new CustomEvent(`coursegalaxy:${name}`, { detail, cancelable: true });
  return window.dispatchEvent(ev);
}

function animate(ms, fn) {
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      fn(t);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// --------------------------------------------------------------------------- //
//  Store -> scene sync
// --------------------------------------------------------------------------- //

store.addEventListener('planet', async (e) => {
  const { planet, before, visual } = e.detail;
  if (!app.system?.bodies.has(planet.id)) return;
  await app.system.updatePlanet(planet, visual);
  ui.renderPlanetList();
  ui.renderInfo();
  ui.renderAll();
  if (!isSaved(before) && isSaved(planet)) {
    celebrate(planet.id);
    ui.toast(`${planet.name} has been saved`, { kicker: 'PLANET SAVED' });
    emit('saved', { planet, galaxy: store.galaxy });
  } else if (planet.completed > before.completed) {
    ui.toast(`Sector secured on ${planet.name}`, { kicker: 'COURSE UPDATED' });
  }
});

// --------------------------------------------------------------------------- //
//  Effects: shockwave when a planet is saved
// --------------------------------------------------------------------------- //

const waves = [];
function celebrate(id) {
  const body = app.system.bodies.get(id);
  if (!body) return;
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 96),
      new THREE.MeshBasicMaterial({ color: CLAIM_COLOR.clone().multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    body.pivot.add(m);
    waves.push({ mesh: m, t: -i * 0.35, radius: body.radius });
  }
}

function updateWaves(dt) {
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.t += dt;
    const t = Math.max(0, w.t) / 1.8;
    w.mesh.visible = w.t > 0;
    w.mesh.lookAt(camera.position);
    w.mesh.scale.setScalar(w.radius * (1.05 + t * 3.2));
    w.mesh.material.opacity = Math.max(0, 1 - t);
    if (t >= 1) {
      w.mesh.removeFromParent();
      w.mesh.geometry.dispose();
      w.mesh.material.dispose();
      waves.splice(i, 1);
    }
  }
}

// --------------------------------------------------------------------------- //
//  Picking + floating labels
// --------------------------------------------------------------------------- //

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hoverId = null;

function pick(x, y) {
  if (!app.system) return null;
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(app.system.pickables(), false);
  return hits[0]?.object.userData.planetId ?? null;
}

rig.onClick = (x, y) => {
  const id = pick(x, y);
  if (id && id !== app.focusId) app.focus(id);
};
rig.onHover = (x, y) => {
  const id = pick(x, y);
  hoverId = id && id !== app.focusId ? id : null;
  canvas.classList.toggle('hovering', !!hoverId);
};

const labelRoot = document.getElementById('labels');
const labels = new Map();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

const panels = [...document.querySelectorAll('.planet-panel, .right-col')];
let panelRects = null;
window.addEventListener('resize', () => (panelRects = null));

function updateLabels() {
  panelRects ??= panels.map((p) => p.getBoundingClientRect());
  const bodies = app.system ? [...app.system.bodies.values()] : [];
  const live = new Set();
  const focus = app.system?.bodies.get(app.focusId);
  let focusScreen = null;
  if (focus) {
    tmp.copy(focus.pivot.position).project(camera);
    const edge = tmp2.copy(focus.pivot.position).addScaledVector(camera.up, focus.radius * 1.15).project(camera);
    focusScreen = { x: tmp.x, y: tmp.y, r: Math.hypot(edge.x - tmp.x, edge.y - tmp.y), d: camera.position.distanceTo(focus.pivot.position) };
  }
  for (const b of bodies) {
    live.add(b.data.id);
    let el = labels.get(b.data.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      labelRoot.appendChild(el);
      labels.set(b.data.id, el);
    }
    const text = `${b.data.name}${isSaved(b.data) ? ' âœ“' : ''}`;
    if (el.dataset.text !== text + b.data.course) {
      el.dataset.text = text + b.data.course;
      el.innerHTML = '';
      el.append(text);
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = b.data.course;
      el.append(sub);
    }
    const dist = camera.position.distanceTo(b.pivot.position);
    tmp.copy(b.pivot.position).project(camera);
    const below = tmp2.copy(b.pivot.position).addScaledVector(camera.up, -b.radius * 1.35).project(camera);
    let visible = b.data.id !== app.focusId && tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 && !rig.transitioning;
    if (visible && focusScreen && dist > focusScreen.d) {
      const aspect = camera.aspect;
      const dx = (tmp.x - focusScreen.x) * aspect;
      if (Math.hypot(dx, tmp.y - focusScreen.y) < focusScreen.r * 1.1) visible = false;
    }
    const sx = (below.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-below.y * 0.5 + 0.5) * window.innerHeight + 4;
    if (panelRects.some((r) => sx > r.left - 60 && sy > r.top - 30 && sy < r.bottom && sx < r.right + 60)) visible = false;
    el.style.opacity = visible ? (b.data.id === hoverId ? '1' : '0.75') : '0';
    el.classList.toggle('hover', b.data.id === hoverId);
    el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, 0)`;
  }
  for (const [id, el] of labels) {
    if (!live.has(id)) {
      el.remove();
      labels.delete(id);
    }
  }
}

// --------------------------------------------------------------------------- //
//  Loop
// --------------------------------------------------------------------------- //

const timer = new THREE.Timer();
let elapsed = 0;
function frame(now) {
  timer.update(now);
  tick(Math.min(timer.getDelta(), 0.05));
  requestAnimationFrame(frame);
}

function tick(dt) {
  elapsed += dt;
  const t = elapsed;
  if (app.surfaceReady) {
    const target = app.surface === 'smooth' ? 1 : 0;
    app.surfaceT += Math.sign(target - app.surfaceT) * Math.min(Math.abs(target - app.surfaceT), dt / 1.7);
  }
  surfaceUniform.value = ease(app.surfaceT);
  app.system?.update(dt);
  rig.update(dt);
  fill.position.copy(FILL_DIR).applyQuaternion(camera.quaternion);
  nebula.position.copy(camera.position);
  stars.position.copy(camera.position);
  nebula.material.uniforms.uTime.value = t;
  stars.material.uniforms.uTime.value = t;
  updateWaves(dt);
  updateLabels();
  composer.render();
}

// Dev-only hook for stepping the scene when the tab is throttled (e.g. automated previews).
if (import.meta.env.DEV) window.__galaxy = { app, rig, step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); } };

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
});

// --------------------------------------------------------------------------- //
//  Public API for the host app
// --------------------------------------------------------------------------- //

window.CourseGalaxy = {
  getState: () => structuredClone(store.state),
  focus: (planetId) => app.focus(planetId),
  switchGalaxy: (galaxyId) => app.switchGalaxy(galaxyId),
  addPlanet: (data) => app.addPlanet(data),
  updatePlanet: (id, patch) => app.updatePlanet(id, patch),
  removePlanet: (id) => app.removePlanet(id),
  setProgress: (id, completed) => app.setProgress(id, completed),
  addGalaxy: (opts) => app.createGalaxy(opts),
  setSurface: (mode) => app.setSurface(mode),
  reset: () => {
    store.reset();
    app.switchGalaxy(store.galaxy.id, { initial: true });
  },
};

// --------------------------------------------------------------------------- //
//  Boot
// --------------------------------------------------------------------------- //

(async () => {
  ui.setLoading(0.1);
  await loadManifest();
  ui.initUI(app);
  // A returning "smooth" visitor starts smooth, without a sweep.
  if (app.surface === 'smooth') app.surfaceT = 1;
  ui.renderSurfaceToggle(app.surface, false);
  await app.switchGalaxy(store.galaxy.id, { initial: true });
  ui.setLoading(1, true);
  frame();
})();
