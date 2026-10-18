import { describe, expect, it } from 'vitest'
import type { Detection, Perimeter } from '../../api/types'
import { buildDataStatus, fmtStatusTime, weatherSourceLabel, type DataStatusInput } from './dataStatus'

const H = 3_600_000
const T0 = Date.UTC(2025, 0, 8, 12, 0) // Jan 8 2025 04:00 PST

const perim = (t_ms: number, acres: number, source = 'NIFC WFIGS daily perimeters'): Perimeter => ({ t_ms, acres, source, rings: [] })
const det = (t_ms: number): Detection => ({ t_ms, lat: 34.2, lon: -118.1, x: 0, z: 0, frp: 12, satellite: 'N', instrument: 'VIIRS', confidence: 'h', daynight: 'N', footprint_m: 375 })

function input(mode: 'live' | 'historical', over: Partial<DataStatusInput> = {}): DataStatusInput {
  return {
    summary: { mode, updated_ms: null },
    manifest: { mode, time_range: { start_ms: T0 - 48 * H, end_ms: T0, now_ms: T0 }, built_ms: T0 + 2 * H },
    perimeters: { perimeters: [perim(T0 - 30 * H, 900), perim(T0 - 6 * H, 13680.8), perim(T0 - 20 * H, 4000)] },
    detections: { detections: [det(T0 - 3 * H), det(T0 - H), det(T0 - 9 * H)] },
    forecast: { run_id: 'fc-1', issued_ms: T0 - 2 * H, start_ms: T0 - 2 * H, horizon_h: 72, weather: { source: 'open-meteo', ensemble: 'gfs025', members: 31 } },
    weather: { source: 'open-meteo:historical-forecast:gfs_hrrr', t_ms: [T0 - 2 * H, T0 - H, T0], forecast_from_ms: null },
    ...over,
  }
}

const byKey = (rows: ReturnType<typeof buildDataStatus>) => Object.fromEntries(rows.map((r) => [r.key, r]))

describe('buildDataStatus', () => {
  it('reports the newest timestamp of each source with its details', () => {
    const r = byKey(buildDataStatus(input('historical'), T0 + 1000 * H))
    expect(r.perimeter.tMs).toBe(T0 - 6 * H)
    expect(r.perimeter.detail).toBe('NIFC WFIGS daily perimeters · 13,681 ac')
    expect(r.detection.tMs).toBe(T0 - H)
    expect(r.detection.detail).toMatch(/^VIIRS · /)
    expect(r.forecast.detail).toContain('72 h from')
    expect(r.forecast.detail).toContain('31 members · fc-1')
    expect(r.weather.tMs).toBe(T0)
    expect(r.weather.detail).toBe('Open-Meteo historical forecast (gfs_hrrr)')
    expect(r.bundle.tMs).toBe(T0 + 2 * H)
    expect(r.observations.value).toMatch(/^Jan 8, 04:00 PST$/)
  })
  it('never shows ages or stale flags in a replay', () => {
    const rows = buildDataStatus(input('historical'), T0 + 1000 * H)
    expect(rows.every((r) => r.age == null && !r.stale)).toBe(true)
    expect(byKey(rows).observations.label).toBe('Observations to')
  })
  it('adds ages for live incidents and flags stale observations', () => {
    const fresh = byKey(buildDataStatus(input('live'), T0 + 2 * H))
    expect(fresh.observations.label).toBe('Last observation')
    expect(fresh.observations.age).toBe('2 h ago')
    expect(fresh.observations.stale).toBe(false)
    const old = byKey(buildDataStatus(input('live'), T0 + 7 * H))
    expect(old.observations.stale).toBe(true)
    // only observations carry the stale threshold
    expect(old.detection.stale).toBe(false)
  })
  it('says plainly when a source is missing', () => {
    const r = byKey(buildDataStatus(input('historical', { perimeters: { perimeters: [] }, detections: null, forecast: null, weather: null }), T0))
    expect(r.perimeter).toMatchObject({ value: 'None in this bundle', tMs: null, detail: null })
    expect(r.detection.value).toBe('None in this bundle')
    expect(r.forecast.value).toBe('No forecast run')
    expect(r.weather.value).toBe('Not loaded')
    expect(buildDataStatus({ ...input('live'), manifest: null }, T0).find((x) => x.key === 'bundle')?.value).toBe('Not built')
  })
  it('includes the agency record time only when known', () => {
    expect(buildDataStatus(input('live'), T0).some((r) => r.key === 'record')).toBe(false)
    const rows = buildDataStatus({ ...input('live'), summary: { mode: 'live', updated_ms: T0 - H } }, T0)
    expect(rows.find((r) => r.key === 'record')).toMatchObject({ tMs: T0 - H, age: '1 h ago' })
  })
})

