// Loads the Blender-generated planet GLBs and builds the materials that bring
// them to life (claimed-territory glow, emissive tiles, hue variants, atmospheres).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE = `${import.meta.env.BASE_URL}planets/`;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

let manifest = null;
const cache = new Map();

export async function loadManifest() {
  if (!manifest) manifest = await (await fetch(`${BASE}manifest.json`)).json();
  return manifest;
}

export function getManifest() {
  return manifest;
}

/** Returns { planet: BufferGeometry, rings: BufferGeometry|null } for a GLB file. */
export function loadGeometry(file) {
  if (!cache.has(file)) {
    cache.set(
      file,
      loader.loadAsync(BASE + file).then((gltf) => {
        const out = { planet: null, rings: null };
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry.computeBoundingSphere();
          if (o.name.endsWith('_rings')) out.rings = o.geometry;
          else out.planet = o.geometry;
        });
        return out;
      }),
    );
  }
  return cache.get(file);
}

export function planetFile(biome, variant) {
  const b = manifest.biomes[biome] ?? manifest.biomes.terran;
  const v = b.variants[Math.min(variant, b.variants.length - 1)] ?? b.variants[0];
  return v.file;
}

/** The baked texture set for a planet's smooth surface: { albedo, normal, data }. */
export function planetSmoothEntry(biome, variant) {
  const b = manifest.biomes[biome] ?? manifest.biomes.terran;
  const v = b.variants[Math.min(variant, b.variants.length - 1)] ?? b.variants[0];
  return typeof v.smooth === 'object' ? v.smooth : null;
}

// --------------------------------------------------------------------------- //
//  Smooth-surface textures
// --------------------------------------------------------------------------- //

const texLoader = new THREE.TextureLoader();
const texCache = new Map();
let maxAnisotropy = 1;

export function setMaxAnisotropy(n) {
  maxAnisotropy = n;
}

function loadTexture(file, srgb) {
  if (!texCache.has(file)) {
    texCache.set(
      file,
      texLoader.loadAsync(BASE + file).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping; // longitude wraps: no seam at u = 0/1
        t.anisotropy = maxAnisotropy; // keeps detail crisp toward the limb and poles
        return t;
      }),
    );
  }
  return texCache.get(file);
}

/** Loads a smooth texture entry; missing maps resolve to null. */
export async function loadSmoothTextures(entry) {
  const [albedo, normal, data] = await Promise.all([
    loadTexture(entry.albedo, true),
    entry.normal ? loadTexture(entry.normal, false) : null,
    entry.data ? loadTexture(entry.data, false) : null,
  ]);
  return { albedo, normal, data };
}

let sphereGeo = null;
/** Shared UV sphere the smooth textures are baked for (equirectangular, Y = pole). */
export function smoothSphere() {
  sphereGeo ??= new THREE.SphereGeometry(1, 256, 128);
  return sphereGeo;
}

// --------------------------------------------------------------------------- //
//  Planet surface material
// --------------------------------------------------------------------------- //

export const CLAIM_COLOR = new THREE.Color('#ffb13b');

// Global surface mode: 0 = hex field, 1 = smooth; values in between sweep the
// switch across each world from pole to pole. Each body copies it into its own
// uSurface uniform, and keeps 0 until its smooth surface has loaded.
export const surfaceUniform = { value: 0 };

// Pole-to-pole sweep between the two surfaces, with a glowing seam at the cut.
const SWEEP_GLSL = /* glsl */ `
  float sweepPos = 0.5 - 0.5 * normalize(vObjPos).y;
  float sweepAt = uSurface * 1.06 - 0.03;
  float seam = (1.0 - smoothstep(0.0, 0.014, abs(sweepPos - sweepAt))) * step(0.0005, uSurface) * step(uSurface, 0.9995);
`;

/**
 * Planet surface material.
 *  - hex (default): vertex-coloured Goldberg tiles; COLOR_0.a = glow, _ORDER/_EDGE attributes.
 *  - smooth: a UV sphere wearing the baked textures (albedo, tangent-space normal map,
 *    data map R = roughness, G = glow, B = claim order). Claimed territory shows as a
 *    warm tint with a glowing frontier contour instead of hex rims.
 * Pass the hex material's `uniforms` to keep both variants of a planet in sync.
 */
