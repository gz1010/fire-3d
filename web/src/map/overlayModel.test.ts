import { timeFmt } from '../lib/time'
import { describe, expect, it } from 'vitest'
import type { Detection, Perimeter } from '../api/types'
import { HOUR_MS } from '../data/rasters'
import { lonLatToLocal } from '../lib/reproject'
import {
  aoiFeatures,
  burnedByMask,
  classMask,
  detectionFeatures,
  eventFeatures,
  FORECAST_RGBA,
  forecastClasses,
  forecastFrame,
  forecastPixels,
  OBSERVED_RGBA,
  observedPixels,
  perimeterFeatures,
  rgba,
} from './overlayModel'

/** Node's fs without @types/node (tests run in Node; the app never imports this). */
interface FsLike {
  existsSync(p: string): boolean
  readdirSync(p: string): string[]
  readFileSync(p: string, enc?: string): string | Uint8Array
}
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as FsLike

const NEVER = 1e6
const GRID = { utm_zone: 11, center_e: 401418.0, center_n: 3784849.0, extent_m: 12000 }

describe('observed fire', () => {
  it('burned = arrival <= t; NEVER and nodata never burn; the last 6 h are brighter', () => {
    const arr = new Float32Array([1, 3.5, 9.5, 10, 10.01, NEVER, -9999, Number.NaN])
    const colors = new Uint32Array(arr.length)
    const mask = new Uint8Array(arr.length)
    const n = observedPixels(arr, -9999, 10, colors, mask)
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 0, 0, 0, 0])
    expect(n).toEqual({ burned: 4, recent: 2 })
    expect(colors[0]).toBe(OBSERVED_RGBA.burned)
    expect(colors[2]).toBe(OBSERVED_RGBA.recent)
    expect(colors[3]).toBe(OBSERVED_RGBA.recent)
    expect(colors[4]).toBe(0)
    expect(colors[1]).toBe(OBSERVED_RGBA.burned) // 6.5 h before t
    expect(burnedByMask(arr, -9999, 5, mask)).toBe(2)
  })

  it('packs RGBA for ImageData', () => {
    const px = new Uint8ClampedArray(new Uint32Array([rgba(1, 2, 3, 1)]).buffer)
    expect(Array.from(px)).toEqual([1, 2, 3, 255])
  })
})

describe('forecast frame', () => {
  const f = { start_ms: 1_000 * HOUR_MS, horizon_h: 72 }
  const end = f.start_ms + 72 * HOUR_MS
  it('auto: full-horizon chance before the start, spread by the timeline time inside, clamped after the end', () => {
    expect(forecastFrame(f, f.start_ms - HOUR_MS, 'auto')).toMatchObject({ kind: 'horizon', byMs: end })
    expect(forecastFrame(f, f.start_ms + 24 * HOUR_MS, 'auto')).toMatchObject({ kind: 'time', byMs: f.start_ms + 24 * HOUR_MS, clamped: false })
    expect(forecastFrame(f, end + HOUR_MS, 'auto')).toMatchObject({ kind: 'time', byMs: end, clamped: true })
  })
  it('explicit views', () => {
    expect(forecastFrame(f, f.start_ms - HOUR_MS, 'time').kind).toBe('before-start')
    expect(forecastFrame(f, f.start_ms + HOUR_MS, 'horizon')).toMatchObject({ kind: 'horizon', byMs: end })
  })
})

