// Active fire fronts from an arrival-time raster (fire grid, hours since time_origin, NEVER = 1e6).
// Active pixels at time t: t - 1h < a <= t. Connected components (8-neighbour) become clusters with centroid,
// leading-edge length (active pixels next to unburned ones), growth, median local ROS (1/|grad a|) and the FRP of
// the latest satellite pass over them. Burned pixels are pre-sorted by arrival once per raster, so each update
// only touches the pixels inside the one-hour window.
import * as THREE from 'three'
import type { Detection } from '../../api/types'
import { ACRE_M2, CHAIN_M } from '../../lib/format'
import { FINITE_MAX, HOUR_MS } from './common'
import type { ActiveFronts, FrontCluster } from './state'

export const MAX_FRONT_SAMPLES = 4096
const MAX_DET_EMITTERS = 512

export interface ArrivalIndex {
  arr: Float32Array
  w: number
  h: number
  res: number
  extent: number
  /** Burned pixel indices sorted by arrival, and their arrival times. */
  order: Int32Array
  times: Float32Array
  // scratch (reused between updates)
  active: Int32Array
  visit: Int32Array
  queue: Int32Array
  edges: Int32Array
  ros: Float32Array
  stamp: number
}

/** Sort burned pixels by arrival (numeric Float64 key sort: fast and allocation-light). */
export function buildArrivalIndex(arr: Float32Array, w: number, h: number, extent: number): ArrivalIndex {
  const n0 = w * h
  let bits = 1
  while (bits < n0) bits *= 2
  let n = 0
  for (let i = 0; i < n0; i++) if (arr[i] < FINITE_MAX) n++
  const keys = new Float64Array(n)
  let k = 0
  for (let i = 0; i < n0; i++) {
    const a = arr[i]
    if (a < FINITE_MAX) keys[k++] = Math.round((a + 2000) * 1e4) * bits + i
  }
  keys.sort()
  const order = new Int32Array(n)
  const times = new Float32Array(n)
  for (let j = 0; j < n; j++) {
    const idx = keys[j] % bits
    order[j] = idx
    times[j] = arr[idx]
  }
  return {
    arr,
    w,
    h,
    res: extent / w,
    extent,
    order,
    times,
    active: new Int32Array(n0),
    visit: new Int32Array(n0),
    queue: new Int32Array(n0),
    edges: new Int32Array(n0),
    ros: new Float32Array(n0),
    stamp: 0,
  }
}

