// Deep-space backdrop: twinkling starfield + procedural nebula dome.
import * as THREE from 'three';

export function createStarfield(count = 7000, radius = 1500) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const seed = new Float32Array(count);
  const tints = [new THREE.Color('#ffffff'), new THREE.Color('#cfe0ff'), new THREE.Color('#ffe7c4'), new THREE.Color('#ffd0d0'), new THREE.Color('#b9c8ff')];
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection();
    // bias a portion of stars toward a galactic band
    if (Math.random() < 0.45) {
      v.y *= 0.18;
      v.normalize();
    }
    v.multiplyScalar(radius * (0.8 + Math.random() * 0.2));
    pos.set([v.x, v.y, v.z], i * 3);
    const c = tints[(Math.random() * tints.length) | 0];
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = Math.pow(Math.random(), 6) * 7 + 1.1;
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
      uniform float uTime;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vTwinkle = 0.65 + 0.35 * sin(uTime * (0.6 + fract(seed) * 2.0) + seed);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        a *= a;
        gl_FragColor = vec4(vColor * vTwinkle * a * 1.4, 1.0);
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
      void main() {
        vec3 d = normalize(vDir);
        float t = uTime * 0.004;
        float n1 = fbm(d * 2.2 + vec3(t, 0.0, -t));
        float n2 = fbm(d * 4.5 + n1 * 1.6 + 7.0);
        // soft galactic band + a big cloud patch below the ecliptic
        float band = exp(-pow(d.y * 3.2 + n1 * 0.9 - 0.3, 2.0));
        float low = smoothstep(0.2, -0.7, d.y) * 0.8;
        float m = smoothstep(0.35, 0.95, n2) * (band * 0.9 + low);
        vec3 col = mix(uB, uA, smoothstep(0.3, 0.8, n1)) * m * 1.25;
        col += uA * 0.08 * band;
        // dark dust lanes
        col *= 1.0 - smoothstep(0.55, 0.8, fbm(d * 6.0 + 3.0)) * 0.6;
        gl_FragColor = vec4(col * uFade, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
  mesh.renderOrder = -3;
  mesh.frustumCulled = false;
  return mesh;
}
