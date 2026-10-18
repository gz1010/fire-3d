import { describe, expect, it } from 'vitest'
import { NEVER } from '../api/types'
import { geodesicInverse } from '../lib/geodesy'
import type { SelectedLocation } from '../state/workspace'
import {
  FAILED,
  HOUR,
  LOADING,
  ORIGIN,
  ZONE10,
  ZONE11,
  detection,
  input,
  localLatLon,
  makeForecast,
  makeLayer,
  makeManifest,
  makeRasters,
  makeWeather,
  perimeter,
  pixelLatLon,
  ready,
  square,
} from './fixtures.testutil'
import { checkLocation, gridWindAt, latestPerimeter, reachedShare, slopeAspect } from './locationCheck'
import type { ArrivalQuantile, LocationReport } from './types'

const click = (p: { lat: number; lon: number }): SelectedLocation => ({ ...p, source: 'click' })
type OkForecast = Extract<LocationReport['forecast'], { state: 'ok' }>
const okForecast = (r: LocationReport): OkForecast => {
  expect(r.forecast.state).toBe('ok')
  return r.forecast as OkForecast
}

describe('UTM grid sampling in both zones (original fire grid, row 0 = north)', () => {
  for (const spec of [ZONE11, ZONE10]) {
    it(`EPSG:326${spec.zone}: a marked pixel is found at its own WGS84 centre and not at its neighbours`, () => {
      const m = makeManifest(spec)
      const R = 37
      const C = spec.n - 41
      const arr = makeLayer('observed_arrival', spec.n, (r, c) => (r === R && c === C ? 5 : NEVER))
      const rasters = makeRasters({ observedArrival: ready(arr) })
      const at = (r: number, c: number) => checkLocation(input(m, click(pixelLatLon(m, r, c)), { rasters, timeMs: ORIGIN + 10 * HOUR }))
      const hit = at(R, C)
      expect(hit.modeledArea).toBe('inside')
      expect(hit.observedFire).toEqual({ state: 'burned', arrivalMs: ORIGIN + 5 * HOUR })
      // local coordinates of the pixel centre (x east, z south) within a millimetre
      const res = spec.extent / spec.n
      expect(hit.local!.x).toBeCloseTo(-spec.extent / 2 + (C + 0.5) * res, 3)
      expect(hit.local!.z).toBeCloseTo(-spec.extent / 2 + (R + 0.5) * res, 3)
      // the row above (north) and the column to the east are other pixels
      for (const [r, c] of [
        [R - 1, C],
        [R + 1, C],
        [R, C + 1],
        [R, C - 1],
      ])
        expect(at(r, c).observedFire.state).toBe('not_burned')
    })
  }

  it('is not fooled by the axis-aligned bbox: the AOI corners are inside, points just beyond them outside', () => {
    for (const spec of [ZONE11, ZONE10]) {
      const m = makeManifest(spec)
      const h = spec.extent / 2
      for (const [x, z] of [
        [-h + 1, -h + 1],
        [h - 1, -h + 1],
        [h - 1, h - 1],
        [-h + 1, h - 1],
      ])
        expect(checkLocation(input(m, click(localLatLon(m, x, z)))).modeledArea).toBe('inside')
      for (const [x, z] of [
        [-h - 20, 0],
        [h + 20, 0],
        [0, -h - 20],
        [0, h + 20],
      ])
        expect(checkLocation(input(m, click(localLatLon(m, x, z)))).modeledArea).toBe('outside')
    }
  })
})

