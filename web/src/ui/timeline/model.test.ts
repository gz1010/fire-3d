import { describe, expect, it } from 'vitest'
import type { ForecastManifest, ForecastSummary, IncidentManifest, Mode } from '../../api/types'
import { STALE_AFTER_MS, ZONE_MIN, activeStop, allocateFractions, buildCompactTimeline, clampToData, describeTime, labelsCoverPoints, spreadLabels, trackScale } from './model'

const H = 3_600_000
const T0 = Date.UTC(2026, 9, 16, 3) // record start

function manifest(mode: Mode, opts: { endH: number; forecasts?: Partial<ForecastSummary>[]; id?: string }): IncidentManifest {
  const end = T0 + opts.endH * H
  return {
    id: opts.id ?? 'fire-a',
    mode,
    status: 'ready',
    time_origin_ms: T0,
    time_range: { start_ms: T0, end_ms: end, now_ms: end },
    forecasts: (opts.forecasts ?? []).map((f, i) => ({ run_id: `run-${i}`, status: 'ready', issued_ms: end, start_ms: end, horizon_h: 72, ensemble: 'perturbed', members: 31, file: '', ...f })),
    built_ms: end + H,
  } as unknown as IncidentManifest
}

function forecast(startMs: number, horizonH = 72, incidentId = 'fire-a'): ForecastManifest {
  return { run_id: 'run-0', incident_id: incidentId, status: 'ready', issued_ms: startMs + 2 * H, start_ms: startMs, horizon_h: horizonH, time_origin_ms: T0 } as unknown as ForecastManifest
}

const stop = (m: ReturnType<typeof buildCompactTimeline>, id: string) => m.stops.find((s) => s.id === id)!

describe('compact timeline: live', () => {
  const m0 = manifest('live', { endH: 30, forecasts: [{}] })
  const latest = m0.time_range.now_ms
  const f = forecast(latest)

  it('lays out Past, NOW and +24/+48/+72 h with observations and forecast as separate segments', () => {
    const m = buildCompactTimeline(m0, f, latest, latest + H)
    expect(m.stops.map((s) => [s.id, s.label, s.available])).toEqual([
      ['past', 'Past', true],
      ['now', 'NOW', true],
      ['h24', '+24h', true],
      ['h48', '+48h', true],
      ['h72', '+72h', true],
    ])
    expect(stop(m, 'now').tMs).toBe(latest)
    expect(stop(m, 'h48').tMs).toBe(latest + 48 * H)
    expect(m.segments).toEqual([
      { kind: 'observed', startMs: T0, endMs: latest },
      { kind: 'forecast', startMs: latest, endMs: latest + 72 * H },
    ])
    expect(m.endMs).toBe(latest + 72 * H)
    expect(m.trackEndMs).toBe(m.endMs)
    expect(m.unavailable).toBeNull()
    expect(m.nowMarkerMs).toBe(latest)
    expect(m.wallClockMs).toBe(latest + H)
    expect(m.stale).toEqual({ isStale: false, ageMs: H, thresholdMs: STALE_AFTER_MS })
    expect(m.forecastStatus).toBe('ready')
  })

  it('tells observation and forecast valid times apart', () => {
    expect(buildCompactTimeline(m0, f, latest, latest).currentKind).toBe('observation')
    const fc = buildCompactTimeline(m0, f, latest + 5 * H, latest)
    expect(fc.currentKind).toBe('forecast')
    expect(fc.inForecastPeriod).toBe(true)
    expect(fc.leadH).toBe(5)
    expect(buildCompactTimeline(m0, f, latest + 73 * H, latest).currentKind).toBe('beyond')
    expect(buildCompactTimeline(m0, f, T0 - H, latest).currentKind).toBe('beyond')
    // describeTime gives the same answers from the time-independent model
    const base = buildCompactTimeline(m0, f, T0, latest)
    expect(describeTime(base, latest + 5 * H)).toEqual({ currentKind: 'forecast', inForecastPeriod: true, leadH: 5 })
    expect(describeTime(base, T0 + H)).toEqual({ currentKind: 'observation', inForecastPeriod: false, leadH: null })
  })

  it('flags stale data against the actual current time and stops calling it NOW', () => {
    const fresh = buildCompactTimeline(m0, f, latest, latest + STALE_AFTER_MS)
    expect(fresh.stale.isStale).toBe(false)
    const stale = buildCompactTimeline(m0, f, latest, latest + 9 * H)
    expect(stale.stale).toMatchObject({ isStale: true, ageMs: 9 * H })
    expect(stop(stale, 'now').label).toBe('Latest data')
    expect(stop(stale, 'now').description).toMatch(/9 h before the current time/)
    expect(stale.latestObservationMs).toBe(latest)
    expect(stale.wallClockMs).toBe(latest + 9 * H)
  })

  it('disables forecast hours without a forecast and draws them as an unavailable zone', () => {
    const none = manifest('live', { endH: 30 })
    const m = buildCompactTimeline(none, null, latest, latest + H)
    for (const id of ['h24', 'h48', 'h72']) {
      expect(stop(m, id)).toMatchObject({ available: false, tMs: null, reason: 'No forecast has been run for this fire yet' })
    }
    expect(stop(m, 'h24').posMs).toBe(latest + 24 * H)
    expect(m.unavailable).toEqual({ startMs: latest, endMs: latest + 72 * H, reason: 'No forecast has been run for this fire yet' })
    expect(m.endMs).toBe(latest)
    expect(m.trackEndMs).toBe(latest + 72 * H)
    expect(clampToData(m, latest + 10 * H)).toBe(latest)
    expect(m.forecastStatus).toBe('none')
    expect(m.segments).toHaveLength(1)
  })

  it('explains why a forecast is missing', () => {
    const ready = manifest('live', { endH: 30, forecasts: [{}] })
    expect(stop(buildCompactTimeline(ready, null, latest, latest, { forecastRunId: 'run-0' }), 'h24').reason).toBe('The forecast is still loading')
    expect(buildCompactTimeline(ready, null, latest, latest, { forecastRunId: null }).forecastStatus).toBe('unselected')
    const running = manifest('live', { endH: 30, forecasts: [{ status: 'running' }] })
    expect(stop(buildCompactTimeline(running, null, latest, latest), 'h72').reason).toBe('A forecast run is in progress')
    const failed = manifest('live', { endH: 30, forecasts: [{ status: 'error' }] })
    expect(buildCompactTimeline(failed, null, latest, latest).forecastStatus).toBe('failed')
  })

  it('handles a partial horizon: only the covered hours are available', () => {
    const m = buildCompactTimeline(m0, forecast(latest, 48), latest, latest)
    expect(stop(m, 'h24').available).toBe(true)
    expect(stop(m, 'h48').available).toBe(true)
    expect(stop(m, 'h72')).toMatchObject({ available: false, tMs: null, reason: 'This forecast covers 48 h', posMs: latest + 72 * H })
    expect(m.unavailable).toEqual({ startMs: latest + 48 * H, endMs: latest + 72 * H, reason: 'This forecast covers 48 h' })
    expect(m.endMs).toBe(latest + 48 * H)
  })

  it('ignores a forecast of another incident and notes an out-of-date forecast', () => {
    expect(buildCompactTimeline(m0, forecast(latest, 72, 'other'), latest, latest).forecast).toBeNull()
    const old = buildCompactTimeline(m0, forecast(latest - 6 * H), latest, latest + 80 * H)
    expect(old.forecastNotes).toEqual([
      'This forecast starts 6 h before the latest observation, so it does not include the newest data.',
      'This forecast period ended 14 h ago.',
    ])
  })

  it('finds the active stop near the timeline time', () => {
    const m = buildCompactTimeline(m0, f, latest + 10 * 60_000, latest)
    expect(activeStop(m, latest + 10 * 60_000)?.id).toBe('now')
    expect(activeStop(m, latest + 24 * H - 60_000)?.id).toBe('h24')
    expect(activeStop(m, latest + 5 * H)).toBeNull()
  })
})

