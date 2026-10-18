// Shared helpers for the scene effects (SPEC 9.0 / 9.3): palette, shared uniforms, layer + style hooks, GLSL chunks.
// World convention: x east+, z south+, y = elevation (m) x exaggeration. Draped geometry stores raw elevation (m)
// in its attributes and multiplies by the shared uExag uniform, so exaggeration changes never rebuild buffers.
// Every fx ShaderMaterial spreads `fxUniforms` into its uniforms: the IUniform objects are shared, so FxDriver
// updates time, clock, sun, fog and viewport once per frame for all materials.
import { useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useStore, type LayerKey, type Quality, type VisualStyle } from '../../state/store'

export const HOUR_MS = 3_600_000
/** Arrival values at or above this are "never burns" (raster NEVER = 1e6; textures clamp to 60000). */
export const FINITE_MAX = 50_000

/** Palette (SPEC 9.0), sRGB hex. THREE.Color(hex) converts to the linear working space. */
export const HEX = {
  latticeCore: '#E8C77E',
  latticeFalloff: '#B08A45',
  gold: '#E2BE72',
  goldWhite: '#F7EBCB',
  fireHot: '#FFF3C4',
  fireMid: '#FFB347',
  fire: '#FF6A2B',
  ember: '#B8321A',
  char: '#16130F',
  text: '#ECE6D6',
  fog: '#0B120E',
  water: '#6FA8B8',
  ok: '#8FBF7A',
} as const

/** Aircraft category accents (theme.css --ac-*). */
export const AIRCRAFT_HEX: Record<string, string> = {
  airtanker: '#FF6A2B',
  helicopter: '#7FC8C0',
  air_attack: '#E2BE72',
  lead_plane: '#C9B8E8',
  other_fire: '#F0A35E',
  unknown: '#8A9488',
}

export const color = (hex: string) => new THREE.Color(hex)

export const STYLE_INDEX: Record<VisualStyle, number> = { hybrid: 0, realistic: 1, parametric: 2 }

/** Per-quality budgets (SPEC 9.6). */
export const QUALITY_SCALE: Record<Quality, number> = { high: 1, medium: 0.6, low: 0.3 }

/** Render order of the fx layers (transparent objects draw in this order after the opaque terrain/trees). */
export const ORDER = {
  lattice: 10,
  wire: 11,
  detections: 12,
  perimeters: 13,
  profile: 14,
  wind: 15,
  embers: 16,
  smoke: 20,
  aircraftTrail: 21,
  aircraft: 22,
  ignition: 23,
  telemetry: 30,
} as const

/** Visibility + opacity of one store layer. */
export function useLayer(key: LayerKey): { visible: boolean; opacity: number } {
  const visible = useStore((s) => s.layers[key].visible)
  const opacity = useStore((s) => s.layers[key].opacity)
  return { visible, opacity }
}

const motionQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null

function subscribeMotion(cb: () => void): () => void {
  motionQuery?.addEventListener('change', cb)
  return () => motionQuery?.removeEventListener('change', cb)
}

/** Honour prefers-reduced-motion (SPEC 9.0): no shimmer, ticking or sweeps; particles slow down. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => motionQuery?.matches ?? false,
    () => false,
  )
}

export const prefersReducedMotion = (): boolean => motionQuery?.matches ?? false

/** Default aerial-perspective density (matches the scaffold terrain fog) when scene-core has not published env. */
export const fogDensity = (extent: number) => 1 / (extent * 4.5)

/** Uniforms shared by every fx material (updated once per frame by FxDriver; see GLSL_COMMON). */
export const fxUniforms = {
  uExtent: { value: 12000 },
  uExag: { value: 1.5 },
  uTimeH: { value: 0 },
  uClock: { value: 0 },
  uStyle: { value: 0 },
  uPixelRatio: { value: 1 },
  uViewport: { value: new THREE.Vector2(1, 1) },
  uSunDir: { value: new THREE.Vector3(0.55, 0.62, 0.55).normalize() },
  uSunColor: { value: new THREE.Color(1.05, 0.98, 0.88) },
  uSkyAmbient: { value: new THREE.Color(0.2, 0.24, 0.23) },
  uGroundAmbient: { value: new THREE.Color(0.07, 0.07, 0.06) },
  uFogColor: { value: new THREE.Color(HEX.fog) },
  uFogDensity: { value: 1 / 54000 },
  uFogFalloff: { value: 0 },
  uFogBaseY: { value: 0 },
  uCamDist: { value: 10000 },
  uLineGain: { value: 1 },
  uWind: { value: new Float32Array(32) },
  uWindAxes: { value: new THREE.Vector4(-3000, 2000, -3000, 2000) },
}