describe('perimeter: latest mapped perimeter as of the timeline time', () => {
  const m = makeManifest(ZONE11)
  const p1 = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)], { acres: 988.4 })
  const p2 = perimeter(ORIGIN + 40 * HOUR, [square(0, 0, 2000)], { acres: 3953.7, source: 'NIFC WFIGS daily perimeters (final extent, mapped 2025-01-31)' })

  it('picks the newest perimeter at or before the time (any order)', () => {
    expect(latestPerimeter([p2, p1], ORIGIN + 30 * HOUR)).toBe(p1)
    expect(latestPerimeter([p2, p1], ORIGIN + 40 * HOUR)).toBe(p2)
    expect(latestPerimeter([p2, p1], ORIGIN + 10 * HOUR)).toBeNull()
  })

  it('reports inside with the distance to the edge, and the perimeter time, source, area and lag', () => {
    const r = checkLocation(input(m, click(localLatLon(m, 0, 500)), { perimeters: [p1, p2], timeMs: ORIGIN + 30 * HOUR }))
    expect(r.perimeter).toMatchObject({ state: 'ok', basis: 'mapped', inside: true, distanceM: 0, directionDeg: null, perimeterTimeMs: p1.t_ms, perimeterSource: p1.source, perimeterAcres: 988.4, lagMs: 10 * HOUR, ageMs: 380 * HOUR })
    if (r.perimeter.state !== 'ok') throw new Error()
    expect(r.perimeter.edgeDistanceM).toBeGreaterThan(499)
    expect(r.perimeter.edgeDistanceM).toBeLessThan(501)
  })

  it('measures geodesic distance and true-north direction from the nearest perimeter point (zone 11)', () => {
    // 1 km grid-east of the east edge: the nearest edge point is (1000, 0)
    const pt = localLatLon(m, 2000, 0)
    const r = checkLocation(input(m, click(pt), { perimeters: [p1], timeMs: ORIGIN + 30 * HOUR }))
    if (r.perimeter.state !== 'ok') throw new Error('expected a perimeter')
    const ref = geodesicInverse(localLatLon(m, 1000, 0), pt)
    expect(r.perimeter.inside).toBe(false)
    expect(r.perimeter.distanceM).toBeCloseTo(ref.distanceM, 6)
    expect(r.perimeter.directionDeg!).toBeCloseTo(ref.initialBearingDeg, 4) // two UTM implementations agree to < 1 mm
    // UTM scale (k ~ 0.9997 here) and convergence (grid north ~0.6° west of true north at -118.07) are corrected
    expect(r.perimeter.distanceM).toBeGreaterThan(1000)
    expect(r.perimeter.distanceM).toBeLessThan(1001)
    expect(r.perimeter.directionDeg!).toBeGreaterThan(89)
    expect(r.perimeter.directionDeg!).toBeLessThan(89.8)
    expect(r.perimeter.nearest.lat).toBeCloseTo(localLatLon(m, 1000, 0).lat, 7)
  })

  it('corrects the opposite convergence east of the zone 10 central meridian', () => {
    const m10 = makeManifest(ZONE10) // -121.5 is 1.5° east of the zone 10 central meridian (-123)
    const r = checkLocation(input(m10, click(localLatLon(m10, 2000, 0)), { perimeters: [p1], timeMs: ORIGIN + 30 * HOUR }))
    if (r.perimeter.state !== 'ok') throw new Error()
    expect(r.perimeter.directionDeg!).toBeGreaterThan(90.5)
    expect(r.perimeter.directionDeg!).toBeLessThan(91.2)
  })

  it('treats holes as outside', () => {
    const holey = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000), square(0, 0, 200)])
    const r = checkLocation(input(m, click(localLatLon(m, 0, 0)), { perimeters: [holey], timeMs: ORIGIN + 30 * HOUR }))
    expect(r.perimeter).toMatchObject({ state: 'ok', inside: false })
    if (r.perimeter.state !== 'ok') throw new Error()
    expect(r.perimeter.distanceM).toBeGreaterThan(199)
    expect(r.perimeter.distanceM).toBeLessThan(201)
  })

  it('falls back to the reconstructed burned area (an estimate) when no perimeter is mapped by then', () => {
    const n = ZONE11.n
    const arr = makeLayer('observed_arrival', n, (r, c) => (r >= 190 && r < 210 && c >= 190 && c < 210 ? 12 : NEVER))
    const dets = [detection(m, 0, 0, ORIGIN + 11 * HOUR), detection(m, 0, 0, ORIGIN + 13 * HOUR), detection(m, 0, 0, ORIGIN + 16 * HOUR)]
    const base = { perimeters: [p2], detections: dets, rasters: makeRasters({ observedArrival: ready(arr) }), timeMs: ORIGIN + 15 * HOUR }
    const inside = checkLocation(input(m, click(localLatLon(m, 0, 0)), base))
    expect(inside.perimeter).toMatchObject({ state: 'ok', basis: 'reconstructed', inside: true, distanceM: 0, perimeterTimeMs: ORIGIN + 15 * HOUR, latestDetectionMs: ORIGIN + 13 * HOUR })
    if (inside.perimeter.state !== 'ok') throw new Error()
    expect(inside.perimeter.perimeterSource).toMatch(/Estimated burned area, reconstructed from satellite fire detections/)
    // 20 x 20 cells of 30 m = 600 m square = 88.96 acres
    expect(inside.perimeter.perimeterAcres).toBeCloseTo((600 * 600) / 4046.8564224, 6)
    expect(inside.perimeter.edgeDistanceM).toBeGreaterThan(299)
    expect(inside.perimeter.edgeDistanceM).toBeLessThan(301)
    const outside = checkLocation(input(m, click(localLatLon(m, 0, -1300)), base)) // 1 km north of the burned square
    expect(outside.perimeter).toMatchObject({ state: 'ok', basis: 'reconstructed', inside: false })
    if (outside.perimeter.state !== 'ok') throw new Error()
    expect(outside.perimeter.distanceM).toBeGreaterThan(999)
    expect(outside.perimeter.distanceM).toBeLessThan(1001)
    expect(Math.abs(((outside.perimeter.directionDeg! + 180) % 360) - 180)).toBeLessThan(1.5) // the point lies north
    expect(outside.caveats.join(' ')).toMatch(/estimate reconstructed from satellite detections/)
  })

  it('has explicit states without a bundle, before any burned area and while rasters load', () => {
    expect(checkLocation(input(null, click({ lat: 34.2, lon: -118.1 }))).perimeter).toEqual({ state: 'none', reason: 'no_bundle' })
    const arr = makeLayer('observed_arrival', ZONE11.n, NEVER)
    const pt = click(localLatLon(m, 0, 0))
    expect(checkLocation(input(m, pt, { perimeters: [p2], rasters: makeRasters({ observedArrival: ready(arr) }), timeMs: ORIGIN + 10 * HOUR })).perimeter).toEqual({ state: 'none', reason: 'none_before_time' })
    expect(checkLocation(input(m, pt, { rasters: makeRasters({ observedArrival: LOADING }) })).perimeter).toEqual({ state: 'none', reason: 'loading' })
    expect(checkLocation(input(m, pt, { rasters: makeRasters({ observedArrival: FAILED }) })).perimeter).toEqual({ state: 'none', reason: 'error' })
    expect(checkLocation(input(m, pt)).perimeter).toEqual({ state: 'none', reason: 'no_perimeters' })
  })

  it('still measures the distance for points outside the modeled area', () => {
    const r = checkLocation(input(m, click(localLatLon(m, 9000, 0)), { perimeters: [p1], timeMs: ORIGIN + 30 * HOUR }))
    expect(r.modeledArea).toBe('outside')
    if (r.perimeter.state !== 'ok') throw new Error()
    expect(r.perimeter.distanceM).toBeGreaterThan(7990)
    expect(r.perimeter.distanceM).toBeLessThan(8010)
  })
})