describe('forecast classes', () => {
  const frameAt = (h: number) => ({ kind: 'time' as const, byMs: h * HOUR_MS, startMs: 0, endMs: 72 * HOUR_MS, clamped: false })
  it('time: arrival_pK <= t gives nested ">= K % of runs" classes; NEVER never counts', () => {
    const p10 = { data: new Float32Array([1, 1, 1, 30, NEVER]) }
    const p50 = { data: new Float32Array([2, 2, 40, 50, NEVER]) }
    const p90 = { data: new Float32Array([3, 50, 60, NEVER, NEVER]) }
    const out = new Uint8Array(5)
    const counts = forecastClasses(frameAt(10), { p10, p50, p90, prob: null }, 0, out)
    expect(Array.from(out)).toEqual([3, 2, 1, 0, 0])
    expect(counts).toEqual([2, 1, 1, 1])
  })
  it('horizon: burn_probability thresholds tolerate float32 storage of k/n', () => {
    const prob = { data: new Float32Array([0.9, 0.5, 0.1, 0.0999, 1, 0]) } // 0.9 is 0.89999998 in float32
    const out = new Uint8Array(6)
    forecastClasses({ kind: 'horizon', byMs: 0, startMs: 0, endMs: 0, clamped: false }, { p10: null, p50: null, p90: null, prob }, 0, out)
    expect(Array.from(out)).toEqual([3, 2, 1, 0, 3, 0])
  })
  it('missing rasters give null, before-start gives nothing', () => {
    const out = new Uint8Array(2)
    expect(forecastClasses(frameAt(1), { p10: null, p50: null, p90: null, prob: null }, 0, out)).toBeNull()
    expect(forecastClasses({ kind: 'before-start', byMs: 0, startMs: 0, endMs: 0, clamped: false }, { p10: null, p50: null, p90: null, prob: null }, 0, out)).toEqual([2, 0, 0, 0])
  })
  it('tints leave the area burned at the forecast start clear; masks by class', () => {
    const classes = new Uint8Array([3, 2, 1, 0])
    const colors = new Uint32Array(4)
    forecastPixels(classes, new Uint8Array([1, 0, 0, 0]), colors)
    expect(Array.from(colors)).toEqual([0, FORECAST_RGBA[2], FORECAST_RGBA[1], 0])
    const m = new Uint8Array(4)
    expect(classMask(classes, 2, null, m)).toBe(2)
    expect(classMask(classes, 1, new Uint8Array([1, 0, 0, 0]), m)).toBe(2)
  })

  // The two readings of the real Eaton forecast agree at the end of the horizon:
  // arrival_pK <= end  <=>  burn_probability >= K %, for every pixel (CONTRACT §5.2 semantics).
  const fcDir = new URL('../../../data/incidents/2025-eaton-fire-dbfa57/forecasts/', import.meta.url)
  const path = (u: URL) => decodeURIComponent(u.pathname)
  const runDir = fs.existsSync(path(fcDir)) ? fs.readdirSync(path(fcDir)).find((d) => fs.existsSync(path(new URL(`${d}/forecast.json`, fcDir)))) : undefined
  it.skipIf(!runDir)('real Eaton forecast: quantile and probability classes agree at the horizon end', () => {
    const base = new URL(`${runDir}/`, fcDir)
    const fc = JSON.parse(String(fs.readFileSync(path(new URL('forecast.json', base)), 'utf8'))) as { start_ms: number; horizon_h: number; time_origin_ms: number; status: string }
    if (fc.status !== 'ready') return
    const read = (n: string) => ({ data: new Float32Array(new Uint8Array(fs.readFileSync(path(new URL(`${n}.bin`, base))) as Uint8Array).buffer) })
    const a = { p10: read('arrival_p10'), p50: read('arrival_p50'), p90: read('arrival_p90'), prob: read('burn_probability') }
    const n = a.prob.data.length
    const byQ = new Uint8Array(n)
    const byP = new Uint8Array(n)
    const end = fc.start_ms + fc.horizon_h * HOUR_MS
    forecastClasses({ kind: 'time', byMs: end, startMs: fc.start_ms, endMs: end, clamped: false }, a, fc.time_origin_ms, byQ)
    const counts = forecastClasses({ kind: 'horizon', byMs: end, startMs: fc.start_ms, endMs: end, clamped: false }, a, fc.time_origin_ms, byP)!
    let diff = 0
    for (let i = 0; i < n; i++) if (byQ[i] !== byP[i]) diff++
    expect(diff).toBe(0)
    expect(counts[3]).toBeGreaterThan(0)
  })
})

