// Derived framing data of an incident (cached per raster): the fire's bounding box and centroid (observed burned
// area, else the forecast's p90 reach, else the ignition), its active time span, and the line intervals used by
// the terrain overlays (contours by AOI extent, isochrone step by fire duration and zoom).
import type { IncidentAssets } from './assets'

export interface FireFrame {
  hasFire: boolean
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** Area-weighted centroid of the burned (or forecast) area, local m. */
  cx: number
  cz: number
  /** First / last finite arrival (hours since time_origin). */
  firstH: number
  lastH: number
}

const FINITE = 50000
const cache = new WeakMap<object, FireFrame>()

function scan(arr: ArrayLike<number>, w: number, h: number, extent: number, limit = FINITE): FireFrame | null {
  const res = extent / w
  const half = extent / 2
  let n = 0
  let sx = 0
  let sz = 0
  let minC = w
  let maxC = -1
  let minR = h
  let maxR = -1
  let first = Infinity
  let last = -Infinity
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const a = arr[r * w + c]
      if (!(a < limit)) continue
      n++
      sx += c
      sz += r
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      if (a < first) first = a
      if (a > last) last = a
    }
  }
  if (n === 0) return null
  return {
    hasFire: true,
    minX: minC * res - half,
    maxX: (maxC + 1) * res - half,
    minZ: minR * res - half,
    maxZ: (maxR + 1) * res - half,
    cx: (sx / n + 0.5) * res - half,
    cz: (sz / n + 0.5) * res - half,
    firstH: first,
    lastH: last,
  }
}

/** Fire frame of the current assets (observed arrival, then forecast p90, then ignition / AOI centre). */
export function fireFrame(assets: IncidentAssets): FireFrame {
  const key = (assets.arrays.observedArrival ?? assets.arrays.arrivalP90 ?? assets.manifest) as object
  const hit = cache.get(key)
  if (hit) return hit
  const { width: w, height: h } = assets.arrays.fireGrid
  const ext = assets.extent
  let f = assets.arrays.observedArrival ? scan(assets.arrays.observedArrival, w, h, ext) : null
  if (!f && assets.arrays.arrivalP90) f = scan(assets.arrays.arrivalP90, w, h, ext)
  if (!f) {
    const ig = assets.manifest.ignition
    const x = ig?.x ?? 0
    const z = ig?.z ?? 0
    const r = Math.max(1000, ext * 0.12)
    f = { hasFire: false, minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, cx: x, cz: z, firstH: 0, lastH: 0 }
  }
  cache.set(key, f)
  return f
}

/** Union of the observed fire box and the forecast's p90 reach (for framing a live incident with a forecast). */
export function fireFrameWithForecast(assets: IncidentAssets): FireFrame {
  const base = fireFrame(assets)
  const p90 = assets.arrays.arrivalP90
  if (!p90) return base
  const { width: w, height: h } = assets.arrays.fireGrid
  const key = p90 as object
  let fc = cache.get(key)
  if (!fc) {
    fc = scan(p90, w, h, assets.extent) ?? base
    cache.set(key, fc)
  }
  if (!fc.hasFire) return base
  return {
    ...base,
    minX: Math.min(base.minX, fc.minX),
    maxX: Math.max(base.maxX, fc.maxX),
    minZ: Math.min(base.minZ, fc.minZ),
    maxZ: Math.max(base.maxZ, fc.maxZ),
  }
}

/** Contour interval (m) by AOI extent (SPEC 9.3: 10 / 20 / 50 / 100 m). */
export function contourInterval(extent: number): number {
  if (extent <= 6000) return 10
  if (extent <= 14000) return 20
  if (extent <= 32000) return 50
  return 100
}

const ISO_STEPS = [1, 3, 6, 12]

/** Isochrone step (h): coarser for long fires and when zoomed out (SPEC 9.0: every 1, 3, 6 or 12 h). */
export function isochroneStep(durationH: number, cameraDistance: number, extent: number): number {
  let i = durationH > 96 ? 3 : durationH > 36 ? 2 : durationH > 10 ? 1 : 0
  const zoom = cameraDistance / Math.max(1, extent)
  if (zoom < 0.45) i--
  if (zoom < 0.18) i--
  return ISO_STEPS[Math.max(0, Math.min(3, i))]
}