export type FxUniforms = typeof fxUniforms

/** Common GLSL (vertex + fragment): shared uniforms, hashes, plane UV, AOI edge fade, height fog, depth bias,
 *  NEVER-aware arrival sampling. */
export const GLSL_COMMON = /* glsl */ `
uniform float uExtent;
uniform float uExag;
uniform float uTimeH;
uniform float uClock;
uniform float uStyle;
uniform float uPixelRatio;
uniform vec2 uViewport;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;
uniform float uCamDist;
uniform float uLineGain;
float fxHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float fxHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 fxUv(vec2 xz) { return vec2(xz.x / uExtent + 0.5, 0.5 - xz.y / uExtent); }
// The square AOI must never read as a hard border: fade over the outer ~8 % along a rounded square (SPEC 9.0),
// the same superellipse the terrain uses, so effects vanish exactly where the terrain dissolves into the sky.
float fxEdge(vec2 uv) {
  vec2 e2 = pow(abs(uv * 2.0 - 1.0), vec2(7.0));
  float edge = 1.0 - pow(e2.x + e2.y, 1.0 / 7.0);
  return smoothstep(0.0, 0.128, edge);
}
// Exponential height fog along the camera ray (density at uFogBaseY, falloff per metre), as scene env defines it
// (identical to the terrain's aerial perspective); returns the fog amount 0..1.
float fxFog(vec3 world) {
  vec3 d = world - cameraPosition;
  float dist = length(d);
  float od = uFogDensity * dist;
  if (uFogFalloff > 1.0e-7) {
    float y0 = clamp(cameraPosition.y - uFogBaseY, -3000.0, 60000.0);
    float k = clamp(uFogFalloff * d.y, -60.0, 60.0);
    float integ = abs(k) > 1.0e-4 ? (1.0 - exp(-k)) / k : 1.0;
    od *= exp(-uFogFalloff * y0) * integ;
  }
  return 1.0 - exp(-max(od, 0.0));
}
float fxKeep(vec3 world) { return (1.0 - fxFog(world)) * fxEdge(fxUv(world.xz)); }
// View-space position pulled towards the camera by a fraction of its distance: same pixel, smaller depth.
// Keeps draped data on top of the terrain mesh without z-fighting.
vec4 fxViewPos(vec3 world, float bias) {
  vec4 mv = viewMatrix * vec4(world, 1.0);
  mv.xyz *= (1.0 - bias);
  return mv;
}
// Arrival hours at plane uv from a fire-grid arrival texture (NEVER clamped to 60000): the nearest texel decides
// whether the spot ever burns; burned spots interpolate only between burned texels (no NEVER sweep at edges).
float fxArrival(sampler2D tex, vec2 uv) {
  ivec2 sz = textureSize(tex, 0);
  vec2 fs = vec2(sz);
  ivec2 n = clamp(ivec2(floor(uv * fs)), ivec2(0), sz - 1);
  float an = texelFetch(tex, n, 0).r;
  if (an > 50000.0) return 1.0e5;
  vec2 p = uv * fs - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  float s = 0.0;
  float w = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 q = clamp(i0 + o, ivec2(0), sz - 1);
    float a = texelFetch(tex, q, 0).r;
    float wt = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    if (a < 50000.0) { s += a * wt; w += wt; }
  }
  return w > 1.0e-5 ? s / w : an;
}
float fxArrivalNearest(sampler2D tex, vec2 uv) {
  ivec2 sz = textureSize(tex, 0);
  ivec2 n = clamp(ivec2(floor(uv * vec2(sz))), ivec2(0), sz - 1);
  return texelFetch(tex, n, 0).r;
}
// P(burned by t) from forecast arrival quantiles (p10, p50, p90; hours) and the horizon burn probability,
// piecewise linear through (p10, .1), (p50, .5), (p90, .9), capped by the horizon probability (SPEC 9.3).
float fxProbBurned(vec3 q, float pEnd, float t) {
  float p;
  if (t >= q.z) p = 0.9;
  else if (t >= q.y) p = mix(0.5, 0.9, (t - q.y) / max(q.z - q.y, 1.0e-3));
  else if (t >= q.x) p = mix(0.1, 0.5, (t - q.x) / max(q.y - q.x, 1.0e-3));
  else p = 0.1 * clamp(1.0 - (q.x - t) / max(q.y - q.x, 1.0), 0.0, 1.0);
  if (q.x > 50000.0) p = 0.0;
  return min(p, pEnd);
}
`

