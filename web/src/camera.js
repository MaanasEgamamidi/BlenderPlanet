// Camera rig that keeps the focused planet centred up front while the rest of
// the system keeps orbiting behind it. The rig sits on the planet's far side
// from the star, so the star and other worlds stay visible in the background.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class FocusRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.baseYaw = 0.42; // swing off the star axis so the planet shows a lit crescent
    this.basePitch = 0.32;
    this.baseDist = 4.3; // in planet radii
    this.userYaw = 0;
    this.userPitch = 0;
    this.zoom = 1;
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.targetZoom = 1;
    this.body = null;
    this.from = null;
    this.t = 1;
    this.duration = 1.6;
    this.look = new THREE.Vector3();
    this.onClick = null;
    this.onHover = null;
    this.attachInput();
  }

  pose(body, out = { pos: new THREE.Vector3(), look: new THREE.Vector3() }) {
    const P = body.pivot.position;
    const outward = new THREE.Vector3(P.x, 0, P.z).normalize();
    if (!Number.isFinite(outward.x)) outward.set(0, 0, 1);
    const yaw = this.baseYaw + this.userYaw;
    const pitch = THREE.MathUtils.clamp(this.basePitch + this.userPitch, -1.2, 1.35);
    const dir = outward.applyAxisAngle(UP, yaw);
    dir.multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch)).normalize();
    const aspect = this.camera.aspect;
    const fit = aspect < 1 ? 1 / Math.pow(aspect, 0.85) : 1;
    const dist = body.radius * this.baseDist * this.zoom * fit + (body.rings ? body.radius * 1.2 : 0);
    out.pos.copy(P).addScaledVector(dir, dist);
    out.look.copy(P);
    return out;
  }

  focus(body, { immediate = false, resetView = true } = {}) {
    if (!body) return;
    if (this.body && !immediate && body !== this.body) {
      this.from = { body: this.body, pos: this.camera.position.clone(), look: this.look.clone() };
      this.t = 0;
      const d = this.body.pivot.position.distanceTo(body.pivot.position);
      this.duration = THREE.MathUtils.clamp(1.1 + d / 45, 1.3, 2.4);
    } else {
      this.t = 1;
    }
    this.body = body;
    if (resetView) {
      this.targetYaw = 0;
      this.targetPitch = 0;
      this.targetZoom = 1;
    }
    if (immediate) {
      this.userYaw = this.targetYaw;
      this.userPitch = this.targetPitch;
      this.zoom = this.targetZoom;
      const p = this.pose(body);
      this.camera.position.copy(p.pos);
      this.look.copy(p.look);
      this.camera.lookAt(this.look);
    }
  }

  get transitioning() {
    return this.t < 1;
  }

  update(dt) {
    if (!this.body) return;
    const k = Math.min(1, dt * 6);
    this.userYaw += (this.targetYaw - this.userYaw) * k;
    this.userPitch += (this.targetPitch - this.userPitch) * k;
    this.zoom += (this.targetZoom - this.zoom) * k;

    const to = this.pose(this.body);
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.duration);
      const e = ease(this.t);
      // Start from where the camera actually was, travelling with the old
      // planet so we don't jerk while it keeps orbiting.
      const fromLive = this.pose(this.from.body);
      const startPos = this.from.pos.clone().lerp(fromLive.pos, e);
      const pos = startPos.lerp(to.pos, e);
      const lift = Math.sin(Math.PI * e) * this.from.body.pivot.position.distanceTo(this.body.pivot.position) * 0.18;
      pos.addScaledVector(UP, lift);
      this.camera.position.copy(pos);
      this.look.copy(this.from.look).lerp(to.look, e);
      // Brief FOV punch sells the "zoom through space" feel.
      this.camera.fov = 45 + Math.sin(Math.PI * e) * 10;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.position.copy(to.pos);
      this.look.copy(to.look);
      if (this.camera.fov !== 45) {
        this.camera.fov = 45;
        this.camera.updateProjectionMatrix();
      }
    }
    this.camera.lookAt(this.look);
  }

  attachInput() {
    const el = this.dom;
    const pointers = new Map();
    let downAt = null;
    let moved = 0;
    let pinchStart = 0;
    let zoomStart = 1;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY };
      moved = 0;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
        zoomStart = this.targetZoom;
      }
    });

    el.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        this.onHover?.(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.targetZoom = THREE.MathUtils.clamp(zoomStart * (pinchStart / Math.max(d, 1)), 0.65, 2.4);
        return;
      }
      if (moved > 4) el.classList.add('dragging');
      this.targetYaw -= dx * 0.0055;
      this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * 0.0045, -1.3, 1.1);
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      el.classList.remove('dragging');
      if (moved < 6 && downAt && pointers.size === 0) this.onClick?.(e.clientX, e.clientY);
      downAt = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.targetZoom = THREE.MathUtils.clamp(this.targetZoom * Math.exp(e.deltaY * 0.0012), 0.65, 2.4);
      },
      { passive: false },
    );
  }
}