function upperBound(a: Float32Array | Float64Array, x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Detections pre-sorted by time with typed columns (built once per detections file). */
export interface DetectionIndex {
  tMs: Float64Array
  x: Float32Array
  z: Float32Array
  frp: Float32Array
  inst: Uint8Array // 0 VIIRS, 1 MODIS, 2 GOES, 3 LANDSAT
  count: number
}

const INST_CODE: Record<string, number> = { VIIRS: 0, MODIS: 1, GOES: 2, LANDSAT: 3 }
export const INST_NAME = ['VIIRS', 'MODIS', 'GOES', 'LANDSAT']

export function buildDetectionIndex(dets: Detection[] | null | undefined): DetectionIndex {
  const list = (dets ?? []).filter((d) => Number.isFinite(d.t_ms) && Number.isFinite(d.x) && Number.isFinite(d.z))
  list.sort((a, b) => a.t_ms - b.t_ms)
  const n = list.length
  const out: DetectionIndex = {
    tMs: new Float64Array(n),
    x: new Float32Array(n),
    z: new Float32Array(n),
    frp: new Float32Array(n),
    inst: new Uint8Array(n),
    count: n,
  }
  list.forEach((d, i) => {
    out.tMs[i] = d.t_ms
    out.x[i] = d.x
    out.z[i] = d.z
    out.frp[i] = d.frp != null && Number.isFinite(d.frp) ? d.frp : 0
    out.inst[i] = INST_CODE[d.instrument] ?? 0
  })
  return out
}

function finite(a: number): boolean {
  return a < FINITE_MAX
}

/** Local ROS (m/h) at pixel idx from central differences of arrival; 0 when undefined. */
function rosAt(ix: ArrivalIndex, idx: number, r: number, c: number): number {
  const { arr, w, h, res } = ix
  const a0 = arr[idx]
  let gx = 0
  let gz = 0
  const aL = c > 0 ? arr[idx - 1] : Infinity
  const aR = c < w - 1 ? arr[idx + 1] : Infinity
  if (finite(aL) && finite(aR)) gx = (aR - aL) / (2 * res)
  else if (finite(aR)) gx = (aR - a0) / res
  else if (finite(aL)) gx = (a0 - aL) / res
  const aU = r > 0 ? arr[idx - w] : Infinity
  const aD = r < h - 1 ? arr[idx + w] : Infinity
  if (finite(aU) && finite(aD)) gz = (aD - aU) / (2 * res)
  else if (finite(aD)) gz = (aD - a0) / res
  else if (finite(aU)) gz = (a0 - aU) / res
  const g = Math.hypot(gx, gz)
  if (g < 1e-7) return 0
  return Math.min(20000, 1 / g)
}

/** FRP of the latest pass over a cluster: GOES within the last hour wins, else the latest polar-orbiter pass. */
function clusterFrp(det: DetectionIndex | null, tMs: number, cl: FrontCluster): void {
  cl.frpMw = null
  cl.frpInstrument = null
  cl.frpTMs = null
  if (!det || det.count === 0) return
  const hi = upperBound(det.tMs, tMs)
  const lo = upperBound(det.tMs, tMs - 12 * HOUR_MS)
  let bestGoes = -1
  let bestPolar = -1
  const near = (i: number, pad: number) =>
    det.x[i] >= cl.minX - pad && det.x[i] <= cl.maxX + pad && det.z[i] >= cl.minZ - pad && det.z[i] <= cl.maxZ + pad
  for (let i = hi - 1; i >= lo; i--) {
    const isGoes = det.inst[i] === 2
    if (isGoes) {
      if (bestGoes < 0 && det.tMs[i] >= tMs - HOUR_MS && near(i, 1500)) bestGoes = i
    } else if (bestPolar < 0 && near(i, 750)) bestPolar = i
    if (bestGoes >= 0 && bestPolar >= 0) break
  }
  const pick = bestGoes >= 0 ? bestGoes : bestPolar
  if (pick < 0) return
  const goes = pick === bestGoes
  const t0 = det.tMs[pick]
  const win = goes ? 10 * 60_000 : 45 * 60_000
  const pad = goes ? 1500 : 750
  let sum = 0
  for (let i = pick; i >= lo && det.tMs[i] >= t0 - win; i--) {
    if ((det.inst[i] === 2) === goes && near(i, pad)) sum += det.frp[i]
  }
  cl.frpMw = sum
  cl.frpInstrument = INST_NAME[det.inst[pick]]
  cl.frpTMs = t0
}

export interface FrontInputs {
  index: ArrivalIndex
  tH: number
  tMs: number
  key: string
  source: 'observed' | 'forecast'
  heightAt: (x: number, z: number) => number
  detections: DetectionIndex | null
  /** Reused output (its typed arrays are overwritten). */
  reuse?: ActiveFronts | null
}

/** Compute active fronts at time tH. */
export function computeFronts(inp: FrontInputs): ActiveFronts {
  const ix = inp.index
  const { arr, w, res, extent, order, times, active, visit, queue, edges, ros } = ix
  const half = extent / 2
  const tH = inp.tH
  const lo = upperBound(times, tH - 1)
  const hi = upperBound(times, tH)
  ix.stamp += 1
  const stamp = ix.stamp
  for (let j = lo; j < hi; j++) active[order[j]] = stamp

  const clusters: FrontCluster[] = []
  let edgeTotal = 0
  let rosTotal = 0
  const pixelArea = res * res
  for (let j = lo; j < hi; j++) {
    const seed = order[j]
    if (visit[seed] === stamp) continue
    visit[seed] = stamp
    let head = 0
    let tail = 0
    queue[tail++] = seed
    let sx = 0
    let sz = 0
    let count = 0
    let edgeCount = 0
    const rosStart = rosTotal
    let minC = w
    let maxC = -1
    let minR = ix.h
    let maxR = -1
    while (head < tail) {
      const idx = queue[head++]
      const r = (idx / w) | 0
      const c = idx - r * w
      count++
      sx += c
      sz += r
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      let edge = false
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr
        if (nr < 0 || nr >= ix.h) continue
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const nc = c + dc
          if (nc < 0 || nc >= w) continue
          const nidx = nr * w + nc
          if (active[nidx] === stamp) {
            if (visit[nidx] !== stamp) {
              visit[nidx] = stamp
              queue[tail++] = nidx
            }
          } else if ((dr === 0 || dc === 0) && arr[nidx] > tH) edge = true
        }
      }
      if (edge) {
        edges[edgeTotal++] = idx
        edgeCount++
        const v = rosAt(ix, idx, r, c)
        if (v > 0) ros[rosTotal++] = v
      }
    }
    let rosMed: number | null = null
    const nRos = rosTotal - rosStart
    if (nRos > 0) {
      const sl = ros.subarray(rosStart, rosTotal)
      sl.sort()
      rosMed = sl[nRos >> 1] / CHAIN_M
    }
    const cx = (sx / count + 0.5) * res - half
    const cz = (sz / count + 0.5) * res - half
    clusters.push({
      rank: 0,
      x: cx,
      z: cz,
      elev: inp.heightAt(cx, cz),
      pixels: count,
      edgePixels: edgeCount,
      lengthM: Math.max(edgeCount, Math.sqrt(count)) * res * 1.12,
      growthAcPerH: (count * pixelArea) / ACRE_M2,
      rosChPerH: rosMed,
      frpMw: null,
      frpInstrument: null,
      frpTMs: null,
      minX: minC * res - half,
      maxX: (maxC + 1) * res - half,
      minZ: minR * res - half,
      maxZ: (maxR + 1) * res - half,
    })
  }
  clusters.sort((a, b) => b.lengthM - a.lengthM)
  let totalLength = 0
  let totalFrp = 0
  clusters.forEach((cl, i) => {
    cl.rank = i
    totalLength += cl.lengthM
    if (i < 12) {
      clusterFrp(inp.detections, inp.tMs, cl)
      totalFrp += cl.frpMw ?? 0
    }
  })

  // Leading-edge samples (strided, deterministic) for embers / smoke.
  const out: ActiveFronts = inp.reuse ?? {
    key: '',
    tH: 0,
    tMs: 0,
    source: 'observed',
    clusters: [],
    samples: new Float32Array(MAX_FRONT_SAMPLES * 4),
    sampleCount: 0,
    totalLengthM: 0,
    totalPixels: 0,
    totalFrpMw: 0,
    detEmitters: new Float32Array(MAX_DET_EMITTERS * 4),
    detEmitterCount: 0,
    detEmitterWeight: 0,
  }
  const stride = Math.max(1, Math.ceil(edgeTotal / MAX_FRONT_SAMPLES))
  let ns = 0
  for (let k = 0; k < edgeTotal && ns < MAX_FRONT_SAMPLES; k += stride) {
    const idx = edges[k]
    const r = (idx / w) | 0
    const c = idx - r * w
    const x = (c + 0.5) * res - half
    const z = (r + 0.5) * res - half
    const o = ns * 4
    out.samples[o] = x
    out.samples[o + 1] = z
    out.samples[o + 2] = inp.heightAt(x, z)
    out.samples[o + 3] = Math.min(1, Math.max(0, 1 - (tH - arr[idx])))
    ns++
  }

  // Recent detections as additional smoke emitters (FRP x recency); GOES only while fresh.
  let nd = 0
  let wsum = 0
  const det = inp.detections
  if (det && det.count) {
    const dhi = upperBound(det.tMs, inp.tMs)
    const dlo = upperBound(det.tMs, inp.tMs - 6 * HOUR_MS)
    for (let i = dhi - 1; i >= dlo && nd < MAX_DET_EMITTERS; i--) {
      const ageH = (inp.tMs - det.tMs[i]) / HOUR_MS
      const goes = det.inst[i] === 2
      if (goes && ageH > 1) continue
      const frp = Math.max(det.frp[i], 1)
      const wgt = (goes ? 0.35 : 1) * Math.sqrt(frp) * Math.exp(-ageH / 2.5)
      if (wgt < 0.05) continue
      const o = nd * 4
      out.detEmitters[o] = det.x[i]
      out.detEmitters[o + 1] = det.z[i]
      out.detEmitters[o + 2] = inp.heightAt(det.x[i], det.z[i])
      out.detEmitters[o + 3] = wgt
      wsum += wgt
      nd++
    }
  }

  out.key = inp.key
  out.tH = tH
  out.tMs = inp.tMs
  out.source = inp.source
  out.clusters = clusters
  out.sampleCount = ns
  out.totalLengthM = totalLength
  out.totalPixels = hi - lo
  out.totalFrpMw = totalFrp
  out.detEmitterCount = nd
  out.detEmitterWeight = wsum
  return out
}

