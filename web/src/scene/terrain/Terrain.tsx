// Terrain mesh (SPEC 9.3): a regular grid on the render-grid pixel centres (vertex row 0 = north edge = elevation
// row 0), elevation in metres in position.y and exaggerated in the vertex shader (exaggeration changes cost nothing).
// Normals, contours and overlays are computed per fragment from the elevation texture. Drives the terrain shader's
// uniforms every frame from the store (time, layers), the current look and the camera, and re-bakes the soft sun
// shadow when the exaggeration or the sun changes (cross-fading during style transitions).
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { FUEL_DATAVIZ_LUT, FUEL_REALISTIC_LUT } from '../../lib/fuels'
import { lutAtlasTexture } from '../../lib/raster'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { atmosphereFrame, updateAtmosphereUniforms } from '../atmosphere/atmosphere'
import { camState } from '../camera/cameraState'
import { contourInterval, fireFrame, isochroneStep } from '../frame'
import { ease, look } from '../look'
import { reducedMotion } from '../motion'
import { useSceneStore } from '../sceneStore'
import { SunBaker } from './sunBake'
import { createTerrainDepthMaterial, createTerrainMaterial } from './terrainMaterial'

const HOUR = 3_600_000

let fuelLut: THREE.DataTexture | null = null
/** Fuel LUT atlas: row 0 realistic albedo, row 1 data-viz palette (created once, shared). */
function fuelLutTexture(): THREE.DataTexture {
  if (!fuelLut) fuelLut = lutAtlasTexture([FUEL_REALISTIC_LUT, FUEL_DATAVIZ_LUT], 'fuel_luts')
  return fuelLut
}

/** Grid mesh over the render-grid pixel centres; y = raw elevation (m). */
export function buildTerrainGeometry(elev: IncidentAssets['elevation'], extent: number): THREE.BufferGeometry {
  const { width: w, height: h, data } = elev
  const res = extent / w
  const half = extent / 2
  const pos = new Float32Array(w * h * 3)
  for (let r = 0; r < h; r++) {
    const z = -half + (r + 0.5) * (extent / h)
    for (let c = 0; c < w; c++) {
      const i = r * w + c
      pos[i * 3] = -half + (c + 0.5) * res
      pos[i * 3 + 1] = data[i]
      pos[i * 3 + 2] = z
    }
  }
  const idx = new Uint32Array((w - 1) * (h - 1) * 6)
  let k = 0
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c
      const b = a + 1
      const d = a + w
      const e = d + 1
      // alternate the diagonal so the triangulation has no directional bias
      if ((r + c) & 1) {
        idx[k++] = a; idx[k++] = d; idx[k++] = b
        idx[k++] = b; idx[k++] = d; idx[k++] = e
      } else {
        idx[k++] = a; idx[k++] = d; idx[k++] = e
        idx[k++] = a; idx[k++] = e; idx[k++] = b
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-half, elev.min, -half), new THREE.Vector3(half, elev.max * 4, half))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (elev.min + elev.max) / 2, 0), extent)
  return geo
}

interface BakeState {
  cur: 0 | 1
  elevUuid: string
  exag: number
  version: number
  inTransition: boolean
}

type LayerMap = ReturnType<typeof useStore.getState>['layers']
const layerOpacity = (L: LayerMap, k: keyof LayerMap) => (L[k].visible ? L[k].opacity : 0)