describe('observed fire at the point (reconstructed arrival)', () => {
  const m = makeManifest(ZONE11)
  const pt = click(pixelLatLon(m, 200, 200))
  const withArrival = (v: number, extra = {}) => input(m, pt, { rasters: makeRasters({ observedArrival: ready(makeLayer('observed_arrival', ZONE11.n, v, extra)) }), timeMs: ORIGIN + 10 * HOUR })
  it('distinguishes burned by the time, burned later, never burned and nodata', () => {
    expect(checkLocation(withArrival(4)).observedFire).toEqual({ state: 'burned', arrivalMs: ORIGIN + 4 * HOUR })
    expect(checkLocation(withArrival(10)).observedFire).toEqual({ state: 'burned', arrivalMs: ORIGIN + 10 * HOUR })
    expect(checkLocation(withArrival(14)).observedFire).toEqual({ state: 'not_burned', asOfMs: ORIGIN + 10 * HOUR })
    expect(checkLocation(withArrival(NEVER)).observedFire).toEqual({ state: 'not_burned', asOfMs: ORIGIN + 10 * HOUR })
    expect(checkLocation(withArrival(Number.NaN)).observedFire).toEqual({ state: 'gap', gap: 'nodata' })
    expect(checkLocation(withArrival(-1, { nodata: -1 })).observedFire).toEqual({ state: 'gap', gap: 'nodata' })
  })
  it('is unknown outside the modeled area, without a bundle and while loading', () => {
    const arr = ready(makeLayer('observed_arrival', ZONE11.n, 4))
    expect(checkLocation(input(m, click(localLatLon(m, 7000, 0)), { rasters: makeRasters({ observedArrival: arr }) })).observedFire).toEqual({ state: 'gap', gap: 'outside_modeled_area' })
    expect(checkLocation(input(null, pt)).observedFire).toEqual({ state: 'gap', gap: 'no_bundle' })
    expect(checkLocation(input(m, pt, { rasters: makeRasters({ observedArrival: LOADING }) })).observedFire).toEqual({ state: 'gap', gap: 'loading' })
  })
})