describe('fmtStatusTime', () => {
  it('adds the year only when it is not the current one', () => {
    expect(fmtStatusTime(T0, T0 + 24 * H)).toBe('Jan 8, 04:00 PST')
    expect(fmtStatusTime(T0, Date.UTC(2026, 9, 17, 20))).toBe('Jan 8, 2025 04:00 PST')
    const r = buildDataStatus(input('historical'), Date.UTC(2026, 9, 17, 20))
    expect(r.find((x) => x.key === 'bundle')?.value).toBe('Jan 8, 2025 06:00 PST')
  })
})

describe('buildDataStatus: quiet satellite passes (live)', () => {
  const CMR = { name: 'NASA CMR satellite passes', detail: 'latest observation: Aqua MODIS, Oct 17 15:50 PDT (day), 25 h after the last detection; 13 confirmed pass(es) since then saw no new fire', fetched_ms: T0 }
  const live = (now_ms: number, last_detection_ms: number | undefined, detections = true): DataStatusInput =>
    input('live', {
      manifest: { mode: 'live', time_range: { start_ms: T0 - 48 * H, end_ms: now_ms, now_ms, last_detection_ms, last_pass_ms: now_ms }, built_ms: now_ms, data_sources: [CMR] },
      detections: detections ? { detections: [det(T0 - 3 * H), det(T0 - 25 * H)] } : null,
    })
  it('says the latest observation is a pass that saw no new fire when the last detection is over an hour older', () => {
    const r = byKey(buildDataStatus(live(T0, T0 - 25 * H), T0 + H))
    expect(r.observations.label).toBe('Last observation')
    expect(r.observations.tMs).toBe(T0)
    expect(r.observations.detail).toBe('Latest satellite pass: no new fire seen')
    expect(r.observations.tip).toBe(CMR.detail)
    expect(r.observations.stale).toBe(false)
    // the detection row keeps the time the burned area is known up to
    expect(r.detection.label).toBe('Last detection')
    expect(r.detection.tMs).toBe(T0 - 3 * H)
  })
  it('falls back to time_range.last_detection_ms when the detections are not loaded', () => {
    const r = byKey(buildDataStatus(live(T0, T0 - 25 * H, false), T0 + H))
    expect(r.detection.tMs).toBe(T0 - 25 * H)
    expect(r.detection.detail).toBe('Newest detection or mapped perimeter')
  })
  it('keeps the plain row when the latest observation is the last detection (or within an hour of it)', () => {
    for (const last of [T0, T0 - 0.5 * H, undefined]) {
      const r = byKey(buildDataStatus(live(T0, last), T0 + H))
      expect(r.observations.detail).toBeNull()
      expect(r.observations.tip ?? null).toBeNull()
    }
  })
  it('never applies to replays', () => {
    const inp = input('historical', { manifest: { mode: 'historical', time_range: { start_ms: T0 - 48 * H, end_ms: T0, now_ms: T0, last_detection_ms: T0 - 25 * H }, built_ms: T0 } })
    expect(byKey(buildDataStatus(inp, T0 + 1000 * H)).observations.detail).toBeNull()
  })
})

describe('weatherSourceLabel', () => {
  it('names Open-Meteo sources and keeps others verbatim', () => {
    expect(weatherSourceLabel('open-meteo:gfs_hrrr')).toBe('Open-Meteo (gfs_hrrr)')
    expect(weatherSourceLabel('open-meteo:historical-forecast:gfs_hrrr')).toBe('Open-Meteo historical forecast (gfs_hrrr)')
    expect(weatherSourceLabel('open-meteo')).toBe('Open-Meteo')
    expect(weatherSourceLabel('synthetic')).toBe('synthetic')
  })
})