describe('compact timeline: historical replay', () => {
  // Eaton-like: 66 h record, hindcast from +31 h for 72 h (runs 37 h past the record end)
  const m0 = manifest('historical', { endH: 66, forecasts: [{}] })
  const end = m0.time_range.end_ms
  const fcStart = T0 + 31 * H
  const f = forecast(fcStart)
  const years = Date.UTC(2027, 0, 1)

  it('uses the hindcast start instead of NOW and never flags staleness', () => {
    const m = buildCompactTimeline(m0, f, fcStart, years)
    expect(stop(m, 'now')).toMatchObject({ label: 'Forecast start', tMs: fcStart, available: true })
    expect(m.nowMarkerMs).toBe(fcStart)
    expect(m.stale.isStale).toBe(false)
    expect(m.stops.map((s) => s.available)).toEqual([true, true, true, true, true])
    expect(stop(m, 'h72').tMs).toBe(fcStart + 72 * H)
    expect(m.endMs).toBe(fcStart + 72 * H)
  })

  it('shows the forecast period while observations still exist, then forecast only', () => {
    const inRecord = buildCompactTimeline(m0, f, fcStart + 20 * H, years)
    expect(inRecord.currentKind).toBe('observation')
    expect(inRecord.inForecastPeriod).toBe(true)
    expect(inRecord.leadH).toBe(20)
    const after = buildCompactTimeline(m0, f, end + 2 * H, years)
    expect(after.currentKind).toBe('forecast')
    expect(buildCompactTimeline(m0, f, T0 + 5 * H, years).inForecastPeriod).toBe(false)
  })

  it('disables the forecast stops of a replay without a hindcast, without inventing positions', () => {
    const none = manifest('historical', { endH: 66 })
    const m = buildCompactTimeline(none, null, T0, years)
    expect(stop(m, 'now')).toMatchObject({ available: false, tMs: null, posMs: null, reason: 'No hindcast has been run for this replay' })
    for (const id of ['h24', 'h48', 'h72']) expect(stop(m, id)).toMatchObject({ available: false, posMs: null })
    expect(m.unavailable).toBeNull()
    expect(m.trackEndMs).toBe(end)
    expect(m.forecast).toBeNull()
  })
})

