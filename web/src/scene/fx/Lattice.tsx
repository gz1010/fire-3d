// Parametric golden dot lattice (SPEC 9.0 / 9.3): THREE.Points on a regular N² grid (512/384/256 by quality)
// draped 2 m above the terrain, plus faint gold wire rows (every 4th row). Dot size/brightness encode the
// latticeField: activity (recency of burning + front proximity + forecast probability ahead of the front),
// forecast probability, elevation, slope or canopy. Hierarchical LOD (every 2nd/4th dot survives zooming out, so
// spacing adapts ~30 -> 120 m) keeps the grid fine and moiré-free; radial falloff around the fire in hybrid, full
// extent in parametric; distance attenuation, subtle shimmer, additive blending; one scan sweep on load.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore, type LatticeField, type Quality } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { GLSL_COMMON, GLSL_OUTPUT, GLSL_VERT, HEX, ORDER, fxUniforms, hash01, makeHeightSampler, prefersReducedMotion, useLayer } from './common'
import { fxShared } from './state'

const LATTICE_N: Record<Quality, number> = { high: 512, medium: 384, low: 256 }
const FIELD_INDEX: Record<LatticeField, number> = { activity: 0, probability: 1, elevation: 2, slope: 3, canopy: 4 }
const SWEEP_MS = 2600

const vertexShader = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aGrad;   // dh/dx, dh/dz (true slope components)
attribute vec4 aData;   // level (0 coarse .. 2 fine), rand, canopy 0..1, unused
uniform sampler2D uArrival;
uniform float uHasArrival;
uniform sampler2D uFront;
uniform float uHasFront;
uniform sampler2D uForecast;
uniform float uHasForecast;
uniform vec2 uFcWindow;
uniform float uField;
uniform vec2 uElevRange;
uniform vec3 uFire;
uniform float uSpacing;
uniform float uOpacity;
uniform float uSweep;
uniform float uMotion;
uniform vec3 uColCore;
uniform vec3 uColFall;
uniform vec3 uColWarm;
uniform vec3 uColOrange;
uniform vec3 uColRed;
varying vec3 vColor;
varying float vAlpha;

vec3 probRamp(float p) {
  vec3 c = mix(uColFall, uColCore, smoothstep(0.0, 0.35, p));
  c = mix(c, uColWarm, smoothstep(0.35, 0.65, p));
  c = mix(c, uColOrange, smoothstep(0.65, 0.9, p) * 0.8);
  return mix(c, uColRed, smoothstep(0.9, 1.0, p) * 0.35);
}