describe('nearest satellite detection (context, not the fire front)', () => {
  const m = makeManifest(ZONE11)
  const pt = click(localLatLon(m, 0, 0))
  it('uses the 24 h before the timeline time and reports geodesic distance, direction and footprint', () => {
    const t = ORIGIN + 30 * HOUR
    const dets = [
      detection(m, 300, 0, t - 1 * HOUR, { instrument: 'GOES', satellite: 'G18', footprint_m: 2000 }),
      detection(m, 0, -500, t - 2 * HOUR),
      detection(m, 50, 0, t + HOUR), // after the time
      detection(m, 60, 0, t - 25 * HOUR), // before the window
    ]
    const r = checkLocation(input(m, pt, { detections: dets, timeMs: t }))
    expect(r.nearestDetection).toMatchObject({ state: 'ok', instrument: 'GOES', satellite: 'G18', footprintM: 2000, tMs: t - HOUR, windowH: 24, count: 2 })
    if (r.nearestDetection.state !== 'ok') throw new Error()
    expect(r.nearestDetection.distanceM).toBeGreaterThan(299)
    expect(r.nearestDetection.distanceM).toBeLessThan(301)
    expect(r.nearestDetection.directionDeg).toBeGreaterThan(89) // the detection lies (grid) east of the point
    expect(r.nearestDetection.directionDeg).toBeLessThan(90)
    expect(r.caveats.join(' ')).toMatch(/not the exact fire edge/)
  })
  it('says none when nothing was detected in the window', () => {
    expect(checkLocation(input(m, pt, { detections: [detection(m, 0, 0, ORIGIN)], timeMs: ORIGIN + 30 * HOUR })).nearestDetection).toEqual({ state: 'none', windowH: 24 })
  })
})

