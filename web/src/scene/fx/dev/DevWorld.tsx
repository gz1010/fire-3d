// FX dev world (isolated from scene-core's work in progress): a simple displaced terrain (MeshStandardMaterial from
// the shared assets, with charring by arrival time, fog and an edge fade patched in), sun + sky lights, a published
// SceneEnv matching them, orbit camera framing the fire, a hover probe writer and an FPS meter.
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { localToLonLat, raycastHeightfield, slopeAt } from '../../../lib/geo'
import { useStore } from '../../../state/store'
import { useIncidentAssets, type IncidentAssets } from '../../assets'
import { useSceneStore, type SceneEnv } from '../../sceneStore'

const SHADOW_SIZE = { high: 4096, medium: 2048, low: 0 } as const

const lin = (hex: string, k = 1): [number, number, number] => {
  const c = new THREE.Color(hex)
  return [c.r * k, c.g * k, c.b * k]
}

/** Sun direction (toward the sun) from a compass bearing the light comes FROM and an elevation. */
function sunDirection(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]
}

/** Linear-space env for the dev lighting, mirroring scene-core's look presets (scene/look.ts) without importing
 *  its work in progress. */
const DEV_LOOKS = {
  hybrid: { az: 252, el: 25, sun: ['#FFE6C8', 2.6], sky: ['#5E8A72', 0.3], ground: ['#3A3524', 0.16], horizon: '#1B281F', vis: 1.35, h: 1300, line: 1, relief: 0 },
  realistic: { az: 284, el: 18, sun: ['#FFE1BF', 3.7], sky: ['#93A9B2', 0.55], ground: ['#3B3426', 0.22], horizon: '#5A6663', vis: 2.4, h: 1600, line: 0.6, relief: 0 },
  parametric: { az: 300, el: 38, sun: ['#F2E6CC', 1.6], sky: ['#3B5446', 0.2], ground: ['#1A1D16', 0.08], horizon: '#0E1611', vis: 1.6, h: 1500, line: 1.45, relief: 1 },
} as const

function devEnv(style: SceneEnv['style'], extent: number, baseY: number): SceneEnv {
  const L = DEV_LOOKS[style]
  return {
    style,
    sunDir: sunDirection(L.az, L.el),
    sunColor: lin(L.sun[0], L.sun[1]),
    skyAmbient: lin(L.sky[0], L.sky[1]),
    groundAmbient: lin(L.ground[0], L.ground[1]),
    skyZenith: lin('#050807'),
    skyHorizon: lin(L.horizon),
    skyGround: lin('#0A0F0C'),
    fogColor: lin(L.horizon),
    fogDensity: 1 / Math.max(500, extent * L.vis),
    fogFalloff: 1 / L.h,
    fogBaseY: baseY,
    reliefMix: L.relief,
    lineGain: L.line,
  }
}

const terrainPatchPars = /* glsl */ `
uniform sampler2D uArrival;
uniform float uHasArrival;
uniform float uTimeH;
uniform float uClock;
uniform float uPara;
uniform vec3 uFogCol;
uniform float uFogDen;
uniform float uFogFall;
uniform float uFogBase;
uniform float uExtentT;
varying vec2 vUvT;
varying vec3 vWorldT;
`