/** Vertex-only helpers (projectionMatrix is not declared in fragment shaders). */
export const GLSL_VERT = /* glsl */ `
// Drawing-buffer pixels per metre at a given view depth (perspective).
float fxPxPerMeter(float viewDepth) { return 0.5 * uViewport.y * projectionMatrix[1][1] / max(viewDepth, 1.0); }
`

/** Wind field GLSL: bilinear in the 4x4 weather grid (u east+, v north+, m/s). Uniforms shared via fxUniforms. */
export const GLSL_WIND = /* glsl */ `
uniform vec2 uWind[16];
uniform vec4 uWindAxes; // x0, dx, z0, dz
vec2 fxWindAt(vec2 xz) {
  float fx = clamp((xz.x - uWindAxes.x) / uWindAxes.y, 0.0, 3.0);
  float fz = clamp((xz.y - uWindAxes.z) / uWindAxes.w, 0.0, 3.0);
  int i0 = int(min(floor(fx), 2.0));
  int j0 = int(min(floor(fz), 2.0));
  float tx = fx - float(i0);
  float tz = fz - float(j0);
  vec2 a = mix(uWind[j0 * 4 + i0], uWind[j0 * 4 + i0 + 1], tx);
  vec2 b = mix(uWind[(j0 + 1) * 4 + i0], uWind[(j0 + 1) * 4 + i0 + 1], tx);
  return mix(a, b, tz);
}
// World-space horizontal velocity (x east+, z south+) from the grid wind.
vec2 fxWindWorld(vec2 xz) { vec2 w = fxWindAt(xz); return vec2(w.x, -w.y); }
`

/** Standard output tail for custom ShaderMaterials (tone mapping only applies when rendering to screen). */
export const GLSL_OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`

/** Allocation-free bilinear terrain height (m, not exaggerated) on the render grid, edges clamped. */
export function makeHeightSampler(elev: { data: Float32Array; width: number; height: number }, extent: number): (x: number, z: number) => number {
  const { data, width: w, height: h } = elev
  const sx = w / extent
  const sz = h / extent
  const half = extent / 2
  return (x: number, z: number): number => {
    let c = (x + half) * sx - 0.5
    let r = (z + half) * sz - 0.5
    c = c < 0 ? 0 : c > w - 1 ? w - 1 : c
    r = r < 0 ? 0 : r > h - 1 ? h - 1 : r
    const c0 = c | 0
    const r0 = r | 0
    const c1 = c0 < w - 1 ? c0 + 1 : c0
    const r1 = r0 < h - 1 ? r0 + 1 : r0
    const fc = c - c0
    const fr = r - r0
    const a = data[r0 * w + c0]
    const b = data[r0 * w + c1]
    const cc = data[r1 * w + c0]
    const d = data[r1 * w + c1]
    return (a + (b - a) * fc) * (1 - fr) + (cc + (d - cc) * fc) * fr
  }
}

/** Device-pixel size of the drawing buffer (cached vector; no allocations per frame). */
const _size = new THREE.Vector2()
export function drawingBufferSize(gl: THREE.WebGLRenderer): THREE.Vector2 {
  return gl.getDrawingBufferSize(_size)
}

/** World size (m) that spans one CSS pixel at view depth `dist` for a perspective camera. */
export function worldPerPixel(camera: THREE.Camera, viewportHeightCss: number, dist: number): number {
  const p = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5] || 1
  return (2 * dist) / (p * Math.max(1, viewportHeightCss))
}

const _vp = new THREE.Vector3()
/** View depth (m, positive in front) of a world point. */
export function viewDepth(camera: THREE.Camera, x: number, y: number, z: number): number {
  _vp.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  return -_vp.z
}

/** Deterministic 0..1 hash of an integer (tree subsampling, particle seeds). */
export function hash01(i: number): number {
  let h = (i | 0) * 0x27d4eb2d
  h = (h ^ (h >>> 15)) * 0x85ebca6b
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Small fast PRNG (mulberry32) for particle spawning. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Dispose helper for useEffect cleanups. */
export function disposeAll(...items: ({ dispose(): void } | null | undefined)[]): void {
  for (const it of items) it?.dispose()
}