describe('track scale', () => {
  const live = manifest('live', { endH: 30, forecasts: [{}] })
  const latest = live.time_range.now_ms

  it('maps time to [0, 1] monotonically and back', () => {
    const m = buildCompactTimeline(live, forecast(latest), latest, latest)
    const s = trackScale(m)
    expect(s.toFrac(m.startMs)).toBe(0)
    expect(s.toFrac(m.trackEndMs)).toBe(1)
    let prev = -1
    for (let t = m.startMs; t <= m.trackEndMs; t += 3 * H) {
      const fr = s.toFrac(t)
      expect(fr).toBeGreaterThan(prev)
      expect(s.toTime(fr)).toBeCloseTo(t, -1)
      prev = fr
    }
    expect(s.toFrac(m.startMs - 10 * H)).toBe(0)
    expect(s.toFrac(m.trackEndMs + 10 * H)).toBe(1)
  })

  it('keeps the forecast readable after a long record and the record readable before a long forecast', () => {
    const long = manifest('live', { endH: 30 * 24, forecasts: [{}] })
    const s1 = trackScale(buildCompactTimeline(long, forecast(long.time_range.now_ms), 0, 0))
    const fz = s1.zones.find((z) => z.kind === 'forecast')!
    expect(fz.f1 - fz.f0).toBeCloseTo(ZONE_MIN.forecast, 6)
    const young = manifest('live', { endH: 3, forecasts: [{}] })
    const s2 = trackScale(buildCompactTimeline(young, forecast(young.time_range.now_ms), 0, 0))
    const pz = s2.zones.find((z) => z.kind === 'past')!
    expect(pz.f1 - pz.f0).toBeCloseTo(ZONE_MIN.past, 6)
  })

  it('adds a zone for record hours after the forecast and a single zone without one', () => {
    const longReplay = manifest('historical', { endH: 20 * 24, forecasts: [{}] })
    const m = buildCompactTimeline(longReplay, forecast(T0 + 24 * H), T0, 0)
    expect(trackScale(m).zones.map((z) => z.kind)).toEqual(['past', 'forecast', 'after'])
    const bare = buildCompactTimeline(manifest('historical', { endH: 66 }), null, T0, 0)
    expect(trackScale(bare).zones).toEqual([{ kind: 'past', startMs: T0, endMs: T0 + 66 * H, f0: 0, f1: 1 }])
  })

  it('spreads stop labels apart, in order and inside the track', () => {
    expect(spreadLabels([50, 150, 250], [40, 40, 40], 0, 300)).toEqual([50, 150, 250])
    const crowded = spreadLabels([100, 105, 110], [40, 40, 40], 0, 300)
    expect(crowded[1] - crowded[0]).toBeGreaterThanOrEqual(44)
    expect(crowded[2] - crowded[1]).toBeGreaterThanOrEqual(44)
    const edge = spreadLabels([0, 290, 300], [40, 40, 40], 0, 300)
    expect(edge[0]).toBe(20)
    expect(edge[2]).toBe(280)
    expect(edge[1]).toBe(236)
  })

  it('keeps full stop labels only while each still covers its point', () => {
    // Past | Forecast start | +24h | +48h | +72h on a 300 px track; label widths full ("Forecast start") / short ("Start")
    const full = [40, 104, 40, 40, 40]
    const short = [40, 46, 40, 40, 40]
    const roomy = [10, 95, 150, 220, 290]
    expect(labelsCoverPoints(roomy, spreadLabels(roomy, full, 0, 300, 3), full)).toBe(true)
    // +24h closer to the forecast start: the long label would push "+24h" off its tick -> short labels, which fit
    const tight = [10, 100, 150, 200, 290]
    const pushed = spreadLabels(tight, full, 0, 300, 3)
    expect(Math.round(pushed[2])).toBe(175)
    expect(labelsCoverPoints(tight, pushed, full)).toBe(false)
    const shortened = spreadLabels(tight, short, 0, 300, 3)
    expect(shortened.map(Math.round)).toEqual([20, 100, 150, 200, 280])
    expect(labelsCoverPoints(tight, shortened, short)).toBe(true)
  })

  it('allocates fractions proportionally above the minimums', () => {
    expect(allocateFractions([1, 1, 0], [0.2, 0.4, 0.1])).toEqual([0.5, 0.5, 0])
    const f = allocateFractions([100, 1, 0], [0.2, 0.4, 0.1])
    expect(f[1]).toBeCloseTo(0.4, 9)
    expect(f[0]).toBeCloseTo(0.6, 9)
    expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })
})