export function createPlanetMaterial({ hue = 0, smooth = false, uniforms = null, textures = null } = {}) {
  uniforms ??= {
    uProgress: { value: 0 },
    uTime: { value: 0 },
    uHue: { value: hue },
    uGlow: { value: 1.35 },
    uClaim: { value: CLAIM_COLOR.clone() },
    uSaved: { value: 0 },
    uSpawn: { value: 1 },
    uSurface: { value: 0 },
  };

  const mat = smooth
    ? new THREE.MeshStandardMaterial({
        map: textures.albedo,
        normalMap: textures.normal,
        roughness: 0.9,
        metalness: 0,
      })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
  mat.userData.uniforms = uniforms;
  if (smooth) mat.defines = { SMOOTH_SURFACE: '' };
  const dataTex = { value: textures?.data ?? null };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (smooth) shader.uniforms.uData = dataTex;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vObjPos;
        #ifdef SMOOTH_SURFACE
          varying vec2 vSurfUv;
        #else
          attribute float _order;
          attribute float _edge;
          varying float vOrder;
          varying float vEdge;
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vObjPos = position;
        #ifdef SMOOTH_SURFACE
          vSurfUv = uv;
        #else
          vOrder = _order;
          vEdge = _edge;
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uProgress;
        uniform float uTime;
        uniform float uHue;
        uniform float uGlow;
        uniform vec3 uClaim;
        uniform float uSaved;
        uniform float uSpawn;
        uniform float uSurface;
        varying vec3 vObjPos;
        #ifdef SMOOTH_SURFACE
          uniform sampler2D uData;
          varying vec2 vSurfUv;
        #else
          varying float vOrder;
          varying float vEdge;
        #endif

        vec3 hueShift(vec3 c, float a) {
          const vec3 k = vec3(0.57735);
          float ca = cos(a);
          return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `
        #ifdef SMOOTH_SURFACE
          vec4 surf = texture2D(uData, vSurfUv);
          vec3 tileCol = max(hueShift(diffuseColor.rgb, uHue), 0.0);
          float tileGlow = surf.g;
          float ord = surf.b;
          bool isRing = false;
          diffuseColor.rgb = tileCol;
        #else
          vec3 tileCol = max(hueShift(vColor.rgb, uHue), 0.0);
          float tileGlow = vColor.a;
          float ord = vOrder;
          bool isRing = vOrder > 1.5; // ring rocks: never claimed, never swept
          diffuseColor.rgb *= tileCol;
        #endif

        // Spawn-in: the surface appears from the claim origin outward.
        if (!isRing && ord > uSpawn) discard;

        ${SWEEP_GLSL}
        #ifdef SMOOTH_SURFACE
          if (sweepPos > sweepAt) discard;
        #else
          if (!isRing && sweepPos < sweepAt) discard;
        #endif
        if (isRing) seam = 0.0;

        // Territory claimed by course progress.
        float claimed = isRing ? 0.0 : 1.0 - step(uProgress, ord);
        float wave = 0.55 + 0.45 * sin(uTime * 1.6 - ord * 18.0);
        #ifdef SMOOTH_SURFACE
          float lineW = max(fwidth(ord) * 1.3, 0.0025);
          float contour = (1.0 - smoothstep(0.0, lineW, abs(ord - uProgress))) * step(0.001, uProgress) * step(uProgress, 0.998);
          // Claimed land takes a faint warm cast; a saved world keeps its natural colours.
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.9 + uClaim * 0.22), claimed * 0.3 * (1.0 - uSaved));
        #else
          float front = claimed * smoothstep(0.06, 0.0, uProgress - ord) * step(uProgress, 0.999);
          float rim = smoothstep(0.9, 0.99, vEdge);
          diffuseColor.rgb += uClaim * claimed * rim * 0.08;
        #endif
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        #ifdef SMOOTH_SURFACE
          roughnessFactor = surf.r; // liquids are glossy and catch a sun glint
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += tileCol * tileGlow * uGlow;
        #ifdef SMOOTH_SURFACE
          totalEmissiveRadiance += uClaim * contour * (1.5 + 0.4 * sin(uTime * 4.0));
          // soft glow hugging the inside of the frontier
          totalEmissiveRadiance += uClaim * claimed * smoothstep(0.04, 0.0, uProgress - ord) * step(uProgress, 0.998) * 0.3;
        #else
          float edgeLight = rim * claimed * mix(0.8, 0.7 * pow(wave, 6.0), uSaved);
          totalEmissiveRadiance += uClaim * edgeLight * 0.42;
          totalEmissiveRadiance += uClaim * front * (0.6 + 0.4 * sin(uTime * 6.0)) * 0.9;
        #endif
        float spawnEdge = isRing ? 0.0 : smoothstep(0.05, 0.0, abs(ord - uSpawn)) * step(uSpawn, 0.999);
        totalEmissiveRadiance += vec3(0.6, 0.85, 1.0) * (spawnEdge * 3.0 + seam * 4.0);`,
      );
  };
  // One program per surface type; uniforms stay per-material.
  mat.customProgramCacheKey = () => (smooth ? 'planet-smooth-v3' : 'planet-hex-v3');
  return mat;
}

