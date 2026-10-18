// FxDriver: the first fx useFrame callback (priority -2). It publishes the shared per-frame state every other fx
// layer reads: sim time, animation clock, scene env (sun + fog), viewport, camera target/distance, the wind grid at
// the current time, and the active fire fronts (recomputed when sim time moves >= 10 min, throttled during playback).
// Fronts come from the observed arrival raster; in live mode after "now" they come from the forecast p50 arrival.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { WeatherFile } from '../../api/types'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { useSceneStore } from '../sceneStore'
import { FINITE_MAX, HEX, HOUR_MS, STYLE_INDEX, fogDensity, fxUniforms, makeHeightSampler, useReducedMotion } from './common'
import { FrontField, buildArrivalIndex, buildDetectionIndex, computeFronts, type ArrivalIndex } from './fronts'
import { fxShared, fxStore, type ActiveFronts } from './state'
import { updateWind } from './wind'

const FRONT_STEP_H = 10 / 60
const DEFAULT_FOG = new THREE.Color(HEX.fog)

/** Centroid + radius of the fire footprint (observed burned ∪ forecast reach with P >= 0.1). */
function footprint(arr: Float32Array | null, prob: Float32Array | null, w: number, h: number, extent: number): { x: number; z: number; r: number } {
  const res = extent / w
  const half = extent / 2
  let n = 0
  let sx = 0
  let sz = 0
  const hit = (i: number) => (arr != null && arr[i] < FINITE_MAX) || (prob != null && prob[i] >= 0.1)
  for (let i = 0; i < w * h; i++) {
    if (!hit(i)) continue
    const r = (i / w) | 0
    n++
    sx += i - r * w
    sz += r
  }
  if (n === 0) return { x: 0, z: 0, r: extent * 0.3 }
  const cx = (sx / n + 0.5) * res - half
  const cz = (sz / n + 0.5) * res - half
  const hist = new Uint32Array(256)
  const maxD = extent * 0.75
  for (let i = 0; i < w * h; i++) {
    if (!hit(i)) continue
    const r = (i / w) | 0
    const d = Math.hypot((i - r * w + 0.5) * res - half - cx, (r + 0.5) * res - half - cz)
    hist[Math.min(255, Math.floor((d / maxD) * 256))]++
  }
  let acc = 0
  let p90 = maxD
  for (let b = 0; b < 256; b++) {
    acc += hist[b]
    if (acc >= n * 0.92) {
      p90 = ((b + 1) / 256) * maxD
      break
    }
  }
  return { x: cx, z: cz, r: Math.max(1500, p90 * 1.15 + 500) }
}

