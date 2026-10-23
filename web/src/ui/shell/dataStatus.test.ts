import { describe, expect, it } from 'vitest'
import type { Detection, Perimeter } from '../../api/types'
import { timeFmt } from '../../lib/time'
import { buildDataStatus, fmtAge, fmtStatusTimeAt, freshnessLine, weatherSourceLabel, type DataStatusInput } from './dataStatus'
import { setCaliforniaCommandClock } from '../../extras/__fixtures__/clock.testutil'

setCaliforniaCommandClock()

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

describe('fmtStatusTimeAt', () => {
  it('adds the year only when it is not the current one', () => {
    const la = timeFmt('America/Los_Angeles', '24h') // tz-ok: a California fire's own zone
    expect(fmtStatusTimeAt(T0, T0 + 24 * H, la)).toBe('Jan 8, 04:00 PST')
    expect(fmtStatusTimeAt(T0, Date.UTC(2026, 9, 17, 20), la)).toBe('Jan 8, 2025 04:00 PST')
    const r = buildDataStatus(input('historical'), Date.UTC(2026, 9, 17, 20))
    expect(r.find((x) => x.key === 'bundle')?.value).toBe('Jan 8, 2025 06:00 PST')
  })
  it("fmtStatusTimeAt uses the given zone and clock (CONTRACT §14.9.6)", () => {
    expect(fmtStatusTimeAt(T0, T0 + 24 * H, timeFmt('America/Los_Angeles', '24h'))).toBe('Jan 8, 04:00 PST')
    expect(fmtStatusTimeAt(T0, Date.UTC(2026, 9, 17, 20), timeFmt('America/Los_Angeles', '12h'))).toBe('Jan 8, 2025 4:00 AM PST')
    expect(fmtStatusTimeAt(T0, T0 + H, timeFmt('America/New_York', '24h'))).toBe('Jan 8, 07:00 EST')
    expect(fmtStatusTimeAt(T0, T0 + H, timeFmt('America/Denver', '12h'))).toBe('Jan 8, 5:00 AM MST')
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

describe('official rows and freshness (brief 2, U-R9)', () => {
  it("adds Cal OES, NWS and CAL FIRE rows with the issuer's time and Fire-3d's check time", () => {
    const official = {
      evacuation: { state: 'listed' as const, checkedMs: T0 - 2 * 60_000, sourceUpdatedMs: T0 - 3 * H, zones: [{}, {}] },
      fireWeather: { state: 'none', checkedMs: T0 - 60_000, alerts: [] },
      calfire: { state: 'available', updatedMs: T0 - 5 * H, acres: 2450, percentContained: 65, isActive: true },
    }
    const r = byKey(buildDataStatus({ ...input('live'), official }, T0))
    expect(r.evacuation).toMatchObject({ tMs: T0 - 3 * H, age: 'checked 2 min ago' })
    expect(r.evacuation.value).toMatch(/^Cal OES /)
    expect(r.evacuation.detail).toBe('2 zones listed near this fire (local officials via Cal OES)')
    expect(r['fire-weather'].detail).toMatch(/not an all-clear/)
    expect(r.record).toMatchObject({ tMs: T0 - 5 * H, age: '5 h ago' })
    expect(r.record.detail).toBe('2,450 ac · 65% contained')
    const keys = buildDataStatus({ ...input('live'), official }, T0).map((x) => x.key)
    expect(keys.indexOf('record')).toBeLessThan(keys.indexOf('bundle'))
  })

  it("never reads silence as safety: past dates and outages say so", () => {
    const r = byKey(buildDataStatus({ ...input('historical'), official: { evacuation: { state: 'past-date' }, fireWeather: { state: 'unavailable' } } }, T0))
    expect(r.evacuation.detail).toBe('Official status is shown only for the current time')
    expect(r['fire-weather'].detail).toMatch(/did not answer/)
  })

  it("dates a past fire's CAL FIRE row with the year and calls it the record's last edit", () => {
    const edit = Date.UTC(2026, 7, 6, 17, 47) // the record was edited 19 months after the fire
    const now = Date.UTC(2026, 9, 18)
    const rows = buildDataStatus({ ...input('historical'), summary: { mode: 'historical', updated_ms: edit } }, now)
    const rec = rows.find((x) => x.key === 'record')
    expect(rec?.value).toBe('Aug 6, 2026 10:47 PDT')
    expect(rec?.detail).toMatch(/^Last edit of CAL FIRE’s record/)
    expect(rec?.age).toBeNull()
  })

  it('gives Public one line', () => {
    const rows = buildDataStatus(input('live'), T0 + 16 * H)
    expect(freshnessLine(rows, true, T0 + 16 * H, T0 + 16 * H - 120_000)).toEqual({ text: 'Sources checked 2 min ago · satellite data 16 h old', stale: true })
    expect(freshnessLine(rows, true, T0 + 16 * H, null).text).toBe('satellite data 16 h old')
    expect(freshnessLine(buildDataStatus(input('historical'), T0), false, T0, null).text).toBe('Archived replay to Jan 8, 2025')
    expect([fmtAge(30_000), fmtAge(40 * 60_000), fmtAge(50 * H)]).toEqual(['1 min', '40 min', '2 d'])
  })
})

describe('evacuation row outside California (brief 3)', () => {
  const oem = { id: 'or_oem_evacuations', aggregator: 'Oregon OEM', credit: 'Oregon Department of Emergency Management', url: 'https://www.arcgis.com/home/item.html?id=dd2bee51e3004dc4b1004df34fbd9e29', homeState: 'OR', answered: true, checkedMs: T0 - 60_000, updatedMs: T0 - 2 * H, reason: null }
  it('names Oregon OEM with its own time; a state without a feed says so', () => {
    const or = byKey(buildDataStatus({ ...input('live'), official: { evacuation: { state: 'none-listed', checkedMs: T0 - 60_000, sourceUpdatedMs: T0 - 2 * H, sources: [oem], checkedBy: 'Oregon OEM', zones: [] } } }, T0))
    expect(or.evacuation.value).toMatch(/^Oregon OEM /)
    expect(or.evacuation.tip).toMatch(/^Oregon OEM recalculates its statewide evacuation layer every 15 minutes/)
    const na = byKey(buildDataStatus({ ...input('live'), official: { evacuation: { state: 'not-available', reason: 'Not available in this state (Montana)', sources: [] } } }, T0))
    expect(na.evacuation).toMatchObject({ value: 'Not available in this state', detail: 'Not available in this state (Montana); follow local officials' })
    expect(JSON.stringify(na.evacuation)).not.toMatch(/Cal OES/)
  })
})

describe('fire-local times (brief 3, CONTRACT §14.9)', () => {
  it("a Montana fire's rows read Mountain time, never PDT; Public uses the 12-hour clock", () => {
    const den24 = timeFmt('America/Denver', '24h')
    const rows = buildDataStatus({ ...input('historical'), tf: den24 }, Date.UTC(2026, 9, 17, 20))
    const bundle = rows.find((x) => x.key === 'bundle')!
    expect(bundle.value).toBe('Jan 8, 2025 07:00 MST')
    expect(JSON.stringify(rows)).not.toMatch(/P[DS]T/)
    const den12 = byKey(buildDataStatus({ ...input('live'), tf: timeFmt('America/Denver', '12h') }, T0 + H))
    expect(den12.observations.value).toMatch(/ (AM|PM) MST$/)
    expect(freshnessLine(rows, false, Date.UTC(2026, 9, 17, 20), null, den24).text).toMatch(/^Archived replay to /)
  })
})
