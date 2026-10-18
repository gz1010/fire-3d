// Instanced trees from LANDFIRE canopy (SPEC 9.3): conifer (stacked cones), broadleaf (lumpy blob on a trunk) and
// shrub (flattened blob), one instanced draw each. Per-instance moss-green variation, base AO, sun + sky light from
// the scene env and the baked terrain sun-visibility (ridge shadows). The vertex shader samples observed arrival:
// burned -> charred and shrunk (crown 40 %, height 70 %), on the front -> emissive torching flicker. Trees cast
// shadows at high quality through a matching depth material. Raw ground elevation per instance x uExag, so
// exaggeration and treeScale changes never rebuild buffers. Hidden in parametric mode.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { useSceneStore } from '../sceneStore'
import { GLSL_COMMON, GLSL_OUTPUT, QUALITY_SCALE, fxUniforms, hash01, useLayer } from './common'

const vertexShader = /* glsl */ `
${GLSL_COMMON}
attribute vec4 iPos;   // x, ground elevation (m), z, height (m)
attribute vec2 iMisc;  // crown radius (m), rand
uniform sampler2D uArrival;
uniform float uHasArrival;
uniform float uTreeScale;
uniform float uTorch;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vLocalY;
varying vec4 vState;   // charred, torching, ember glow, rand
varying vec2 vGroundUv;
varying float vKeep;
void main() {
  vec2 uv = fxUv(iPos.xz);
  float a = uHasArrival > 0.5 ? fxArrivalNearest(uArrival, uv) : 1.0e5;
  float since = uTimeH - a;
  float burned = (a < 50000.0 && since >= 0.0) ? 1.0 : 0.0;
  float charred = burned * smoothstep(0.15, 1.4, since);
  float torch = burned * (1.0 - smoothstep(0.3, 1.1, since)) * step(fract(iMisc.y * 5.31), uTorch);
  float ember = burned * exp(-max(since, 0.0) / 3.0);
  vec3 sc = vec3(iMisc.x, iPos.w, iMisc.x) * uTreeScale;
  sc *= vec3(mix(1.0, 0.4, charred), mix(1.0, 0.7, charred), mix(1.0, 0.4, charred));
  float ang = iMisc.y * 6.2831853;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec3 p = position * sc;
  p.xz = rot * p.xz;
  vec3 n = normal / max(sc, vec3(1.0e-3));
  n.xz = rot * n.xz;
  vec3 world = vec3(iPos.x, iPos.y * uExag - 0.5, iPos.z) + p;
  vWorld = world;
  vNormalW = normalize(n);
  vLocalY = position.y;
  vState = vec4(charred, torch, ember, iMisc.y);
  vGroundUv = uv;
  vKeep = fxKeep(world);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

const fragmentShader = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uAlbedo;
uniform vec3 uAlbedo2;
uniform sampler2D uSunVis;
uniform float uHasSunVis;
uniform float uOpacity;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vLocalY;
varying vec4 vState;
varying vec2 vGroundUv;
varying float vKeep;
void main() {
  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  float r = vState.w;
  vec3 albedo = mix(uAlbedo, uAlbedo2, fract(r * 7.13)) * (0.7 + 0.6 * fract(r * 13.7));
  vec3 charcoal = vec3(0.0075, 0.006, 0.0048) * (0.75 + 0.5 * fract(r * 3.1));
  albedo = mix(albedo, charcoal, vState.x);
  float ndl = dot(N, uSunDir);
  float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  float sunVis = uHasSunVis > 0.5 ? texture2D(uSunVis, vGroundUv).r : 1.0;
  float ao = mix(0.3, 1.0, smoothstep(0.0, 0.75, vLocalY));
  vec3 amb = mix(uGroundAmbient, uSkyAmbient, N.y * 0.5 + 0.5);
  vec3 col = albedo * (amb * ao * 1.15 + uSunColor * wrap * sunVis * mix(0.45, 1.0, ao));
  float flick = 0.72 + 0.28 * sin(uClock * 9.0 + r * 60.0) * sin(uClock * 5.3 + r * 17.0);
  vec3 fire = mix(vec3(1.0, 0.22, 0.035), vec3(1.0, 0.6, 0.2), clamp(vLocalY, 0.0, 1.0));
  col += fire * vState.y * flick * (0.9 + 1.8 * vLocalY);
  col += vec3(0.85, 0.14, 0.025) * vState.z * (1.0 - vState.y) * 0.22 * (1.0 - vLocalY);
  col = mix(uFogColor, col, vKeep);
  gl_FragColor = vec4(col, uOpacity);
  ${GLSL_OUTPUT}
}
`

const depthFragment = /* glsl */ `
void main() { gl_FragColor = vec4(1.0); }
`

function cone(r: number, y0: number, y1: number, seg = 7): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, y1 - y0, seg, 1, true)
  g.translate(0, (y0 + y1) / 2, 0)
  g.deleteAttribute('uv')
  return g
}

function trunk(r: number, y1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.8, r, y1, 5, 1, true)
  g.translate(0, y1 / 2, 0)
  g.deleteAttribute('uv')
  return g
}

function blob(detail: number, seed: number, lump: number, sy: number, cy: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g)
  const p = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const k = 1 + lump * Math.sin(x * 3.1 + seed) * Math.sin(y * 2.7 + seed * 1.3) * Math.sin(z * 3.4 + seed * 0.7)
    p.setXYZ(i, x * k, y * k * sy + cy, z * k)
  }
  g.computeVertexNormals()
  return g
}

