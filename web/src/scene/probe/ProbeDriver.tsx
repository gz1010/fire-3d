// Hover probe (SPEC 9.3): the pointer ray is intersected with the displaced heightfield (lib/geo raycastHeightfield)
// once per frame while the cursor is over the canvas; the values under the cursor go to sceneStore.probe:
// lat/lon, elevation, fuel model, observed arrival, forecast burn probability (horizon and at the current time),
// slope, canopy. Hidden while dragging or during camera animations. Values refresh when the cursor, the camera or
// the timeline (>= 10 min of simulation time) change.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { localToLonLat, raycastHeightfield, sampleBilinear, sampleNearest, slopeAt } from '../../lib/geo'
import { NEVER_THRESHOLD } from '../../lib/raster'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { camState } from '../camera/cameraState'
import { useSceneStore, type Probe } from '../sceneStore'

const HOUR = 3_600_000
const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _hit = new THREE.Vector3()
const _lastCam = new THREE.Matrix4()

/** P(burned by t) from the forecast quantiles at one pixel (piecewise linear, capped by the horizon probability). */
export function probabilityAt(t: number, p10: number, p50: number, p90: number, pHorizon: number): number {
  const fin = (v: number) => v < NEVER_THRESHOLD
  let p: number
  if (!fin(p10) || t < p10) {
    const d = fin(p50) && fin(p10) ? Math.max(0.5, (p50 - p10) * 0.5) : 0.5
    p = fin(p10) ? 0.1 * Math.min(1, Math.max(0, 1 - (p10 - t) / d)) : 0
  } else if (!fin(p50) || t < p50) {
    p = fin(p50) ? 0.1 + (0.4 * (t - p10)) / Math.max(p50 - p10, 1e-3) : 0.1
  } else if (!fin(p90) || t < p90) {
    p = fin(p90) ? 0.5 + (0.4 * (t - p50)) / Math.max(p90 - p50, 1e-3) : 0.5
  } else {
    p = 0.9 + 0.1 * Math.min(1, Math.max(0, (t - p90) / Math.max(0.5, (p90 - p50) * 0.5)))
  }
  return Math.min(p, pHorizon)
}

export function ProbeDriver({ assets }: { assets: IncidentAssets | null }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const ptr = useRef({ x: 0, y: 0, inside: false, down: false, dirty: false })
  const last = useRef({ x: Number.NaN, z: Number.NaN, tMs: Number.NaN, sx: -1, sy: -1, key: '' })

  useEffect(() => {
    const el = gl.domElement
    const p = ptr.current
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      p.x = e.clientX - r.left
      p.y = e.clientY - r.top
      p.inside = true
      p.dirty = true
    }
    const onLeave = () => {
      p.inside = false
      p.dirty = true
    }
    const onDown = () => {
      p.down = true
      p.dirty = true
    }
    const onUp = () => {
      p.down = false
      p.dirty = true
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('blur', onLeave)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('blur', onLeave)
      useSceneStore.getState().setProbe(null)
    }
  }, [gl])

  useFrame(() => {
    const p = ptr.current
    const store = useSceneStore.getState()
    const camMoved = !_lastCam.equals(camera.matrixWorld)
    if (camMoved) _lastCam.copy(camera.matrixWorld)
    const s = useStore.getState()
    const l = last.current
    const timeMoved = Math.abs(s.timeMs - l.tMs) >= 10 * 60_000
    if (!p.dirty && !camMoved && !timeMoved) return
    p.dirty = false
    if (!assets || !p.inside || p.down || camState.animating) {
      if (store.probe) store.setProbe(null)
      l.key = ''
      return
    }
    const el = gl.domElement
    const w = el.clientWidth || 1
    const h = el.clientHeight || 1
    _ndc.set((p.x / w) * 2 - 1, -(p.y / h) * 2 + 1)
    _ray.setFromCamera(_ndc, camera)
    const hit = raycastHeightfield(_ray.ray.origin, _ray.ray.direction, assets, s.exaggeration, _hit)
    if (!hit) {
      if (store.probe) store.setProbe(null)
      l.key = ''
      return
    }
    const x = hit.x
    const z = hit.z
    const key = `${x.toFixed(1)}|${z.toFixed(1)}|${Math.round(p.x)}|${Math.round(p.y)}|${Math.floor(s.timeMs / 600_000)}|${assets.key}`
    if (key === l.key) return
    l.key = key
    l.tMs = s.timeMs
    const m = assets.manifest
    const ext = assets.extent
    const a = assets.arrays
    const fw = a.fireGrid.width
    const fh = a.fireGrid.height
    const [lon, lat] = localToLonLat(x, z, m.grid)
    const arr = a.observedArrival ? sampleNearest(a.observedArrival, fw, fh, x, z, ext) : Number.POSITIVE_INFINITY
    const f = assets.forecast
    let pBurn: number | null = null
    let pBurnNow: number | null = null
    let arrivalP50H: number | null = null
    if (f && a.burnProbability) {
      pBurn = Math.min(1, Math.max(0, sampleBilinear(a.burnProbability, fw, fh, x, z, ext)))
      const off = (f.time_origin_ms - m.time_origin_ms) / HOUR
      const q = (arr2: Float32Array | null) => (arr2 ? sampleNearest(arr2, fw, fh, x, z, ext) : Number.POSITIVE_INFINITY)
      const p10 = q(a.arrivalP10)
      const p50 = q(a.arrivalP50)
      const p90 = q(a.arrivalP90)
      arrivalP50H = p50 < NEVER_THRESHOLD ? p50 + off : null
      const tF = (s.timeMs - f.time_origin_ms) / HOUR
      const startF = (f.start_ms - f.time_origin_ms) / HOUR
      pBurnNow = tF < startF ? 0 : probabilityAt(tF, p10, p50, p90, pBurn)
    }
    const probe: Probe = {
      x,
      z,
      lat,
      lon,
      elev: assets.heightAt(x, z),
      fuel: a.fuel ? sampleNearest(a.fuel, fw, fh, x, z, ext) : 0,
      arrivalH: arr < NEVER_THRESHOLD ? arr : null,
      pBurn,
      slope: slopeAt(assets.elevation, x, z, ext),
      screenX: p.x,
      screenY: p.y,
      canopyPct: a.canopyCover ? sampleNearest(a.canopyCover, fw, fh, x, z, ext) : null,
      arrivalP50H,
      pBurnNow,
    }
    store.setProbe(probe)
  })

  return null
}