function patchTerrain(mat: THREE.MeshStandardMaterial, uniforms: Record<string, THREE.IUniform>) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vUvT;\nvarying vec3 vWorldT;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvUvT = uv;\nvWorldT = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${terrainPatchPars}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lumT = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(vec3(lumT), diffuseColor.rgb, 0.7) * vec3(0.9, 1.0, 0.86);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.010, 0.013, 0.011), uPara);
        float frontT = 0.0;
        if (uHasArrival > 0.5) {
          float a = texture2D(uArrival, vUvT).r;
          float age = uTimeH - a;
          float burned = step(0.0, age) * (1.0 - uPara * 0.7);
          float neverEdge = smoothstep(1.5, 12.0, fwidth(a));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.008, 0.0065, 0.005), burned * 0.93);
          frontT = step(0.0, age) * (1.0 - smoothstep(0.0, 0.3, age)) * (1.0 - neverEdge);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.36, 0.08) * frontT * (1.1 + 0.3 * sin(uClock * 6.0 + vUvT.x * 300.0));`,
      )
      .replace(
        '#include <fog_fragment>',
        `{
          vec3 dv = vWorldT - cameraPosition;
          float y0 = clamp(cameraPosition.y - uFogBase, -3000.0, 60000.0);
          float k = clamp(uFogFall * dv.y, -60.0, 60.0);
          float shape = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
          float T = exp(-max(uFogDen * length(dv) * exp(-uFogFall * y0) * shape, 0.0));
          vec2 e2 = pow(abs(vUvT * 2.0 - 1.0), vec2(7.0));
          float edge = smoothstep(0.0, 0.128, 1.0 - pow(e2.x + e2.y, 1.0 / 7.0));
          gl_FragColor.rgb = mix(uFogCol, gl_FragColor.rgb, T * edge);
        }`,
      )
  }
}

function DevTerrain({ assets }: { assets: IncidentAssets }) {
  const exaggeration = useStore((s) => s.exaggeration)
  const style = useStore((s) => s.visualStyle)
  const quality = useStore((s) => s.quality)
  const geometry = useMemo(() => {
    const { width: w, height: h, data } = assets.elevation
    const geo = new THREE.PlaneGeometry(assets.extent, assets.extent, w - 1, h - 1)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) pos.setY(i, data[i] * exaggeration)
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    return geo
  }, [assets.elevation, assets.extent, exaggeration])
  useEffect(() => () => geometry.dispose(), [geometry])
  const uniforms = useMemo<Record<string, THREE.IUniform>>(
    () => ({
      uArrival: { value: null },
      uHasArrival: { value: 0 },
      uTimeH: { value: 0 },
      uClock: { value: 0 },
      uPara: { value: 0 },
      uFogCol: { value: new THREE.Color() },
      uFogDen: { value: 1 / 50000 },
      uFogFall: { value: 0 },
      uFogBase: { value: 0 },
      uExtentT: { value: 12000 },
    }),
    [],
  )
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
    patchTerrain(m, uniforms)
    return m
  }, [uniforms])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    material.map = style === 'parametric' ? null : assets.textures.naip
    material.aoMap = null
    material.needsUpdate = true
    uniforms.uArrival.value = assets.textures.observedArrival
    uniforms.uHasArrival.value = assets.textures.observedArrival ? 1 : 0
    uniforms.uPara.value = style === 'parametric' ? 1 : 0
    uniforms.uExtentT.value = assets.extent
  }, [assets, material, uniforms, style])
  useFrame((state) => {
    const s = useStore.getState()
    uniforms.uTimeH.value = (s.timeMs - assets.manifest.time_origin_ms) / 3.6e6
    uniforms.uClock.value = state.clock.elapsedTime
    const env = useSceneStore.getState().env
    if (env) {
      ;(uniforms.uFogCol.value as THREE.Color).setRGB(env.fogColor[0], env.fogColor[1], env.fogColor[2])
      uniforms.uFogDen.value = env.fogDensity
      uniforms.uFogFall.value = env.fogFalloff
      uniforms.uFogBase.value = env.fogBaseY
    }
  })
  return <mesh geometry={geometry} material={material} receiveShadow={quality === 'high'} frustumCulled={false} />
}

function DevLights({ assets }: { assets: IncidentAssets }) {
  const style = useStore((s) => s.visualStyle)
  const quality = useStore((s) => s.quality)
  const setEnv = useSceneStore((s) => s.setEnv)
  const exaggeration = useStore((s) => s.exaggeration)
  const env = useMemo(() => devEnv(style, assets.extent, assets.elevation.min * exaggeration), [style, assets.extent, assets.elevation.min, exaggeration])
  const sun = useRef<THREE.DirectionalLight>(null)
  useEffect(() => setEnv(env), [env, setEnv])
  useEffect(() => {
    const l = sun.current
    if (!l) return
    const ext = assets.extent
    const d = ext * 0.62
    const c = l.shadow.camera
    c.left = -d
    c.right = d
    c.top = d
    c.bottom = -d
    c.near = 10
    c.far = ext * 3
    c.updateProjectionMatrix()
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 2
    const size = SHADOW_SIZE[quality]
    if (size) l.shadow.mapSize.set(size, size)
    l.shadow.map?.dispose()
    l.shadow.map = null
    l.target.position.set(0, assets.elevation.min, 0)
    l.target.updateMatrixWorld()
  }, [assets, quality])
  const ext = assets.extent
  const sd = env.sunDir
  const toColor = (c: [number, number, number]) => new THREE.Color(c[0], c[1], c[2])
  return (
    <>
      <directionalLight
        ref={sun}
        position={[sd[0] * ext * 1.2, assets.elevation.min + sd[1] * ext * 1.2, sd[2] * ext * 1.2]}
        color={toColor(env.sunColor)}
        intensity={Math.PI}
        castShadow={quality === 'high'}
      />
      <hemisphereLight args={[toColor(env.skyAmbient), toColor(env.groundAmbient), Math.PI]} />
    </>
  )
}

function burnedCentroid(assets: IncidentAssets): [number, number] {
  const a = assets.arrays.observedArrival
  const { width: w } = assets.arrays.fireGrid
  if (!a) return [0, 0]
  let n = 0
  let sx = 0
  let sz = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] >= 5e4) continue
    const r = (i / w) | 0
    n++
    sx += i - r * w
    sz += r
  }
  if (!n) return [assets.manifest.ignition?.x ?? 0, assets.manifest.ignition?.z ?? 0]
  const res = assets.extent / w
  return [(sx / n + 0.5) * res - assets.extent / 2, (sz / n + 0.5) * res - assets.extent / 2]
}

/** Initial oblique view from the south-south-east framing the fire; ?cam=px,py,pz,tx,ty,tz overrides. */
function DevCamera({ assets }: { assets: IncidentAssets }) {
  const camera = useThree((s) => s.camera)
  const controls = useRef<React.ComponentRef<typeof OrbitControls>>(null)
  const id = assets.manifest.id
  useEffect(() => {
    const ext = assets.extent
    const ex = useStore.getState().exaggeration
    const q = new URLSearchParams(location.search).get('cam')
    const v = q?.split(',').map(Number)
    let tx: number
    let ty: number
    let tz: number
    if (v && v.length === 6 && v.every(Number.isFinite)) {
      camera.position.set(v[0], v[1], v[2])
      ;[tx, ty, tz] = [v[3], v[4], v[5]]
    } else {
      const [cx, cz] = burnedCentroid(assets)
      tx = cx
      tz = cz
      ty = assets.heightAt(tx, tz) * ex
      const dist = ext * 0.9
      const el = 0.6
      const az = Math.PI * (1 - 0.12)
      camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, tz - Math.cos(az) * Math.cos(el) * dist)
    }
    camera.lookAt(tx, ty, tz)
    if (controls.current) {
      controls.current.target.set(tx, ty, tz)
      controls.current.update()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.47} minDistance={150} maxDistance={assets.extent * 3} />
}

/** Hover probe (scene-core writes it in the app; the dev page writes it here). */
function DevProbe({ assets }: { assets: IncidentAssets }) {
  const { gl, camera } = useThree()
  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    let raf = 0
    let last: PointerEvent | null = null
    const run = () => {
      raf = 0
      const e = last
      if (!e) return
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const s = useStore.getState()
      const p = raycastHeightfield(ray.ray.origin, ray.ray.direction, assets, s.exaggeration, hit)
      if (!p) {
        useSceneStore.getState().setProbe(null)
        return
      }
      const m = assets.manifest
      const [lon, lat] = localToLonLat(p.x, p.z, m.grid)
      const fw = assets.arrays.fireGrid.width
      const fh = assets.arrays.fireGrid.height
      const c = Math.min(fw - 1, Math.max(0, Math.floor(((p.x + assets.extent / 2) / assets.extent) * fw)))
      const rr = Math.min(fh - 1, Math.max(0, Math.floor(((p.z + assets.extent / 2) / assets.extent) * fh)))
      const k = rr * fw + c
      const arr = assets.arrays.observedArrival?.[k]
      const p50 = assets.arrays.arrivalP50?.[k]
      useSceneStore.getState().setProbe({
        x: p.x,
        z: p.z,
        lat,
        lon,
        elev: assets.heightAt(p.x, p.z),
        fuel: assets.arrays.fuel?.[k] ?? 0,
        arrivalH: arr != null && arr < 5e4 ? arr : null,
        pBurn: assets.arrays.burnProbability?.[k] ?? null,
        slope: slopeAt(assets.elevation, p.x, p.z, assets.extent),
        screenX: e.clientX - r.left,
        screenY: e.clientY - r.top,
        canopyPct: assets.arrays.canopyCover?.[k] ?? null,
        arrivalP50H: p50 != null && p50 < 5e4 ? p50 : null,
      })
    }
    const move = (e: PointerEvent) => {
      last = e
      if (!raf) raf = requestAnimationFrame(run)
    }
    const leave = () => useSceneStore.getState().setProbe(null)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [gl, camera, assets])
  return null
}

/** FPS meter: frame intervals over the last 0.5 s -> sceneStore.fps; window.__fxDev.measureFps for scripts. */
function DevFps() {
  const acc = useRef({ n: 0, t: 0 })
  useFrame((_, delta) => {
    const a = acc.current
    a.n++
    a.t += delta
    if (a.t >= 0.5) {
      useSceneStore.getState().setFps(Math.round(a.n / a.t))
      a.n = 0
      a.t = 0
    }
  })
  return null
}

export function DevWorld() {
  const assets = useIncidentAssets()
  if (!assets) return null
  return (
    <>
      <DevTerrain assets={assets} />
      <DevLights assets={assets} />
      <DevCamera assets={assets} />
      <DevProbe assets={assets} />
      <DevFps />
    </>
  )
}