/**
 * Star material. The smooth variant wears the baked photosphere texture and adds
 * limb darkening, which is what makes a real star read as a sphere.
 */
export function createStarMaterial(glow, { smooth = false, surface = { value: 0 }, map = null } = {}) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: !smooth, map });
  mat.color.setScalar(2.2);
  mat.userData.glow = new THREE.Color(glow);
  if (smooth) mat.defines = { SMOOTH_SURFACE: '' };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSurface = surface;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vNrmV;\nvarying vec3 vPosV;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vObjPos = position;
        vNrmV = normalize(normalMatrix * normal);
        vPosV = (modelViewMatrix * vec4(position, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSurface;\nvarying vec3 vObjPos;\nvarying vec3 vNrmV;\nvarying vec3 vPosV;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${SWEEP_GLSL}
        #ifdef SMOOTH_SURFACE
          if (sweepPos > sweepAt) discard;
          float mu = clamp(dot(normalize(vNrmV), normalize(-vPosV)), 0.0, 1.0);
          diffuseColor.rgb *= 0.42 + 0.58 * pow(mu, 0.55);
        #else
          if (sweepPos < sweepAt) discard;
        #endif
        diffuseColor.rgb += vec3(1.0) * seam * 1.5;`,
      );
  };
  mat.userData.surface = surface;
  mat.customProgramCacheKey = () => (smooth ? 'star-smooth-v3' : 'star-hex-v3');
  return mat;
}

// --------------------------------------------------------------------------- //
//  Atmosphere: back-face halo + front-face haze, both lit from the star.
// --------------------------------------------------------------------------- //

const atmoVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunPos;
  uniform float uIntensity;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 N = normalize(vNormalW);
    // Back faces: 0 at the halo's silhouette, rising toward the planet limb.
    float f = clamp(-dot(N, V), 0.0, 1.0);
    float halo = pow(smoothstep(0.0, 0.55, f), 2.6) * 0.75;
    vec3 L = normalize(uSunPos - vPosW);
    // back-face normals near the limb point outward, so they light like the surface
    float lit = dot(N, L);
    float day = smoothstep(-0.55, 0.45, lit);
    // warm band along the terminator, like a sunset seen from orbit
    float dusk = smoothstep(0.5, 0.0, abs(lit + 0.05)) * 0.8;
    vec3 col = uColor * (0.1 + day * 0.85) + vec3(1.0, 0.45, 0.18) * dusk * 0.35;
    gl_FragColor = vec4(col * halo * uIntensity, 1.0);
  }
`;

const hazeFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunPos;
  uniform float uIntensity;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 N = normalize(vNormalW);
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    vec3 L = normalize(uSunPos - vPosW);
    float day = smoothstep(-0.3, 0.6, dot(N, L));
    vec3 col = uColor * fres * (0.12 + day * 0.9);
    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
`;

export function createAtmosphere(radius, color, sunPos) {
  const group = new THREE.Group();
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uSunPos: { value: sunPos },
    uIntensity: { value: 1 },
  };
  const common = {
    vertexShader: atmoVertex,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  };
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.2, 64, 48),
    new THREE.ShaderMaterial({ ...common, fragmentShader: haloFragment, side: THREE.BackSide }),
  );
  const haze = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.075, 64, 48),
    new THREE.ShaderMaterial({ ...common, fragmentShader: hazeFragment, side: THREE.FrontSide }),
  );
  halo.renderOrder = 2;
  haze.renderOrder = 3;
  group.add(halo, haze);
  group.userData.uniforms = uniforms;
  return group;
}

// --------------------------------------------------------------------------- //
//  Misc textures
// --------------------------------------------------------------------------- //

let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