describe('vector features', () => {
  it('perimeters up to t, latest flagged and labelled with its time', () => {
    const p = (t: number): Perimeter => ({ t_ms: t, acres: 1234.4, source: 'NIFC', rings: [[[0, 0], [100, 0], [100, 100]]] })
    const { fc, latest } = perimeterFeatures([p(3e12), p(1e12), p(2e12)], GRID, 2.5e12, timeFmt('America/Denver', '24h'))
    expect(fc.features).toHaveLength(2)
    expect(latest?.t_ms).toBe(2e12)
    expect(fc.features.map((f) => f.properties.latest)).toEqual([false, true])
    expect(String(fc.features[1].properties.label)).toMatch(/^Perimeter .* · 1,234 ac$/)
    // the fire's zone and the preset's clock (2e12 ms = May 18, 2033 03:33 UTC = May 17, 21:33 MDT)
    expect(String(fc.features[1].properties.label)).toBe('Perimeter May 17, 21:33 MDT · 1,234 ac')
    const p12 = perimeterFeatures([p(2e12)], GRID, 2.5e12, timeFmt('America/New_York', '12h')).fc.features[0].properties.label
    expect(p12).toBe('Perimeter May 17, 11:33 PM EDT · 1,234 ac')
    const ring = (fc.features[0].geometry as { coordinates: [number, number][][] }).coordinates[0]
    expect(ring[0]).toEqual(ring[ring.length - 1]) // closed
  })

  it('detections: footprints of the sensor pixel size, 24 h window, recent / older classes, GOES only 90 min', () => {
    const d = (h: number, inst: Detection['instrument'] = 'VIIRS'): Detection => ({
      t_ms: h * HOUR_MS, lat: 0, lon: 0, x: 0, z: 0, frp: 5, satellite: 'N20', instrument: inst, confidence: 'n', daynight: 'D', footprint_m: inst === 'GOES' ? 2000 : 375,
    })
    const { fc, counts } = detectionFeatures([d(100), d(95), d(80), d(70), d(101), d(99, 'GOES'), d(97, 'GOES')], GRID, 100 * HOUR_MS)
    // 100 (0 h), 95 (5 h) recent; 80 (20 h) older; 70 (30 h) hidden; 101 future; GOES 1 h shown, 3 h hidden
    expect(counts).toEqual([2, 1, 1])
    expect(fc.features.map((f) => f.properties.age)).toEqual([1, 0, 2, 0])
    const sq = (fc.features[0].geometry as { coordinates: [number, number][][] }).coordinates[0].map(([lon, lat]) => lonLatToLocal(lon, lat, GRID))
    const xs = sq.map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(375, 3)
  })

  it('AOI outline is closed and has label anchors on all four sides', () => {
    const { outline, labels } = aoiFeatures({ grid: { ...GRID, crs: 'EPSG:32611', bbox_lonlat: [0, 0, 0, 0], render: { width: 1, height: 1, res_m: 1 }, fire: { width: 1, height: 1, res_m: 1 }, elev_min_m: 0, elev_max_m: 1 } })
    const ring = (outline.features[0].geometry as { coordinates: [number, number][] }).coordinates
    expect(ring[0]).toEqual(ring[ring.length - 1])
    expect(new Set(labels.features.map((f) => f.properties.side))).toEqual(new Set(['n', 's', 'w', 'e']))
  })

  it('events appear once the timeline reaches them; the selected one is flagged', () => {
    const ev = [
      { id: 'a', title: 'A', tMs: 10, lon: -118, lat: 34, kind: 'ignition', confidence: 'observed' },
      { id: 'b', title: 'B', tMs: 20, lon: -118, lat: 34, kind: 'spot_fire', confidence: 'estimated' },
    ]
    const fc = eventFeatures(ev, 15, 'a')
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties).toMatchObject({ eid: 'a', selected: true })
  })
})