export function FxDriver({ assets }: { assets: IncidentAssets }) {
  const detections = useStore((s) => s.detections)
  const reduced = useReducedMotion()
  const m = assets.manifest
  const { width: fw, height: fh } = assets.arrays.fireGrid
  const extent = assets.extent
  const obs = assets.arrays.observedArrival
  const p50 = assets.arrays.arrivalP50
  const prob = assets.arrays.burnProbability

  const obsIndex = useMemo<ArrivalIndex | null>(() => (obs && obs.length === fw * fh ? buildArrivalIndex(obs, fw, fh, extent) : null), [obs, fw, fh, extent])
  const p50Index = useMemo<ArrivalIndex | null>(() => (p50 && p50.length === fw * fh ? buildArrivalIndex(p50, fw, fh, extent) : null), [p50, fw, fh, extent])
  const detIndex = useMemo(() => buildDetectionIndex(detections?.detections), [detections])
  const field = useMemo(() => new FrontField(fw, extent / fw), [fw, extent])
  const heightAt = useMemo(() => makeHeightSampler(assets.elevation, extent), [assets.elevation, extent])
  const st = useRef({
    lastTH: Number.NaN,
    lastAssetsKey: '',
    lastFc: false,
    lastDetGen: -1,
    lastReal: 0,
    lastWindMs: Number.NaN,
    weather: null as WeatherFile | null,
    reuse: null as ActiveFronts | null,
    detGen: 0,
  })

  useEffect(() => {
    st.current.detGen++
  }, [detIndex])

  useEffect(() => {
    fxShared.frontTex = field.texture
    return () => {
      if (fxShared.frontTex === field.texture) fxShared.frontTex = null
      field.dispose()
    }
  }, [field])

  useEffect(() => {
    const f = footprint(obs, prob, fw, fh, extent)
    fxShared.fireX = f.x
    fxShared.fireZ = f.z
    fxShared.fireRadius = f.r
  }, [obs, prob, fw, fh, extent])

  useEffect(() => {
    fxShared.loadedAt = performance.now()
    st.current.lastAssetsKey = ''
    st.current.reuse = null
    fxStore.setState({ fronts: null, frontsVersion: fxStore.getState().frontsVersion + 1 })
    return () => fxStore.setState({ fronts: null, frontsVersion: fxStore.getState().frontsVersion + 1 })
  }, [m.id])

  useFrame((state, delta) => {
    const s = useStore.getState()
    const u = fxUniforms
    const k = st.current
    const dt = Math.min(0.1, Math.max(0, delta)) * (reduced ? 0.35 : 1)
    fxShared.dt = dt
    fxShared.clock += dt
    u.uClock.value = fxShared.clock

    const tMs = s.timeMs
    const tH = (tMs - m.time_origin_ms) / HOUR_MS
    fxShared.tMs = tMs
    fxShared.tH = tH
    u.uTimeH.value = tH
    u.uExag.value = s.exaggeration
    u.uExtent.value = extent
    u.uStyle.value = STYLE_INDEX[s.visualStyle]

    const dpr = state.gl.getPixelRatio()
    u.uPixelRatio.value = dpr
    u.uViewport.value.set(Math.max(1, state.size.width * dpr), Math.max(1, state.size.height * dpr))

    const env = useSceneStore.getState().env
    if (env) {
      fxShared.sunDir.set(env.sunDir[0], env.sunDir[1], env.sunDir[2]).normalize()
      u.uSunColor.value.setRGB(env.sunColor[0], env.sunColor[1], env.sunColor[2])
      u.uSkyAmbient.value.setRGB(env.skyAmbient[0], env.skyAmbient[1], env.skyAmbient[2])
      u.uGroundAmbient.value.setRGB(env.groundAmbient[0], env.groundAmbient[1], env.groundAmbient[2])
      u.uFogColor.value.setRGB(env.fogColor[0], env.fogColor[1], env.fogColor[2])
      u.uFogDensity.value = env.fogDensity
      u.uFogFalloff.value = env.fogFalloff
      u.uFogBaseY.value = env.fogBaseY
      u.uLineGain.value = env.lineGain
    } else {
      fxShared.sunDir.set(0.55, 0.62, 0.55).normalize()
      u.uSunColor.value.setRGB(1.05, 0.98, 0.88)
      u.uSkyAmbient.value.setRGB(0.2, 0.24, 0.23)
      u.uGroundAmbient.value.setRGB(0.07, 0.07, 0.06)
      u.uFogColor.value.copy(DEFAULT_FOG)
      u.uFogDensity.value = fogDensity(extent)
      u.uFogFalloff.value = 0
      u.uFogBaseY.value = 0
      u.uLineGain.value = s.visualStyle === 'parametric' ? 1.4 : s.visualStyle === 'realistic' ? 0.6 : 1
    }
    u.uSunDir.value.copy(fxShared.sunDir)

    const controls = state.controls as unknown as { target?: THREE.Vector3 } | null
    if (controls?.target) fxShared.target.copy(controls.target)
    else fxShared.target.set(fxShared.fireX, heightAt(fxShared.fireX, fxShared.fireZ) * s.exaggeration, fxShared.fireZ)
    fxShared.camDist = state.camera.position.distanceTo(fxShared.target)
    u.uCamDist.value = fxShared.camDist

    if (s.weather !== k.weather || !(Math.abs(tMs - k.lastWindMs) < 60_000)) {
      updateWind(s.weather, tMs, fxShared.wind)
      k.weather = s.weather
      k.lastWindMs = tMs
    }

    const useFc = m.mode === 'live' && tMs > m.time_range.now_ms && p50Index != null
    const index = useFc ? p50Index : obsIndex
    if (!index) {
      if (fxStore.getState().fronts) fxStore.setState({ fronts: null, frontsVersion: fxStore.getState().frontsVersion + 1 })
      return
    }
    const now = performance.now()
    const moved = !(Math.abs(tH - k.lastTH) < FRONT_STEP_H)
    const changed = assets.key !== k.lastAssetsKey || useFc !== k.lastFc || k.detGen !== k.lastDetGen
    if (changed || (moved && (!s.playing || now - k.lastReal > 90))) {
      const key = `${assets.key}|${useFc ? 'forecast' : 'observed'}|${k.detGen}`
      const fronts = computeFronts({ index, tH, tMs, key, source: useFc ? 'forecast' : 'observed', heightAt, detections: detIndex, reuse: k.reuse })
      k.reuse = fronts
      field.update(index, tH)
      k.lastAssetsKey = assets.key
      k.lastFc = useFc
      k.lastDetGen = k.detGen
      k.lastTH = tH
      k.lastReal = now
      fxShared.frontsVersion++
      fxStore.setState({ fronts, frontsVersion: fxStore.getState().frontsVersion + 1 })
    }
  }, -2)

  return null
}