void main() {
  vec2 xz = position.xz;
  vec2 uv = fxUv(xz);
  vec3 world = vec3(xz.x, position.y * uExag + 2.0, xz.y);
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float depth = max(-mv.z, 1.0);
  float pxm = fxPxPerMeter(depth) / uPixelRatio;               // CSS px per metre
  vec3 nrm = normalize(vec3(-aGrad.x * uExag, 1.0, -aGrad.y * uExag));
  vec3 toCam = normalize(cameraPosition - world);
  float fore = clamp(abs(dot(toCam, nrm)), 0.12, 1.0);           // foreshortening at grazing angles

#ifdef WIRE
  float lod = smoothstep(4.0, 9.0, uSpacing * 4.0 * pxm * fore);
#else
  float lvl = aData.x < 0.5 ? 4.0 : (aData.x < 1.5 ? 2.0 : 1.0);
  float lod = smoothstep(2.3, 4.6, uSpacing * lvl * pxm * fore);
#endif

  // ---- field value 0..1 and "heat" (warm tint near the fire)
  float a = uHasArrival > 0.5 ? fxArrival(uArrival, uv) : 1.0e5;
  float since = uTimeH - a;
  float burned = (a < 50000.0 && since >= 0.0) ? 1.0 : 0.0;
  vec4 fc = vec4(6.0e4, 6.0e4, 6.0e4, 0.0);
  if (uHasForecast > 0.5) {
    ivec2 sz = textureSize(uForecast, 0);
    fc = texelFetch(uForecast, clamp(ivec2(floor(uv * vec2(sz))), ivec2(0), sz - 1), 0);
  }
  float v = 0.0;
  float heat = 0.0;
  vec3 col;
  if (uField < 0.5) {
    float recency = burned * exp(-max(since, 0.0) / 8.0);
    float front = uHasFront > 0.5 ? texture2D(uFront, uv).r : 0.0;
    float inWin = uHasForecast > 0.5 ? step(uFcWindow.x - 12.0, uTimeH) * step(uTimeH, uFcWindow.y) : 0.0;
    float ahead = (1.0 - burned) * fc.w * inWin;
    v = max(max(recency, front * 0.95), max(burned * 0.06, ahead * 0.5));
    heat = max(front, recency);
    col = mix(uColFall, uColCore, clamp(v * 1.3, 0.0, 1.0));
    col = mix(col, uColWarm, clamp((heat - 0.45) * 1.2, 0.0, 0.55));
  } else if (uField < 1.5) {
    float pNow = uHasForecast > 0.5 ? fxProbBurned(fc.xyz, fc.w, uTimeH) : 0.0;
    float p = max(pNow, 0.45 * fc.w);
    v = p * mix(1.0, 0.4, burned);
    col = probRamp(p);
  } else if (uField < 2.5) {
    v = clamp((position.y - uElevRange.x) / max(uElevRange.y - uElevRange.x, 1.0), 0.0, 1.0);
    col = mix(uColFall, uColCore, v);
  } else if (uField < 3.5) {
    v = smoothstep(0.03, 0.9, length(aGrad));
    col = mix(uColFall, uColCore, v);
  } else {
    v = aData.z;
    col = mix(uColFall, uColCore, v);
  }

  // ---- composition
  float dFire = distance(xz, uFire.xy);
  float para = step(1.5, uStyle);
  float radial = mix(1.0 - smoothstep(uFire.z * 0.7, uFire.z * 1.55, dFire), 1.0, para);
  float ndl = clamp(dot(nrm, uSunDir), 0.0, 1.0);
  float relief = mix(0.55 + 0.7 * ndl, 0.35 + 1.0 * ndl, para);
  float sweepR = uSweep * uExtent * 1.05;
  float reveal = uSweep >= 1.0 ? 1.0 : smoothstep(sweepR + 50.0, sweepR - 450.0, dFire);
  float sb = (dFire - sweepR) / 160.0; // squared by hand: pow() of a negative base is NaN on Metal
  float band = uSweep >= 1.0 ? 0.0 : exp(-sb * sb) * 1.6 * (1.0 - uSweep);
  float shimmer = mix(1.0, 0.86 + 0.14 * sin(uClock * (0.6 + aData.y * 1.2) + aData.y * 41.0), uMotion);
  float floorI = mix(0.55, 0.62, para);
  float inten = (floorI + 0.95 * pow(max(v, 0.0), 0.9)) * relief * shimmer;
  float keep = fxKeep(world);
#ifdef WIRE
  vAlpha = (inten * 0.34 * radial * reveal + band * 0.5) * lod * keep * uOpacity;
  vColor = col * (0.8 + 0.8 * v);
  gl_Position = projectionMatrix * fxViewPos(world, 0.0014);
#else
  vAlpha = (inten * radial * reveal + band) * lod * keep * uOpacity;
  vColor = col * (1.35 + 2.4 * v * v + 0.5 * band);
  float sizeCss = (1.6 + 1.8 * v) * clamp(7000.0 / depth, 0.8, 1.3);
  gl_PointSize = max(sizeCss * uPixelRatio, 1.0);
  gl_Position = projectionMatrix * fxViewPos(world, 0.0012);
#endif
  if (vAlpha < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
varying vec3 vColor;
varying float vAlpha;
void main() {
#ifdef WIRE
  gl_FragColor = vec4(vColor, vAlpha);
#else
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float prof = exp(-r2 * 2.6);
  gl_FragColor = vec4(vColor, vAlpha * prof);
#endif
  ${GLSL_OUTPUT}
}
`

interface LatticeGeometry {
  points: THREE.BufferGeometry
  wire: THREE.BufferGeometry
  spacing: number
}

function buildLattice(assets: IncidentAssets, N: number): LatticeGeometry {
  const ext = assets.extent
  const half = ext / 2
  const sp = ext / N
  const hs = makeHeightSampler(assets.elevation, ext)
  const cc = assets.arrays.canopyCover
  const fw = assets.arrays.fireGrid.width
  const fh = assets.arrays.fireGrid.height
  const pos = new Float32Array(N * N * 3)
  const grad = new Float32Array(N * N * 2)
  const data = new Float32Array(N * N * 4)
  const d = Math.max(sp, ext / assets.elevation.width)
  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * sp
    const fr = Math.min(fh - 1, Math.floor(((z + half) / ext) * fh))
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * sp
      const k = j * N + i
      pos[k * 3] = x
      pos[k * 3 + 1] = hs(x, z)
      pos[k * 3 + 2] = z
      grad[k * 2] = (hs(x + d, z) - hs(x - d, z)) / (2 * d)
      grad[k * 2 + 1] = (hs(x, z + d) - hs(x, z - d)) / (2 * d)
      data[k * 4] = i % 4 === 0 && j % 4 === 0 ? 0 : i % 2 === 0 && j % 2 === 0 ? 1 : 2
      data[k * 4 + 1] = hash01(k + 7919)
      if (cc) {
        const fc = Math.min(fw - 1, Math.floor(((x + half) / ext) * fw))
        data[k * 4 + 2] = Math.min(1, cc[fr * fw + fc] / 100)
      }
    }
  }
  const posAttr = new THREE.BufferAttribute(pos, 3)
  const gradAttr = new THREE.BufferAttribute(grad, 2)
  const dataAttr = new THREE.BufferAttribute(data, 4)
  const points = new THREE.BufferGeometry()
  points.setAttribute('position', posAttr)
  points.setAttribute('aGrad', gradAttr)
  points.setAttribute('aData', dataAttr)
  points.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ext)

  const rows = Math.ceil(N / 4)
  const index = new Uint32Array(rows * (N - 1) * 2)
  let o = 0
  for (let j = 0; j < N; j += 4) {
    for (let i = 0; i < N - 1; i++) {
      index[o++] = j * N + i
      index[o++] = j * N + i + 1
    }
  }
  const wire = new THREE.BufferGeometry()
  wire.setAttribute('position', posAttr)
  wire.setAttribute('aGrad', gradAttr)
  wire.setAttribute('aData', dataAttr)
  wire.setIndex(new THREE.BufferAttribute(index.subarray(0, o), 1))
  wire.boundingSphere = points.boundingSphere
  return { points, wire, spacing: sp }
}

function makeMaterial(wire: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines: wire ? { WIRE: 1 } : {},
    uniforms: {
      ...fxUniforms,
      uArrival: { value: null },
      uHasArrival: { value: 0 },
      uFront: { value: null },
      uHasFront: { value: 0 },
      uForecast: { value: null },
      uHasForecast: { value: 0 },
      uFcWindow: { value: new THREE.Vector2(-1e9, -1e9) },
      uField: { value: 0 },
      uElevRange: { value: new THREE.Vector2(0, 1) },
      uFire: { value: new THREE.Vector3(0, 0, 3000) },
      uSpacing: { value: 30 },
      uOpacity: { value: 0.9 },
      uSweep: { value: 1 },
      uMotion: { value: 1 },
      uColCore: { value: new THREE.Color(HEX.latticeCore) },
      uColFall: { value: new THREE.Color(HEX.latticeFalloff) },
      uColWarm: { value: new THREE.Color(HEX.fireMid) },
      uColOrange: { value: new THREE.Color(HEX.fire) },
      uColRed: { value: new THREE.Color('#D2402A') },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  })
}

export function Lattice({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('lattice')
  const style = useStore((s) => s.visualStyle)
  const quality = useStore((s) => s.quality)
  const N = LATTICE_N[quality]

  const geo = useMemo(() => buildLattice(assets, N), [assets.elevation, assets.extent, assets.arrays.canopyCover, N]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    geo.points.dispose()
    geo.wire.dispose()
  }, [geo])
  const mats = useMemo(() => {
    const points = makeMaterial(false)
    const wire = makeMaterial(true)
    return { points, wire, list: [points, wire] }
  }, [])
  useEffect(() => () => {
    mats.points.dispose()
    mats.wire.dispose()
  }, [mats])

  useEffect(() => {
    const t = assets.textures
    const f = assets.forecast
    for (const m of [mats.points, mats.wire]) {
      const u = m.uniforms
      u.uArrival.value = t.observedArrival
      u.uHasArrival.value = t.observedArrival ? 1 : 0
      u.uForecast.value = t.forecastPacked
      u.uHasForecast.value = t.forecastPacked ? 1 : 0
      const origin = assets.manifest.time_origin_ms
      u.uFcWindow.value.set(
        f ? (f.start_ms - origin) / 3.6e6 : -1e9,
        f ? (f.start_ms + f.horizon_h * 3.6e6 - origin) / 3.6e6 : -1e9,
      )
      u.uElevRange.value.set(assets.elevation.min, assets.elevation.max)
      u.uSpacing.value = geo.spacing
    }
  }, [assets, mats, geo])

  useFrame(() => {
    if (!visible) return
    const s = useStore.getState()
    const sweep = prefersReducedMotion() ? 1 : Math.min(1, (performance.now() - fxShared.loadedAt) / SWEEP_MS)
    const parametric = s.visualStyle === 'parametric'
    for (let i = 0; i < mats.list.length; i++) {
      const m = mats.list[i]
      const u = m.uniforms
      u.uOpacity.value = opacity * (m === mats.wire ? (parametric ? 1.25 : 1) : 1)
      u.uField.value = FIELD_INDEX[s.latticeField]
      u.uFront.value = fxShared.frontTex
      u.uHasFront.value = fxShared.frontTex ? 1 : 0
      u.uFire.value.set(fxShared.fireX, fxShared.fireZ, fxShared.fireRadius)
      u.uSweep.value = sweep
      u.uMotion.value = prefersReducedMotion() ? 0 : 1
    }
  })

  if (!visible || style === 'realistic') return null
  return (
    <>
      <points geometry={geo.points} material={mats.points} frustumCulled={false} renderOrder={ORDER.lattice} />
      {quality !== 'low' && <lineSegments geometry={geo.wire} material={mats.wire} frustumCulled={false} renderOrder={ORDER.wire} />}
    </>
  )
}