/** Normalised tree shapes: base at y = 0, top at y = 1 (x height), radius <= 1 (x crown radius). */
function treeShapes(): THREE.BufferGeometry[] {
  const conifer = mergeGeometries([cone(1, 0.16, 0.62), cone(0.76, 0.4, 0.84), cone(0.5, 0.62, 1.0), trunk(0.09, 0.22)])
  const broadleaf = mergeGeometries([blob(1, 1.7, 0.2, 0.4, 0.6), trunk(0.1, 0.3)])
  const shrub = blob(0, 2.3, 0.22, 0.5, 0.5)
  return [conifer, broadleaf, shrub]
}

const ALBEDO: [string, string][] = [
  ['#17281c', '#233624'], // conifer: dark blue-green
  ['#2b3b22', '#3f4a28'], // broadleaf: olive
  ['#3e412c', '#504d35'], // shrub: grey-olive chaparral
]
const TORCH = [0.62, 0.4, 0.7]

interface TreeSet {
  geometry: THREE.InstancedBufferGeometry
  count: number
}

function buildTreeSets(trees: Float32Array | null, keepFrac: number, shapes: THREE.BufferGeometry[]): TreeSet[] {
  const n = trees ? Math.floor(trees.length / 6) : 0
  const counts = [0, 0, 0]
  const keep = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (hash01(i) >= keepFrac) continue
    const kind = Math.min(2, Math.max(0, Math.round(trees![i * 6 + 5])))
    keep[i] = 1 + kind
    counts[kind]++
  }
  const pos = counts.map((c) => new Float32Array(c * 4))
  const misc = counts.map((c) => new Float32Array(c * 2))
  const fill = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    const kind = keep[i] - 1
    const o = fill[kind]++
    const t = trees!
    pos[kind][o * 4] = t[i * 6]
    pos[kind][o * 4 + 1] = t[i * 6 + 1]
    pos[kind][o * 4 + 2] = t[i * 6 + 2]
    pos[kind][o * 4 + 3] = Math.max(0.8, t[i * 6 + 3])
    misc[kind][o * 2] = Math.max(0.6, t[i * 6 + 4])
    misc[kind][o * 2 + 1] = hash01(i * 3 + 11)
  }
  return shapes.map((shape, kind) => {
    const g = new THREE.InstancedBufferGeometry()
    g.index = shape.index
    g.setAttribute('position', shape.attributes.position)
    g.setAttribute('normal', shape.attributes.normal)
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos[kind], 4))
    g.setAttribute('iMisc', new THREE.InstancedBufferAttribute(misc[kind], 2))
    g.instanceCount = counts[kind]
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
    return { geometry: g, count: counts[kind] }
  })
}

export function Trees({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('trees')
  const style = useStore((s) => s.visualStyle)
  const quality = useStore((s) => s.quality)
  const treeScale = useStore((s) => s.treeScale)
  const exaggeration = useStore((s) => s.exaggeration)
  const shapes = useMemo(() => treeShapes(), [])
  useEffect(() => () => shapes.forEach((g) => g.dispose()), [shapes])
  const sets = useMemo(() => buildTreeSets(assets.arrays.trees, QUALITY_SCALE[quality], shapes), [assets.arrays.trees, quality, shapes])
  // Disposing frees the GPU buffers of every attribute (the shared shape buffers re-upload lazily on next use).
  useEffect(() => () => sets.forEach((s) => s.geometry.dispose()), [sets])

  const shared = useMemo(
    () => ({
      uArrival: { value: null as THREE.Texture | null },
      uHasArrival: { value: 0 },
      uTreeScale: { value: 1 },
      uSunVis: { value: null as THREE.Texture | null },
      uHasSunVis: { value: 0 },
      uOpacity: { value: 1 },
    }),
    [],
  )
  const materials = useMemo(
    () =>
      ALBEDO.map(([a, b], kind) => {
        const uniforms = { ...fxUniforms, ...shared, uAlbedo: { value: new THREE.Color(a) }, uAlbedo2: { value: new THREE.Color(b) }, uTorch: { value: TORCH[kind] } }
        const main = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: THREE.DoubleSide })
        const depth = new THREE.ShaderMaterial({ vertexShader, fragmentShader: depthFragment, uniforms })
        return { main, depth }
      }),
    [shared],
  )
  useEffect(() => () => materials.forEach((m) => {
    m.main.dispose()
    m.depth.dispose()
  }), [materials])

  useEffect(() => {
    shared.uArrival.value = assets.textures.observedArrival
    shared.uHasArrival.value = assets.textures.observedArrival ? 1 : 0
  }, [assets.textures.observedArrival, shared])

  const castShadow = quality === 'high'
  const shown = visible && style !== 'parametric'
  useEffect(() => {
    if (shown) useSceneStore.getState().requestShadowUpdate()
  }, [sets, shown, castShadow, treeScale, exaggeration])

  useFrame(() => {
    if (!shown) return
    const s = useStore.getState()
    shared.uTreeScale.value = s.treeScale
    shared.uOpacity.value = opacity
    const sv = useSceneStore.getState().terrainShadow
    shared.uSunVis.value = sv
    shared.uHasSunVis.value = sv ? 1 : 0
    const transparent = opacity < 0.999
    for (const m of materials) {
      if (m.main.transparent !== transparent) {
        m.main.transparent = transparent
        m.main.needsUpdate = true
      }
    }
  })

  if (!shown) return null
  return (
    <>
      {sets.map((set, kind) =>
        set.count > 0 ? (
          <mesh
            key={kind}
            geometry={set.geometry}
            material={materials[kind].main}
            customDepthMaterial={materials[kind].depth}
            castShadow={castShadow}
            frustumCulled={false}
          />
        ) : null,
      )}
    </>
  )
}
