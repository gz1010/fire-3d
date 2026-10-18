// Scene-fx shared state. fxStore (zustand) holds the active fronts (React consumers re-render when they change);
// fxShared is a mutable per-frame blackboard written by <FxDriver/> (useFrame priority -2, before every other fx
// callback) and read inside useFrame callbacks.
import * as THREE from 'three'
import { create } from 'zustand'
import { fxUniforms } from './common'

export interface FrontCluster {
  rank: number // 0 = longest active front
  x: number // centroid, local m
  z: number
  elev: number // m (not exaggerated)
  pixels: number // pixels burned in the last hour
  edgePixels: number // leading-edge pixels (next to unburned)
  lengthM: number // leading-edge length estimate
  growthAcPerH: number // area burned in the last hour
  rosChPerH: number | null // median local rate of spread on the leading edge (chains/h)
  frpMw: number | null // FRP of the latest satellite pass over the cluster
  frpInstrument: string | null
  frpTMs: number | null
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface ActiveFronts {
  key: string // assets key + source
  tH: number // sim time used (hours since time_origin)
  tMs: number
  source: 'observed' | 'forecast'
  clusters: FrontCluster[] // sorted by lengthM, descending
  /** 4 floats per sample: x, z, elevation (m), weight 0..1 (recency within the hour). Leading-edge pixels. */
  samples: Float32Array
  sampleCount: number
  totalLengthM: number
  totalPixels: number
  totalFrpMw: number
  /** Recent satellite detections as smoke emitters: 4 floats each: x, z, elevation (m), weight (FRP x recency). */
  detEmitters: Float32Array
  detEmitterCount: number
  detEmitterWeight: number
}

export interface FxStoreState {
  fronts: ActiveFronts | null
  frontsVersion: number
}

export const fxStore = create<FxStoreState>()(() => ({ fronts: null, frontsVersion: 0 }))

export interface WindState {
  u: Float32Array // 16 values [j][i], m/s east+
  v: Float32Array // 16 values, m/s north+
  uv: Float32Array // interleaved u,v (the shared vec2[16] uniform array)
  axes: THREE.Vector4 // x0, dx, z0, dz of the grid cell centres (the shared uniform vector)
  valid: boolean
  meanSpeed: number
}

/** Mutable blackboard, updated once per frame by FxDriver before every other fx callback. */
export const fxShared = {
  /** Sim time (hours since manifest.time_origin_ms) and epoch ms. */
  tH: 0,
  tMs: 0,
  /** Animation clock in seconds (slowed down with prefers-reduced-motion). */
  clock: 0,
  /** Frame delta of the animation clock (s, clamped). */
  dt: 0,
  /** Unit vector towards the sun (scene env, else a default). */
  sunDir: new THREE.Vector3(0.55, 0.62, 0.55).normalize(),
  /** Camera to orbit-target distance (m) and the target point. */
  camDist: 10000,
  target: new THREE.Vector3(),
  wind: {
    u: new Float32Array(16),
    v: new Float32Array(16),
    uv: fxUniforms.uWind.value,
    axes: fxUniforms.uWindAxes.value,
    valid: false,
    meanSpeed: 0,
  } as WindState,
  /** Blurred active-front proximity (lattice "activity"), plane UV. */
  frontTex: null as THREE.DataTexture | null,
  frontsVersion: 0,
  /** Fire footprint (observed final burned area ∪ forecast reach): centroid + radius (m), for radial falloffs. */
  fireX: 0,
  fireZ: 0,
  fireRadius: 3000,
  /** Wall-clock ms (performance.now) when the current incident's fx were built (scan sweep start). */
  loadedAt: 0,
  /** Screen rects (CSS px: x0, y0, x1, y1) of the visible telemetry columns, for lower-priority labels. */
  labelRects: new Float32Array(4 * 16),
  labelRectCount: 0,
}