describe('forecast semantics', () => {
  const m = makeManifest(ZONE11)
  const f = makeForecast(m) // start ORIGIN + 24 h, 72 h horizon, 31 members
  const startH = 24
  const n = ZONE11.n
  const pt = click(pixelLatLon(m, 100, 300))
  const fc = (bp: number, p10: number, p50: number, p90: number) =>
    makeRasters({
      burnProbability: ready(makeLayer('burn_probability', n, bp)),
      arrivalP10: ready(makeLayer('arrival_p10', n, p10)),
      arrivalP50: ready(makeLayer('arrival_p50', n, p50)),
      arrivalP90: ready(makeLayer('arrival_p90', n, p90)),
    })
  const run = (rasters = fc(7 / 31, startH + 5, startH + 20, NEVER), timeMs = ORIGIN + 30 * HOUR) => checkLocation(input(m, pt, { forecast: f, rasters, timeMs }))

  it('reports the full-horizon burn probability with its period and member count', () => {
    const r = okForecast(run())
    expect(r).toMatchObject({ runId: 'fc-test-1', startMs: f.start_ms, endMs: f.start_ms + 72 * HOUR, horizonH: 72, members: 31, ensemble: 'perturbed', burnedMembers: 7, hindcast: true, burnedAtStart: false })
    expect(r.burnProbability.state).toBe('value')
    if (r.burnProbability.state === 'value') expect(r.burnProbability.fraction).toBeCloseTo(7 / 31, 6)
    expect(r.model).toMatchObject({ spotting: false, crown: true })
  })

  it('keeps arrival-time quantiles as times or "not reached" (NEVER), never as scenarios', () => {
    const r = okForecast(run())
    expect(r.arrival.p10).toEqual({ state: 'time', ms: ORIGIN + (startH + 5) * HOUR, atStart: false })
    expect(r.arrival.p50).toEqual({ state: 'time', ms: ORIGIN + (startH + 20) * HOUR, atStart: false })
    expect(r.arrival.p90).toEqual({ state: 'not_reached' })
  })

  it('states exactly which share of runs had reached the point at the timeline time', () => {
    const at = (h: number) => okForecast(run(undefined, ORIGIN + (startH + h) * HOUR)).reachedShareAtTime
    expect(at(0)).toBe(0) // forecast start: fewer than 10 %
    expect(at(4.9)).toBe(0)
    expect(at(5)).toBe(10) // arrival_p10 <= t  <=>  at least 10 %
    expect(at(19)).toBe(10)
    expect(at(20)).toBe(50)
    expect(at(72)).toBe(50) // p90 never reached within the horizon
    expect(at(-1)).toBeNull() // before the forecast period
    expect(at(73)).toBeNull() // after it
  })

  it('reachedShare needs every quantile', () => {
    const t = (ms: number): ArrivalQuantile => ({ state: 'time', ms, atStart: false })
    expect(reachedShare({ p10: t(10), p50: t(20), p90: t(30) }, 30, 0, 100)).toBe(90)
    expect(reachedShare({ p10: t(10), p50: { state: 'nodata' }, p90: t(30) }, 30, 0, 100)).toBeNull()
  })

  it('marks pixels already burned when the forecast started', () => {
    const r = okForecast(run(fc(1, startH, startH, startH)))
    expect(r.burnedAtStart).toBe(true)
    expect(r.arrival.p90).toEqual({ state: 'time', ms: f.start_ms, atStart: true })
    expect(r.reachedShareAtTime).toBe(90)
  })

  it('handles never-burn (0 of N runs) explicitly', () => {
    const r = okForecast(run(fc(0, NEVER, NEVER, NEVER)))
    expect(r.burnProbability).toEqual({ state: 'value', fraction: 0 })
    expect(r.burnedMembers).toBe(0)
    expect([r.arrival.p10.state, r.arrival.p50.state, r.arrival.p90.state]).toEqual(['not_reached', 'not_reached', 'not_reached'])
    expect(r.reachedShareAtTime).toBe(0)
  })

  it('has explicit unknown states: missing forecast, outside, no bundle, loading, error, nodata, switching', () => {
    expect(checkLocation(input(m, pt)).forecast).toEqual({ state: 'gap', gap: 'no_forecast' })
    expect(checkLocation(input(m, click(localLatLon(m, 0, 7000)), { forecast: f, rasters: fc(0.5, 30, 40, 50) })).forecast).toEqual({ state: 'gap', gap: 'outside_modeled_area' })
    expect(checkLocation(input(null, pt, { forecast: f })).forecast).toEqual({ state: 'gap', gap: 'no_bundle' })
    expect(checkLocation(input(m, pt, { forecast: f, rasters: makeRasters({ burnProbability: LOADING }) })).forecast).toEqual({ state: 'gap', gap: 'loading' })
    expect(checkLocation(input(m, pt, { forecast: f, rasters: { ...fc(0.5, 30, 40, 50), arrivalP90: LOADING } })).forecast).toEqual({ state: 'gap', gap: 'loading' })
    expect(checkLocation(input(m, pt, { forecast: f, rasters: makeRasters({ burnProbability: FAILED }) })).forecast).toEqual({ state: 'gap', gap: 'error' })
    expect(checkLocation(input(m, pt, { forecast: f, rasters: fc(Number.NaN, Number.NaN, Number.NaN, Number.NaN) })).forecast).toEqual({ state: 'gap', gap: 'nodata' })
    expect(checkLocation(input(m, pt, { forecast: { ...f, incident_id: 'other-fire' }, rasters: fc(0.5, 30, 40, 50) })).forecast).toEqual({ state: 'gap', gap: 'loading' })
    expect(checkLocation(input(m, pt, { forecast: { ...f, status: 'running' }, rasters: fc(0.5, 30, 40, 50) })).forecast).toEqual({ state: 'gap', gap: 'no_forecast' })
  })

  it('keeps a partly missing layer as nodata instead of guessing', () => {
    const r = okForecast(run({ ...fc(0.5, 30, 40, 50), arrivalP50: FAILED }))
    expect(r.arrival.p50).toEqual({ state: 'nodata' })
    expect(r.reachedShareAtTime).toBeNull()
  })

  it('adds ensemble, research-model and edge caveats', () => {
    const edge = makeForecast(m, { warnings: ['31/31 members reached the AOI boundary: spread beyond it is not simulated, so burn probability near the edge is underestimated', 'timing: 52 s'] })
    const nearEdge = click(localLatLon(m, ZONE11.extent / 2 - 500, 0))
    const r = checkLocation(input(m, nearEdge, { forecast: edge, rasters: fc(0.2, 30, 40, 50) }))
    expect(okForecast(r).warnings).toEqual([edge.warnings[0]])
    const text = r.caveats.join(' ')
    expect(text).toMatch(/describe 31 model runs \(an ensemble/)
    expect(text).toMatch(/not an official forecast or evacuation instruction/)
    expect(text).toMatch(/does not simulate ember spotting/)
    expect(text).toMatch(/near the edge of the modeled area/)
    expect(r.edgeDistanceM).toBeCloseTo(500, 3)
    // far from the edge the edge caveat is not shown
    expect(checkLocation(input(m, pt, { forecast: edge, rasters: fc(0.2, 30, 40, 50) })).caveats.join(' ')).not.toMatch(/near the edge/)
  })
})

describe('wind (meteorological FROM convention) and terrain', () => {
  const m = makeManifest(ZONE11)
  const pt = click(localLatLon(m, 0, 0))
  it('reads the at-fire hour nearest the timeline time and the grid cell at the point', () => {
    const w = makeWeather(m, { speedMs: 8, fromDeg: 45, gustMs: 14, u: 5, v: 0 })
    const r = checkLocation(input(m, pt, { weather: w, timeMs: ORIGIN + 30 * HOUR + 20 * 60_000 }))
    expect(r.wind).toMatchObject({ state: 'ok', tMs: ORIGIN + 30 * HOUR, speedMs: 8, gustMs: 14, fromDeg: 45, where: 'fire', isForecast: false })
    if (r.wind.state !== 'ok') throw new Error()
    // u = +5 m/s (air moving east) is a wind FROM the west
    expect(r.wind.atPoint).toMatchObject({ speedMs: 5, fromDeg: 270 })
    expect(r.wind.atPoint!.cellSizeM).toBeCloseTo(3000, 6)
  })
  it('converts grid u/v to FROM directions in all quadrants', () => {
    const w = makeWeather(m, { u: 0, v: -4 }) // air moving south = from the north
    expect(gridWindAt(w, 0, 0, 0)!.fromDeg).toBeCloseTo(0, 9)
    expect(gridWindAt(makeWeather(m, { u: -3, v: 0 }), 0, 0, 0)!.fromDeg).toBeCloseTo(90, 9)
    expect(gridWindAt(makeWeather(m, { u: 0, v: 3 }), 0, 0, 0)!.fromDeg).toBeCloseTo(180, 9)
    expect(gridWindAt(makeWeather(m, { u: 2, v: 2 }), 0, 0, 0)!.fromDeg).toBeCloseTo(225, 9)
  })
  it('has no wind outside the weather series, flags forecast hours, and skips the grid outside the AOI', () => {
    const w = makeWeather(m, { hours: 10, forecastFromMs: ORIGIN + 5 * HOUR })
    expect(checkLocation(input(m, pt, { weather: w, timeMs: ORIGIN + 30 * HOUR })).wind).toEqual({ state: 'none' })
    expect(checkLocation(input(m, pt, { weather: w, timeMs: ORIGIN + 6 * HOUR })).wind).toMatchObject({ state: 'ok', isForecast: true })
    const out = checkLocation(input(m, click(localLatLon(m, 9000, 0)), { weather: w, timeMs: ORIGIN + 6 * HOUR })).wind
    expect(out).toMatchObject({ state: 'ok', where: 'fire', atPoint: null })
    expect(checkLocation(input(m, pt)).wind).toEqual({ state: 'none' })
  })
  it('samples elevation, slope, downslope aspect (true north) and the fuel model from the original grids', () => {
    const rn = ZONE11.n * 2
    const res = ZONE11.extent / rn
    // elevation rising 10 m per 100 m to the east: slope 10 %, the ground faces (downslope) west
    const elev = makeLayer('elevation', rn, (_r, c) => 500 + 0.1 * (c + 0.5) * res, { grid: 'render' })
    const fuel = makeLayer('fuel', ZONE11.n, 145, { dtype: 'uint8', nodata: 0 })
    const r = checkLocation(input(m, pt, { rasters: makeRasters({ elevation: ready(elev), fuel: ready(fuel) }) }))
    expect(r.terrain).toMatchObject({ state: 'ok', fuelCode: 145, fuelLabel: 'SH5', fuelName: 'High load, dry climate shrub', burnable: true })
    if (r.terrain.state !== 'ok') throw new Error()
    expect(r.terrain.elevationM).toBeCloseTo(500 + 0.1 * (ZONE11.extent / 2 + res / 2), 2)
    expect(r.terrain.slopePct!).toBeCloseTo(10, 6)
    expect(r.terrain.aspectDeg!).toBeGreaterThan(269) // grid west, ~0.6° counter-clockwise of true west here
    expect(r.terrain.aspectDeg!).toBeLessThan(270)
    const sa = slopeAspect(elev, 0, 0, m.grid)!
    expect(sa.slopePct).toBeCloseTo(10, 6)
  })
  it('reports flat ground without an aspect, nodata fuel, and unknown terrain outside the area', () => {
    const rn = ZONE11.n * 2
    const flat = makeLayer('elevation', rn, 300, { grid: 'render' })
    const fuel0 = makeLayer('fuel', ZONE11.n, 0, { dtype: 'uint8', nodata: 0 })
    const r = checkLocation(input(m, pt, { rasters: makeRasters({ elevation: ready(flat), fuel: ready(fuel0) }) }))
    expect(r.terrain).toMatchObject({ state: 'ok', elevationM: 300, slopePct: 0, aspectDeg: null, fuelCode: null, burnable: null })
    expect(checkLocation(input(m, click(localLatLon(m, 9000, 0)), { rasters: makeRasters({ elevation: ready(flat) }) })).terrain).toEqual({ state: 'gap', gap: 'outside_modeled_area' })
    expect(checkLocation(input(m, pt, { rasters: makeRasters({ elevation: LOADING }) })).terrain).toEqual({ state: 'gap', gap: 'loading' })
  })
})

describe('point, sources and caveats', () => {
  const m = makeManifest(ZONE11)
  it('labels addresses as interpolated and approximate, and adjusted pins as moved', () => {
    const p = { ...localLatLon(m, 0, 0), source: 'address' as const, label: '600 E MARIPOSA ST, ALTADENA, CA, 91001', matchedAddress: '600 E MARIPOSA ST, ALTADENA, CA, 91001', approximate: true, adjustable: true }
    const address = { query: '600 E Mariposa St', matchedAddress: p.label, lat: p.lat, lon: p.lon, fromAddress: '600', toAddress: '628', side: 'R' as const, tigerLineId: '142735412', benchmark: 'Public_AR_Current', source: 'U.S. Census Bureau Geocoder', fetchedMs: ORIGIN }
    const r = checkLocation(input(m, p, { address }))
    expect(r.point).toMatchObject({ label: p.label, source: 'address', approximate: true, adjusted: false, address })
    expect(r.point.locationType).toBe('Street address, interpolated (not a rooftop)')
    expect(r.caveats.join(' ')).toMatch(/interpolated along house numbers 600–628 of the street/)
    expect(r.caveats.join(' ')).toMatch(/approximate, not a rooftop location/)
    expect(r.sources.find((s) => s.name.includes('Census'))).toMatchObject({ name: 'U.S. Census Bureau Geocoder (Public_AR_Current)', kind: 'reference' })
    const moved = checkLocation(input(m, { ...p, adjusted: true, approximate: false }, { address }))
    expect(moved.point.locationType).toMatch(/pin moved by you/)
    expect(moved.caveats.join(' ')).not.toMatch(/rooftop/)
  })
  it('never calls the reported location the ignition point, and labels coordinates when there is no label', () => {
    const r = checkLocation(input(m, { lat: 34.2, lon: -118.07, source: 'incident' }))
    expect(r.point.locationType).toMatch(/where the incident was reported, not necessarily where it started/)
    expect(r.point.locationType).not.toMatch(/ignition/i)
    expect(checkLocation(input(m, { lat: 34.2, lon: -118.07, source: 'coords' })).point.label).toBe('34.20000° N, 118.07000° W')
  })
  it('says outside means unknown, not low', () => {
    const r = checkLocation(input(m, click(localLatLon(m, 9000, 0))))
    expect(r.modeledArea).toBe('outside')
    expect(r.caveats[0]).toMatch(/Outside the modeled area/)
    expect(r.caveats[0]).toMatch(/unknown, not low/)
    expect(r.edgeDistanceM).toBeNull()
  })
  it('flags demo bundles and lists the sources it used', () => {
    const demo = makeManifest({ ...ZONE11, id: 'fixture-demo' })
    const f = makeForecast(demo)
    const r = checkLocation(input(demo, click(localLatLon(demo, 0, 0)), { forecast: f, rasters: makeRasters({ burnProbability: ready(makeLayer('burn_probability', ZONE11.n, 0.5)) }) }))
    expect(r.caveats[0]).toMatch(/Demo bundle with simulated data/)
    expect(r.sources.map((s) => s.kind)).toContain('model')
    expect(r.sources.find((s) => s.kind === 'model')!.detail).toMatch(/31 runs/)
  })
  it('works without any bundle (coordinates only)', () => {
    const r = checkLocation(input(null, { lat: 36.6, lon: -121.9, source: 'coords' }))
    expect(r).toMatchObject({ modeledArea: 'no_bundle', local: null, edgeDistanceM: null, forecast: { state: 'gap', gap: 'no_bundle' }, terrain: { state: 'gap', gap: 'no_bundle' } })
    expect(r.caveats).toEqual([])
  })
})

describe('brief 2 facts for the main reasons: dryness, ground versus the fire edge, latest observation', () => {
  const m = makeManifest(ZONE11)
  const rn = m.grid.render.width
  const res = m.grid.extent_m / rn
  const elev = makeLayer('elevation', rn, (_r, c) => 500 + 0.3 * (c + 0.5) * res, { grid: 'render' }) // rises eastward
  const p = perimeter(ORIGIN + 20 * HOUR, [square(0, 0, 1000)])
  const at = (x: number, z: number, over = {}) => checkLocation(input(m, click(localLatLon(m, x, z)), { perimeters: [p], timeMs: ORIGIN + 30 * HOUR, rasters: makeRasters({ elevation: ready(elev) }), ...over }))
  it('dryness: humidity and 1-h fuel moisture at the wind hour (model weather), none without a reading', () => {
    const r = at(3000, 0, { weather: makeWeather(m, { forecastFromMs: ORIGIN + 29 * HOUR }) })
    expect(r.dryness).toEqual({ state: 'ok', tMs: ORIGIN + 30 * HOUR, rhPct: 15, fm1Pct: 4, isForecast: true, source: 'open-meteo:historical-forecast:gfs_hrrr' })
    expect(at(3000, 0).dryness).toEqual({ state: 'none' })
    expect(at(3000, 0, { weather: makeWeather(m, { hours: 10 }) }).dryness).toEqual({ state: 'none' }) // more than 90 min away
  })
  it('edge rise: elevation here versus at the nearest edge point, only outside the fire and inside the modeled area', () => {
    const up = at(3000, 0).edgeRise
    expect(up.state).toBe('ok')
    if (up.state === 'ok') {
      expect(up.riseM).toBeCloseTo(0.3 * 2000, -1) // 2 km east of the edge on a 30 % slope
      expect(up.distanceM).toBeCloseTo(2000, -1)
    }
    const down = at(-3000, 0).edgeRise
    expect(down.state === 'ok' && down.riseM < -500).toBe(true)
    expect(at(0, 0).edgeRise).toEqual({ state: 'none', reason: 'inside' })
    expect(at(9000, 0).edgeRise).toEqual({ state: 'none', reason: 'outside_modeled_area' })
    expect(at(3000, 0, { rasters: makeRasters() }).edgeRise).toEqual({ state: 'none', reason: 'no_elevation' })
    expect(at(3000, 0, { perimeters: [] }).edgeRise).toEqual({ state: 'none', reason: 'no_edge' })
  })
  it('latest observation from the manifest (the timeline freshness rule), null without a bundle', () => {
    expect(at(3000, 0).latestObservationMs).toBe(m.time_range.now_ms)
    expect(checkLocation(input(null, click({ lat: 34.2, lon: -118.1 }))).latestObservationMs).toBeNull()
  })
})