/** Blurred proximity to the active band (lattice "activity"): 0..255 on a (w/2)^2 grid, rows flipped to plane UV. */
export class FrontField {
  readonly size: number
  readonly texture: THREE.DataTexture
  private readonly a: Float32Array
  private readonly b: Float32Array
  private readonly bytes: Uint8Array
  private readonly down: number
  private readonly radius: number

  constructor(fireW: number, res: number) {
    this.down = fireW >= 256 ? 2 : 1
    this.size = Math.ceil(fireW / this.down)
    this.radius = Math.max(1, Math.round(320 / (res * this.down)))
    const n = this.size * this.size
    this.a = new Float32Array(n)
    this.b = new Float32Array(n)
    this.bytes = new Uint8Array(n)
    this.texture = new THREE.DataTexture(this.bytes, this.size, this.size, THREE.RedFormat, THREE.UnsignedByteType)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.unpackAlignment = 1
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.needsUpdate = true
  }

  /** Rasterise the active window [lo, hi) of the index (weighted by recency) and blur. */
  update(ix: ArrivalIndex, tH: number): void {
    const { a, b, size: F, down: D, radius: R } = this
    a.fill(0)
    const lo = upperBound(ix.times, tH - 1)
    const hi = upperBound(ix.times, tH)
    for (let j = lo; j < hi; j++) {
      const idx = ix.order[j]
      const r = (idx / ix.w) | 0
      const c = idx - r * ix.w
      const k = ((r / D) | 0) * F + ((c / D) | 0)
      const v = 0.55 + 0.45 * (1 - (tH - ix.times[j]))
      if (v > a[k]) a[k] = v
    }
    if (hi > lo) {
      for (let pass = 0; pass < 2; pass++) {
        boxBlur(a, b, F, R, true)
        boxBlur(b, a, F, R, false)
      }
    }
    const gain = (2 * R + 1) * 0.55
    const bytes = this.bytes
    for (let r = 0; r < F; r++) {
      const src = r * F
      const dst = (F - 1 - r) * F
      for (let c = 0; c < F; c++) {
        const v = a[src + c] * gain
        bytes[dst + c] = v >= 1 ? 255 : (v * 255) | 0
      }
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/** One box-blur pass (horizontal or vertical) with clamped edges; O(n) running sum. */
function boxBlur(src: Float32Array, dst: Float32Array, n: number, r: number, horizontal: boolean): void {
  const inv = 1 / (2 * r + 1)
  for (let line = 0; line < n; line++) {
    const base = horizontal ? line * n : line
    const step = horizontal ? 1 : n
    let acc = 0
    for (let k = -r; k <= r; k++) acc += src[base + Math.min(n - 1, Math.max(0, k)) * step]
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = acc * inv
      const addI = Math.min(n - 1, i + r + 1)
      const subI = Math.max(0, i - r)
      acc += src[base + addI * step] - src[base + subI * step]
    }
  }
}