export function Terrain({ assets }: { assets: IncidentAssets }) {
  const gl = useThree((s) => s.gl)
  const setTerrainReady = useSceneStore((s) => s.setTerrainReady)
  const geometry = useMemo(() => buildTerrainGeometry(assets.elevation, assets.extent), [assets.elevation, assets.extent])
  const material = useMemo(() => createTerrainMaterial(), [])
  const depthMaterial = useMemo(() => createTerrainDepthMaterial(material.uniforms.uExag), [material])
  const baker = useMemo(() => new SunBaker(assets.elevation.width), [assets.elevation.width])
  const bake = useRef<BakeState>({ cur: 0, elevUuid: '', exag: Number.NaN, version: -1, inTransition: false })

  useEffect(
    () => () => {
      material.dispose()
      depthMaterial.dispose()
    },
    [material, depthMaterial],
  )
  useEffect(() => {
    bake.current = { cur: 0, elevUuid: '', exag: Number.NaN, version: -1, inTransition: false }
    return () => {
      baker.dispose()
      useSceneStore.getState().setTerrainShadow(null)
    }
  }, [baker])
  useEffect(() => {
    setTerrainReady(true)
    return () => {
      geometry.dispose()
      setTerrainReady(false)
    }
  }, [geometry, setTerrainReady])

  // static inputs
  useEffect(() => {
    const u = material.uniforms
    const t = assets.textures
    u.uElev.value = t.elevation
    ;(u.uElevTexel.value as THREE.Vector2).set(1 / assets.elevation.width, 1 / assets.elevation.height)
    u.uExtent.value = assets.extent
    u.uNaip.value = t.naip
    u.uFuel.value = t.fuel
    u.uHasFuel.value = t.fuel ? 1 : 0
    u.uLut.value = fuelLutTexture()
    u.uCanopy.value = t.canopyCover
    u.uHasCanopy.value = t.canopyCover ? 1 : 0
    u.uSkyView.value = t.skyView
    u.uHasSkyView.value = t.skyView ? 1 : 0
    u.uWater.value = t.water
    u.uHasWater.value = t.water ? 1 : 0
    u.uObserved.value = t.observedField
    u.uHasObserved.value = t.observedField ? 1 : 0
    u.uForecast.value = t.forecastField
    u.uHasForecast.value = t.forecastField ? 1 : 0
    u.uSeverity.value = t.burnSeverity
    u.uHasSeverity.value = t.burnSeverity ? 1 : 0
    u.uContourInterval.value = contourInterval(assets.extent)
    const ff = fireFrame(assets)
    ;(u.uFireCenter.value as THREE.Vector2).set(ff.cx, ff.cz)
    atmosphereFrame.extent = assets.extent
    // any sampler that stays null still needs a valid texture object
    for (const k of ['uNaip', 'uFuel', 'uCanopy', 'uSkyView', 'uWater', 'uObserved', 'uForecast', 'uSeverity']) {
      if (!u[k].value) u[k].value = blankTexture()
    }
  }, [assets, material])

  // scan sweep once per incident (skipped with reduced motion)
  useEffect(() => {
    const ff = fireFrame(assets)
    const half = assets.extent / 2
    const radius = Math.max(...[-half, half].flatMap((x) => [-half, half].map((z) => Math.hypot(x - ff.cx, z - ff.cz))))
    useSceneStore.getState().setSweep(reducedMotion() ? null : { startedAt: performance.now() + 400, durationMs: 2600, cx: ff.cx, cz: ff.cz, radius })
    material.uniforms.uSweepWidth.value = Math.max(300, assets.extent * 0.05)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets.manifest.id, assets.manifest.built_ms, material])

  useFrame((state) => {
    const s = useStore.getState()
    const u = material.uniforms
    const c = look.current
    const exag = s.exaggeration
    u.uExag.value = exag
    atmosphereFrame.baseY = assets.elevation.min * exag
    updateAtmosphereUniforms(u)

    // soft sun shadow: re-bake on exaggeration / sun changes, cross-fade during style transitions
    const b = bake.current
    const elevUuid = assets.textures.elevation.uuid
    const transitioning = look.progress < 1
    if (b.elevUuid !== elevUuid || b.exag !== exag || b.version !== look.version) {
      const from = transitioning ? look.from.sunDir : c.sunDir
      baker.bake(gl, b.cur, assets.textures.elevation, assets.elevation.width, assets.extent, exag, from)
      if (transitioning) baker.bake(gl, (1 - b.cur) as 0 | 1, assets.textures.elevation, assets.elevation.width, assets.extent, exag, look.target.sunDir)
      b.inTransition = transitioning
      b.elevUuid = elevUuid
      b.exag = exag
      b.version = look.version
      useSceneStore.getState().setTerrainShadow(baker.targets[b.cur].texture)
    }
    if (b.inTransition && !transitioning) {
      b.cur = (1 - b.cur) as 0 | 1
      b.inTransition = false
      useSceneStore.getState().setTerrainShadow(baker.targets[b.cur].texture)
    }
    u.uBakeA.value = baker.targets[b.cur].texture
    u.uBakeB.value = baker.targets[1 - b.cur].texture
    u.uBakeMix.value = b.inTransition ? ease(look.progress) : 0

    // look
    ;(u.uSunColor.value as THREE.Color).setRGB(c.sunColor[0], c.sunColor[1], c.sunColor[2])
    ;(u.uSkyAmb.value as THREE.Color).setRGB(c.skyAmbient[0], c.skyAmbient[1], c.skyAmbient[2])
    ;(u.uGroundAmb.value as THREE.Color).setRGB(c.groundAmbient[0], c.groundAmbient[1], c.groundAmbient[2])
    ;(u.uNaipTint.value as THREE.Color).setRGB(c.naipTint[0], c.naipTint[1], c.naipTint[2])
    u.uReliefMix.value = c.reliefMix
    u.uLineGain.value = c.lineGain
    u.uRealistic.value = c.realistic
    u.uNaipSat.value = c.naipSaturation
    u.uNaipGain.value = c.naipGain
    u.uNaipGreen.value = c.naipGreen
    u.uDetail.value = c.detail
    u.uWaterGlint.value = c.waterGlint

    // time
    const m = assets.manifest
    const tH = (s.timeMs - m.time_origin_ms) / HOUR
    u.uTimeH.value = tH
    const f = assets.forecast
    if (f) {
      u.uFcTimeH.value = (s.timeMs - f.time_origin_ms) / HOUR
      u.uFcStartH.value = (f.start_ms - f.time_origin_ms) / HOUR
      u.uFcEndH.value = (f.start_ms + f.horizon_h * HOUR - f.time_origin_ms) / HOUR
      u.uFcObsStartH.value = (f.start_ms - m.time_origin_ms) / HOUR
    }
    u.uClock.value = state.clock.elapsedTime * (reducedMotion() ? 0.15 : 1)

    // layers (opacity 0 = off)
    const L = s.layers
    const t = assets.textures
    u.uTerrainOpacity.value = layerOpacity(L, 'terrain')
    u.uImagery.value = t.naip ? layerOpacity(L, 'imagery') : 0
    u.uObsOpacity.value = t.observedField ? layerOpacity(L, 'observedFire') : 0
    u.uIsoOpacity.value = t.observedField ? layerOpacity(L, 'isochrones') : 0
    u.uContourOpacity.value = layerOpacity(L, 'contours')
    u.uForecastOpacity.value = t.forecastField ? layerOpacity(L, 'forecast') : 0
    u.uScarOpacity.value = t.burnSeverity ? layerOpacity(L, 'burnScar') : 0
    u.uFuelsOpacity.value = t.fuel ? layerOpacity(L, 'fuels') : 0

    // isochrone step by fire duration and zoom
    const ff = fireFrame(assets)
    u.uIsoStep.value = isochroneStep(Math.max(1, ff.lastH - ff.firstH), camState.distance, assets.extent)

    // scan sweep
    const sw = useSceneStore.getState().sweep
    if (sw) {
      const p = (performance.now() - sw.startedAt) / sw.durationMs
      ;(u.uFireCenter.value as THREE.Vector2).set(sw.cx, sw.cz)
      u.uSweep.value = p < 0 ? 0 : p < 1 ? ease(Math.min(1, p)) * sw.radius : -1
    } else {
      u.uSweep.value = -1
    }
  })

  return (
    <>
      {/* depth pre-pass: the shaded pass below then runs its fragment shader once per visible pixel */}
      <mesh geometry={geometry} material={depthMaterial} renderOrder={-100} frustumCulled={false} name="fire3d-terrain-depth" />
      <mesh geometry={geometry} material={material} renderOrder={-90} receiveShadow castShadow={false} frustumCulled={false} name="fire3d-terrain" />
    </>
  )
}

let blank: THREE.DataTexture | null = null
function blankTexture(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    blank.needsUpdate = true
  }
  return blank
}
