// Deep-space backdrop: a Milky-Way style sky dome plus a starfield that follows the same galactic plane.
import * as THREE from 'three';

// Galactic frame shared by the sky dome and the stars, tilted so the band crosses the view diagonally.
const GAL_N = new THREE.Vector3(0.32, 1, 0.42).normalize();
const GAL_C = new THREE.Vector3(1, 0, -0.55).projectOnPlane(GAL_N).normalize();
const GAL_B = new THREE.Vector3().crossVectors(GAL_N, GAL_C);
const GAL_BASIS = new THREE.Matrix4().makeBasis(GAL_C, GAL_N, GAL_B);

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

// Blackbody-ish tints from hot blue to cool orange; most stars are white-yellow.
const TINTS = ['#9bb4ff', '#b8c9ff', '#dfe6ff', '#fff4ea', '#ffe9c8', '#ffd2a1', '#ffb27a'].map((c) => new THREE.Color(c));
const TINT_WEIGHTS = [0.05, 0.1, 0.2, 0.25, 0.2, 0.13, 0.07];
function pickTint() {
  let r = Math.random();
  for (let i = 0; i < TINTS.length; i++) if ((r -= TINT_WEIGHTS[i]) <= 0) return TINTS[i];
  return TINTS[3];
}

export function createStarfield(count = 16000, radius = 1500) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seed = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const inBand = Math.random() < 0.55;
    if (inBand) {
      // galactic frame: y is latitude; stars crowd the plane and the core (+x)
      const lon = Math.random() < 0.35 ? gauss() * 0.55 : Math.random() * Math.PI * 2;
      const lat = gauss() * 0.09;
      v.set(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)).applyMatrix4(GAL_BASIS);
    } else {
      v.randomDirection();
    }
    v.normalize().multiplyScalar(radius * (0.85 + Math.random() * 0.15));
    pos.set([v.x, v.y, v.z], i * 3);
    const c = pickTint();
    col.set([c.r, c.g, c.b], i * 3);
    // steep magnitude distribution: mostly faint dust, a few bright beacons
    const m = Math.pow(Math.random(), inBand ? 9 : 7);
    size[i] = 0.9 + m * 9;
    seed[i] = Math.random() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: /* glsl */ `
      attribute float size;
      attribute float seed;
      varying vec3 vColor;
      varying float vTwinkle;
      varying float vSize;
      uniform float uTime;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vTwinkle = 0.8 + 0.2 * sin(uTime * (0.5 + fract(seed) * 1.8) + seed);
        vSize = size;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // bright stars get a larger sprite so their diffraction spikes have room
        gl_PointSize = (size > 5.0 ? size * 2.6 : size) * uPixelRatio;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTwinkle;
      varying float vSize;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        float a;
        if (vSize > 5.0) {
          float core = exp(-d * d * 260.0);
          float halo = exp(-d * 9.0) * 0.18;
          float spikes = (exp(-abs(p.x) * 70.0) * exp(-abs(p.y) * 7.0) + exp(-abs(p.y) * 70.0) * exp(-abs(p.x) * 7.0)) * 0.55;
          a = (core + halo + spikes) * smoothstep(0.5, 0.3, d);
        } else {
          a = smoothstep(0.5, 0.0, d);
          a *= a;
        }
        gl_FragColor = vec4(vColor * vTwinkle * a * 1.35, 1.0);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -2;
  return pts;
}

export function createNebula(radius = 1800) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uA: { value: new THREE.Color('#2a1250') },
      uB: { value: new THREE.Color('#0c1a4a') },
      uTime: { value: 0 },
      uFade: { value: 1 },
      uGalN: { value: GAL_N },
      uGalC: { value: GAL_C },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uA;
      uniform vec3 uB;
      uniform float uTime;
      uniform float uFade;
      uniform vec3 uGalN;
      uniform vec3 uGalC;
      varying vec3 vDir;

      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p); vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
        return s;
      }
      float fbm3(vec3 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.07 + 5.3; a *= 0.5; }
        return s;
      }
      // small elliptical galaxy smudge centred on direction c
      float galaxy(vec3 d, vec3 c, vec3 major, float size, float squash) {
        vec3 minor = normalize(cross(c, major));
        vec3 q = d - c;
        float x = dot(q, major) / size;
        float y = dot(q, minor) / (size * squash);
        float r = x * x + y * y;
        return exp(-r * 3.0) + exp(-r * 40.0) * 0.8;
      }

      void main() {
        vec3 d = normalize(vDir);
        float t = uTime * 0.003;

        float lat = dot(d, uGalN);
        float toCore = dot(d, uGalC);
        vec3 wp = d * 3.0 + vec3(t, 0.0, -t);
        vec3 warp = vec3(fbm3(wp), fbm3(wp + 4.1), fbm3(wp + 8.3)) - 0.5;
        float latW = lat + warp.y * 0.12;

        // diffuse glow of unresolved stars: a thin plane plus a thicker bulge toward the core
        float core = pow(max(toCore, 0.0), 3.0);
        float band = exp(-latW * latW * mix(60.0, 16.0, core));
        float bulge = exp(-(latW * latW * 9.0 + (1.0 - toCore) * 6.0));

        // star clouds: grainy brightness variation inside the band
        float clouds = fbm(d * 7.0 + warp * 2.0);
        float grain = fbm3(d * 38.0);
        float lum = band * (0.35 + 0.9 * smoothstep(0.35, 0.75, clouds)) * (0.75 + 0.5 * grain) + bulge * 0.9;

        vec3 bandCol = mix(vec3(0.62, 0.68, 0.85), vec3(1.0, 0.86, 0.66), core * 0.85 + bulge * 0.4);
        vec3 col = bandCol * lum * 0.16;

        // dust lanes: dark filaments hugging the mid-plane
        float lanes = smoothstep(0.42, 0.72, fbm(d * 4.5 + warp * 3.0 + 2.0));
        float dustMask = exp(-pow(latW + 0.015, 2.0) * 180.0) + exp(-latW * latW * 40.0) * 0.45;
        col *= 1.0 - clamp(lanes * dustMask, 0.0, 1.0) * 0.88;

        // emission nebulae in the galaxy's own tints, strongest near the plane
        float n1 = fbm(d * 2.4 + warp * 1.5 + 17.0);
        float n2 = fbm(d * 5.5 + n1 * 1.8 + 3.0);
        float neb = smoothstep(0.45, 0.85, n2) * smoothstep(0.35, 0.7, n1);
        float nebMask = exp(-latW * latW * 5.0) * 0.85 + 0.15;
        vec3 nebCol = mix(uB, uA, smoothstep(0.35, 0.75, n1)) * 2.4;
        col += nebCol * neb * nebMask * 0.9;
        // hot ionised knots
        col += uA * 2.8 * smoothstep(0.78, 0.95, n2) * smoothstep(0.5, 0.7, n1) * nebMask * 0.5;

        // faint cool haze so the sky never reads pure black
        col += uB * 0.05 + vec3(0.004, 0.006, 0.012);

        // a few distant galaxies well away from the plane
        col += vec3(1.0, 0.92, 0.82) * galaxy(d, normalize(vec3(-0.55, 0.62, 0.56)), normalize(vec3(0.8, 0.2, 0.55)), 0.022, 0.35) * 0.22;
        col += vec3(0.85, 0.9, 1.0) * galaxy(d, normalize(vec3(0.42, -0.7, -0.58)), normalize(vec3(0.3, 0.5, -0.8)), 0.014, 0.6) * 0.16;
        col += vec3(1.0, 0.95, 0.9) * galaxy(d, normalize(vec3(-0.8, -0.35, -0.48)), normalize(vec3(0.1, 0.9, -0.4)), 0.009, 0.25) * 0.14;

        gl_FragColor = vec4(col * uFade, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
  mesh.renderOrder = -3;
  mesh.frustumCulled = false;
  return mesh;
}
