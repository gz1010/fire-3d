import { beforeEach, describe, expect, it } from 'vitest'
import type { Detection, FireEvent, ForecastManifest, IncidentManifest, Perimeter, TimeseriesFile, WeatherFile } from '../../api/types'
import { localToLonLat } from '../../lib/reproject'
import type { Annotation } from '../../state/annotations'
import { useStore } from '../../state/store'
import {
  buildFeedItems,
  extendFeedBaseline,
  feedBaseline,
  feedView,
  filterFeed,
  isLaterItem,
  isNewFeedItem,
  ringCentroid,
  rovingIndex,
  rovingTabStop,
  satellitePasses,
  selectFeedItem,
  selectionId,
} from './feedModel'
import type { FeedItem } from './types'

const H = 3_600_000
const T0 = 1736298000000 // Eaton record start (Jan 7, 2025 01:00 UTC)
const GRID = { crs: 'EPSG:32611', utm_zone: 11, center_e: 399738, center_n: 3784875, extent_m: 23000, bbox_lonlat: [-118.2145, 34.0952, -117.9623, 34.3048] }

function manifest(mode: 'live' | 'historical' = 'historical', id = '2025-eaton-fire-dbfa57'): IncidentManifest {
  return {
    id,
    mode,
    status: 'ready',
    grid: GRID,
    time_origin_ms: T0,
    time_range: { start_ms: T0, end_ms: T0 + 66 * H, now_ms: T0 + 66 * H },
    forecasts: [],
    built_ms: T0 + 100 * H,
  } as unknown as IncidentManifest
}

// events.json as the Eaton bundle has them (titles, details and sources verbatim)
const EVENTS: FireEvent[] = [
  { id: 'ev-01', type: 'ignition', t_ms: 1736302680000, title: 'Ignition', detail: 'Reported by CAL FIRE Jan 07, 18:18 PST. First persistent GOES detection Jan 07, 18:30 PST (GOES-18).', x: 1761.8, z: -359.8, confidence: 'observed', source: 'CAL FIRE + FIRMS GOES' },
  { id: 'ev-03', type: 'rapid_growth', t_ms: 1736310600000, title: 'Rapid growth', detail: '+2,741 ac/h; front ROS 206 ch/h (P90)', x: 104, z: 1189.9, confidence: 'estimated', source: 'Observed arrival (FIRMS VIIRS/MODIS + WFIGS)' },
  { id: 'ev-peak-wind', type: 'peak_wind', t_ms: 1736316000000, title: 'Peak wind', detail: 'Gust 72 mph (32.3 m/s) from NNE (25°) while the fire grew 598 ac/h.', x: -797.4, z: 436.1, confidence: 'estimated', source: 'open-meteo:historical-forecast:gfs_hrrr (10 m gust at the fire)' },
  { id: 'ev-04', type: 'spot_fire', t_ms: 1736328360000, title: 'Spot fire (prob.)', detail: 'New detection 1.4 km beyond the mapped fire edge (VIIRS NOAA-21); likely spotting.', x: 500, z: 200, confidence: 'probable', source: 'FIRMS VIIRS NOAA-21' },
  { id: 'ev-06', type: 'ridge_crossing', t_ms: 1736439384320, title: 'Ridge crossing', detail: 'Front crossed a ridge at 1,177 m (TPI +79 m), moving NNW.', x: -100, z: -900, confidence: 'estimated', source: 'USGS 3DEP terrain + observed arrival' },
  { id: 'ev-08', type: 'perimeter_update', t_ms: 1736460635000, title: 'First mapped perimeter', detail: 'NIFC WFIGS perimeter: 13,681 ac (cumulative 13,681 ac).', x: 10, z: 20, confidence: 'observed', source: 'NIFC WFIGS' },
  { id: 'ev-09', type: 'containment', t_ms: T0 + 65 * H, title: 'Containment', detail: '100% contained (CAL FIRE (100% contained)).', confidence: 'observed', source: 'CAL FIRE (100% contained)' },
]

const TS = {
  step_h: 1,
  t_ms: [1736310600000 + H / 2 - H, 1736310600000 + H / 2],
  area_acres: [100, 2841],
  growth_acres_per_h: [100, 2740.59],
  ros_ch_per_h: [20, 205.88],
  detections_per_h: [1, 5],
} as TimeseriesFile

const WEATHER = {
  source: 'open-meteo:historical-forecast:gfs_hrrr',
  t_ms: [1736316000000],
  at_fire: { temp_c: [12], rh_pct: [9], dewpoint_c: [-20], wind_speed_ms: [17.22], wind_dir_deg: [24.8], wind_gust_ms: [32.3], precip_mm: [0], fm1_pct: [3], fm10_pct: [4], fm100_pct: [6], ffwi: [86.2] },
  grid: { nx: 4, ny: 4, x: [], z: [], u_ms: [], v_ms: [] },
  forecast_from_ms: null,
} as unknown as WeatherFile

const square = (cx: number, cz: number, h: number): [number, number][] => [
  [cx - h, cz - h],
  [cx + h, cz - h],
  [cx + h, cz + h],
  [cx - h, cz + h],
]

const PERIMETERS: Perimeter[] = [
  { t_ms: 1736460635000, acres: 13681, source: 'NIFC WFIGS daily perimeters', rings: [square(0, 0, 1000)] },
  { t_ms: T0 + 66 * H, acres: 14111, source: 'NIFC WFIGS daily perimeters (final extent, mapped 2025-01-31)', rings: [square(300, -200, 100), square(-50, 40, 1500)] },
]

const det = (t: number, sat: string, instrument: Detection['instrument'], x: number, z: number): Detection => ({ t_ms: t, lat: 0, lon: 0, x, z, frp: 10, satellite: sat, instrument, confidence: 'n', daynight: 'N', footprint_m: instrument === 'MODIS' ? 1000 : 375 })

const DETECTIONS: Detection[] = [
  det(T0 + 10 * H, 'N20', 'VIIRS', 0, 0),
  det(T0 + 10 * H + 60_000, 'N20', 'VIIRS', 200, 100),
  det(T0 + 10 * H + 5 * 60_000, 'N20', 'VIIRS', 400, 200),
  det(T0 + 22 * H, 'N20', 'VIIRS', 100, 100),
  det(T0 + 10 * H + 2 * 60_000, 'Terra', 'MODIS', 50, 50),
  ...Array.from({ length: 20 }, (_, i) => det(T0 + 10 * H + i * 300_000, 'G18', 'GOES', 0, 0)),
]

const NOTE: Annotation = { id: 'note-1', t_ms: T0 + 30 * H, title: 'Smoke column visible from Pasadena', created_ms: 0 }

function forecast(mode: 'live' | 'historical', incidentId = '2025-eaton-fire-dbfa57'): ForecastManifest {
  return {
    run_id: 'fc-1',
    incident_id: incidentId,
    status: 'ready',
    issued_ms: T0 + 90 * H,
    start_ms: T0 + 31 * H,
    horizon_h: 72,
    time_origin_ms: T0,
    weather: { source: 'open-meteo:historical-forecast:gfs_hrrr', ensemble: mode === 'live' ? 'gfs025' : 'perturbed', members: 31 },
  } as unknown as ForecastManifest
}

const full = (extra: Partial<Parameters<typeof buildFeedItems>[0]> = {}) =>
  buildFeedItems({ manifest: manifest(), events: EVENTS, annotations: [NOTE], timeseries: TS, weather: WEATHER, perimeters: PERIMETERS, detections: DETECTIONS, forecast: forecast('historical'), units: 'us', ...extra })

const byId = (items: FeedItem[], id: string) => items.find((i) => i.id === id)!

describe('feed items: order and kinds', () => {
  it('lists every update chronologically with stable ties', () => {
    const items = full()
    const times = items.map((i) => i.tMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(items[0].id).toBe('ev-01')
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    // two passes at the same minute: ordered by id
    const again = full()
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id))
  })

  it('labels each item as observation, estimate, model output, official update or user note', () => {
    const items = full()
    expect(byId(items, 'ev-01').kind).toBe('observation')
    expect(byId(items, 'ev-03').kind).toBe('estimate')
    expect(byId(items, 'ev-peak-wind').kind).toBe('model')
    expect(byId(items, 'ev-04').kind).toBe('estimate')
    expect(byId(items, 'ev-06').kind).toBe('estimate')
    expect(byId(items, 'ev-08').kind).toBe('observation')
    expect(byId(items, 'ev-09').kind).toBe('official')
    expect(byId(items, 'note-1')).toMatchObject({ kind: 'annotation', automated: false, source: 'You (saved in this browser)', key: true })
    expect(byId(items, 'forecast:fc-1')).toMatchObject({ kind: 'model', automated: true, key: false })
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['observation', 'estimate', 'model', 'official', 'annotation']))
  })

  it('never presents automated output as human reporting', () => {
    const items = full()
    for (const id of ['ev-01', 'ev-03', 'ev-peak-wind', 'ev-04', 'ev-06']) expect(byId(items, id).automated).toBe(true)
    // agency products listed from their data are not "automated" reports, but name the agency
    expect(byId(items, 'ev-08')).toMatchObject({ automated: false, source: 'NIFC WFIGS' })
    expect(byId(items, 'ev-09')).toMatchObject({ automated: false, source: 'CAL FIRE' })
    for (const it of items.filter((i) => i.automated)) expect(it.source).not.toMatch(/^You/)
  })
})

describe('feed items: plain language', () => {
  it('describes rapid growth with everyday units from the timeseries and keeps the original text', () => {
    const it = byId(full(), 'ev-03')
    expect(it.title).toBe('Rapid growth')
    expect(it.detail).toBe('The burned area grew by about 2,741 acres in one hour. Spread speed reached about 2.6 mph at the fastest-moving parts of the edge. Timing estimated between satellite observations.')
    expect(it.facts).toEqual([
      { label: 'Growth', text: '2,741 acres per hour', scientific: '+2,741 ac/h' },
      { label: 'Spread speed (fastest 10% of the edge)', text: '2.6 mph', scientific: 'Rate of spread (ROS) 206 ch/h, 90th percentile of the front' },
    ])
    expect(it.original).toEqual({ title: 'Rapid growth', detail: '+2,741 ac/h; front ROS 206 ch/h (P90)', source: 'Observed arrival (FIRMS VIIRS/MODIS + WFIGS)' })
    // metric units, and the producer's numbers when the timeseries is missing
    const metric = byId(full({ units: 'metric', timeseries: null }), 'ev-03')
    expect(metric.detail).toMatch(/^The burned area grew by about 1,109 ha in one hour\. Spread speed reached about 4\.1 km\/h/)
  })

  it('describes peak wind with the FROM direction and fire weather severity from the weather file', () => {
    const it = byId(full(), 'ev-peak-wind')
    expect(it.title).toBe('Peak wind: gusts 72 mph')
    expect(it.detail).toBe("Strongest gust at the fire during the fire's active period: 72 mph from the north-northeast (sustained 39 mph). From weather-model data, not a wind station.")
    // with the growth of that hour in the timeseries it says how fast the fire was growing
    const ts = { ...TS, t_ms: [...TS.t_ms, 1736316000000], growth_acres_per_h: [...TS.growth_acres_per_h, 598.4], ros_ch_per_h: [...TS.ros_ch_per_h, 50] }
    expect(byId(full({ timeseries: ts }), 'ev-peak-wind').detail).toMatch(/^Strongest gust at the fire while the fire was growing about 598 acres per hour: 72 mph from the north-northeast/)
    expect(it.facts?.map((f) => f.label)).toEqual(['Wind', 'Gusts', 'Fire weather severity'])
    expect(it.facts?.[2]).toEqual({ label: 'Fire weather severity', text: '86 of 100', scientific: 'Fosberg Fire Weather Index (FFWI) 86.2' })
    expect(it.source).toBe('Archived NOAA HRRR weather-model forecasts (via Open-Meteo)')
  })

  it('words the other event types plainly', () => {
    const items = full()
    expect(byId(items, 'ev-01').title).toBe('Fire started')
    expect(byId(items, 'ev-01').detail).toContain('First repeated GOES satellite heat detection')
    expect(byId(items, 'ev-04').title).toBe('Possible spot fire')
    expect(byId(items, 'ev-04').detail).toMatch(/about 0\.9 mi beyond the mapped fire edge.*Not confirmed on the ground\./)
    expect(byId(items, 'ev-06').detail).toBe('The reconstructed spread moved over a ridge at about 3,862 ft, heading north-northwest. Estimated from terrain and satellite data.')
    expect(byId(items, 'ev-08').title).toBe('First fire perimeter mapped: 13,681 acres')
    expect(byId(items, 'ev-09').title).toBe('Fire 100% contained')
  })

  it("treats CAL FIRE's unconfirmed reported start as an official report, and moved starts as estimates", () => {
    const reported = { ...EVENTS[0], confidence: 'estimated' as const, source: 'CAL FIRE', detail: 'Reported by CAL FIRE Jun 20, 12:20 PDT.' }
    const r = byId(full({ events: [reported] }), 'ev-01')
    expect(r).toMatchObject({ title: 'Fire start reported', kind: 'official', automated: false, approximate: true })
    expect(r.detail).toBe('Reported by CAL FIRE Jun 20, 12:20 PDT. Not confirmed by satellite heat detections.')
    const moved = { ...reported, detail: 'Reported by CAL FIRE Jun 20, 12:20 PDT. Ignition estimated just before the first satellite detection.' }
    const m = byId(full({ events: [moved] }), 'ev-01')
    expect(m).toMatchObject({ title: 'Fire started (estimated time)', kind: 'estimate', automated: true })
    expect(m.detail).toContain('Start time estimated just before the first satellite detection.')
  })
})

describe('feed items: locations', () => {
  it('converts local metres to WGS84 and leaves items without coordinates unlocated', () => {
    const items = full()
    const ign = byId(items, 'ev-01')
    const [lon, lat] = localToLonLat(1761.8, -359.8, GRID)
    expect(ign.location).toEqual({ lon, lat, x: 1761.8, z: -359.8 })
    expect(lat).toBeGreaterThan(34.1)
    expect(lon).toBeLessThan(-118)
    expect(ign.approximate).toBe(true)
    expect(ign.locationLabel).toMatch(/not an exact ignition point/)
    expect(byId(items, 'ev-09').location).toBeNull()
    expect(byId(items, 'note-1').location).toBeNull()
    expect(byId(items, 'forecast:fc-1').location).toBeNull()
  })
})

describe('feed items: perimeters, satellite passes, forecast', () => {
  it('lists each perimeter once and names the final mapped extent', () => {
    const items = full()
    expect(items.filter((i) => i.topic === 'perimeter' || i.topic === 'perimeter_update').map((i) => i.id)).toEqual(['ev-08', `perimeter:${T0 + 66 * H}`])
    const fin = byId(items, `perimeter:${T0 + 66 * H}`)
    expect(fin.title).toBe('Final mapped extent: 14,111 acres')
    expect(fin.detail).toContain('mapped by fire agencies on 2025-01-31')
    expect(fin.location?.x).toBeCloseTo(-50, 6)
    expect(ringCentroid([square(-50, 40, 1500)])).toEqual([-50, 40])
  })

  it('groups detections into overpasses and skips the continuous GOES feed', () => {
    const passes = satellitePasses(DETECTIONS)
    expect(passes.map((p) => [p.instrument, p.satellite, p.dets.length])).toEqual([
      ['VIIRS', 'N20', 3],
      ['MODIS', 'Terra', 1],
      ['VIIRS', 'N20', 1],
    ])
    const it = byId(full(), `pass:N20:${T0 + 10 * H}`)
    expect(it).toMatchObject({ kind: 'observation', automated: true, key: false, title: 'Satellite pass: 3 heat detections', source: 'NASA FIRMS (VIIRS, NOAA-20)' })
    expect(it.detail).toContain('not the exact fire edge')
    expect(it.location?.x).toBeCloseTo(200, 6)
  })

  it('places the forecast at its issue time (live) or at the start of the re-run period (replay)', () => {
    const hind = byId(full({ preset: 'command' }), 'forecast:fc-1')
    expect(hind).toMatchObject({ tMs: T0 + 31 * H, seekMs: T0 + 31 * H, title: 'Hindcast starts (72\u00a0h)' })
    expect(hind.detail).toMatch(/re-run on .* to compare with what happened\./)
    expect(hind.original?.title).toBe('fc-1') // Command keeps the run id
    // Public: plain words and no run id (brief 2 C-R8)
    const plain = byId(full(), 'forecast:fc-1')
    expect(plain.title).toBe('Model re-run on past weather starts (72\u00a0h)')
    expect(plain.detail).toMatch(/^Fire-3d re-ran its experimental spread model on the weather of .* simulated fires, each with slightly different weather\), after the fire, to compare with what happened\.$/)
    expect(plain.original).toBeNull()
    expect(`${plain.title} ${plain.detail} ${plain.source}`).not.toContain('fc-1')
    const live = byId(full({ manifest: manifest('live'), forecast: forecast('live') }), 'forecast:fc-1')
    expect(live).toMatchObject({ tMs: T0 + 90 * H, seekMs: T0 + 31 * H, title: 'Spread forecast issued (72\u00a0h)' })
    expect(full({ forecast: forecast('historical', 'another-fire') }).some((i) => i.topic === 'forecast')).toBe(false)
  })

  it('keeps Key Events to events.json + annotations; the rest only when asked for', () => {
    const items = full()
    expect(filterFeed(items, 'key').map((i) => i.id)).toEqual(items.filter((i) => i.eventId != null).map((i) => i.id))
    const minimal = buildFeedItems({ manifest: manifest(), events: EVENTS, annotations: [] })
    expect(minimal.every((i) => i.key)).toBe(true)
    expect(minimal).toHaveLength(EVENTS.length)
  })

})

describe('feed view: live vs replay, "New"', () => {
  const items = filterFeed(full(), 'key')
  const tMid = 1736328360000 // the spot fire (ev-04)

  it('replay lists what had happened by the replay time, newest first, later updates on request', () => {
    const v = feedView(items, tMid, false, false)
    expect(v.listed.map((i) => i.id)).toEqual(['ev-04', 'ev-peak-wind', 'ev-03', 'ev-01'])
    expect(v.later.map((i) => i.id)).toEqual(['ev-09', 'ev-08', 'ev-06', 'note-1'])
    expect(v.currentId).toBe('ev-04')
    const all = feedView(items, tMid, false, true)
    expect(all.listed).toHaveLength(items.length)
    expect(all.listed[0].tMs).toBeGreaterThanOrEqual(all.listed[all.listed.length - 1].tMs)
    expect(feedView(items, T0, false, false)).toMatchObject({ listed: [], currentId: null })
  })

  it('live lists everything newest first and marks no current item', () => {
    const v = feedView(items, tMid, true, false)
    expect(v.listed).toHaveLength(items.length)
    expect(v.listed[0].id).toBe('ev-09')
    expect(v.currentId).toBeNull()
    expect(v.later.length).toBeGreaterThan(0) // dimmed, still listed
  })

  it('marks live arrivals as New, never notes, and a forecast run only when issued later', () => {
    const liveItems = full({ manifest: manifest('live'), forecast: forecast('live') })
    const b = feedBaseline('fire', liveItems)
    const fresh = { ...byId(liveItems, 'ev-04'), id: 'ev-99' }
    expect(isNewFeedItem(b, 'fire', fresh, true)).toBe(true)
    expect(isNewFeedItem(b, 'fire', fresh, false)).toBe(false)
    expect(isNewFeedItem(b, 'other-fire', fresh, true)).toBe(false)
    expect(isNewFeedItem(b, 'fire', byId(liveItems, 'ev-04'), true)).toBe(false)
    expect(isNewFeedItem(b, 'fire', { ...byId(liveItems, 'note-1'), id: 'note-2' }, true)).toBe(false)
    const fc = byId(liveItems, 'forecast:fc-1')
    expect(isNewFeedItem(b, 'fire', { ...fc, id: 'forecast:older', tMs: fc.tMs - H }, true)).toBe(false)
    expect(isNewFeedItem(b, 'fire', { ...fc, id: 'forecast:newer', tMs: fc.tMs + H }, true)).toBe(true)
  })
})

// items as the optional sources (web/src/extras) build them: current official status (not seekable), a camera
// summary (automated, not seekable) and a satellite scene (automated, seekable on the incident timeline)
const LIVE_END = T0 + 66 * H
const extraItem = (p: Partial<FeedItem> & Pick<FeedItem, 'id' | 'topic' | 'kind' | 'tMs'>): FeedItem => ({
  title: p.id,
  detail: null,
  source: 'test',
  automated: false,
  key: false,
  confidence: null,
  location: null,
  seekable: false,
  eventId: null,
  ...p,
})
const EVAC = extraItem({ id: 'evacuation:order:Lake County:Evacuation Order', topic: 'evacuation', kind: 'official', tMs: LIVE_END + 3 * H, key: true, source: 'Lake County via Cal OES' })
const CAMS = extraItem({ id: 'camera:summary:1,2,3,4', topic: 'camera', kind: 'observation', tMs: LIVE_END + 4 * H, automated: true })
const SCENE = extraItem({ id: 'imagery:s2-1', topic: 'imagery', kind: 'observation', tMs: T0 + 20 * H, automated: true, seekable: true, confidence: 'observed' })

describe('feed items from the optional sources', () => {
  const liveFull = (extra: readonly FeedItem[]) => full({ manifest: manifest('live'), forecast: forecast('live'), extra })

  it('merges them chronologically, keeps their kind and wording, drops repeats and invalid times', () => {
    const items = liveFull([EVAC, CAMS, SCENE, { ...EVAC, title: 'repeat' }, { ...SCENE, id: 'imagery:bad', tMs: Number.NaN }, { ...SCENE, id: 'ev-04' }])
    const times = items.map((i) => i.tMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(byId(items, EVAC.id)).toEqual(EVAC)
    expect(items.filter((i) => i.id === EVAC.id)).toHaveLength(1)
    expect(items.some((i) => i.id === 'imagery:bad')).toBe(false)
    expect(byId(items, 'ev-04').topic).toBe('spot_fire') // an extra cannot replace a bundle item
    expect(byId(items, CAMS.id)).toMatchObject({ kind: 'observation', automated: true })
    expect(filterFeed(items, 'key').map((i) => i.id)).toContain(EVAC.id)
    expect(full({ extra: null })).toEqual(full())
  })

  it('never dims live current-status items as "later"; replay keeps them out of the past', () => {
    const items = liveFull([EVAC, CAMS, SCENE])
    const now = LIVE_END
    const live = feedView(items, now, true, false)
    expect(live.listed.map((i) => i.id).filter((id) => id === CAMS.id || id === EVAC.id)).toEqual([CAMS.id, EVAC.id])
    expect(live.later.map((i) => i.id)).not.toContain(EVAC.id)
    expect(isLaterItem(EVAC, now, true)).toBe(false)
    expect(isLaterItem(SCENE, T0 + 10 * H, true)).toBe(true) // a seekable scene after the timeline time
    // replay: a current status is not part of the replayed past
    const replay = feedView(items, now, false, false)
    expect(replay.listed.map((i) => i.id)).not.toContain(EVAC.id)
    expect(replay.later.map((i) => i.id)).toContain(EVAC.id)
    expect(isLaterItem(EVAC, now, false)).toBe(true)
  })

  it('does not mark the first batch of a separately loaded source as New, but later arrivals', () => {
    const core = liveFull([])
    const b0 = feedBaseline('fire', core)
    const withExtras = liveFull([EVAC, CAMS])
    const b1 = extendFeedBaseline(b0, withExtras)
    expect(b1).not.toBeNull()
    expect(isNewFeedItem(b1, 'fire', EVAC, true)).toBe(false)
    expect(isNewFeedItem(b1, 'fire', CAMS, true)).toBe(false)
    expect(extendFeedBaseline(b1!, withExtras)).toBeNull() // converges
    const order2 = { ...EVAC, id: 'evacuation:order:Lake County:Evacuation Order 2' }
    expect(isNewFeedItem(b1, 'fire', order2, true)).toBe(true)
    // bundle topics are not "late": a refresh's first satellite pass is New
    expect(extendFeedBaseline(b0, [{ ...SCENE, id: 'pass:N20:1', topic: 'detection' }])).toBeNull()
  })
})

describe('feed keyboard (roving focus)', () => {
  it('moves one row with the arrows, to the ends with Home / End, ignores other keys', () => {
    expect(rovingIndex('ArrowDown', 0, 3)).toBe(1)
    expect(rovingIndex('ArrowDown', 2, 3)).toBe(2)
    expect(rovingIndex('ArrowUp', 0, 3)).toBe(0)
    expect(rovingIndex('ArrowUp', 2, 3)).toBe(1)
    expect(rovingIndex('Home', 2, 3)).toBe(0)
    expect(rovingIndex('End', 0, 3)).toBe(2)
    expect(rovingIndex('Enter', 0, 3)).toBeNull()
    expect(rovingIndex('ArrowDown', -1, 3)).toBeNull()
    expect(rovingIndex('ArrowDown', 0, 0)).toBeNull()
  })

  it('keeps one Tab stop: last focused, else selected, else current, else the first row', () => {
    const ids = ['a', 'b', 'c']
    expect(rovingTabStop(ids, ['b', 'c'])).toBe('b')
    expect(rovingTabStop(ids, ['gone', null, 'c'])).toBe('c')
    expect(rovingTabStop(ids, [null, undefined])).toBe('a')
    expect(rovingTabStop([], ['a'])).toBeNull()
  })
})

describe('selectFeedItem', () => {
  beforeEach(() => {
    useStore.setState({ manifest: manifest(), forecast: forecast('historical'), timeMs: T0, playing: true, selectedEventId: null, flyTo: null })
  })

  it('pauses, seeks, selects and flies to a geolocated event', () => {
    const it = byId(full(), 'ev-04')
    selectFeedItem(it)
    const s = useStore.getState()
    expect(s.playing).toBe(false)
    expect(s.timeMs).toBe(it.tMs)
    expect(s.selectedEventId).toBe('ev-04')
    expect(s.flyTo).toMatchObject({ x: 500, z: 200, nonce: 1 })
  })

  it('keeps items without coordinates usable without an invented target', () => {
    selectFeedItem(byId(full(), 'ev-09'))
    const s = useStore.getState()
    expect(s.selectedEventId).toBe('ev-09')
    expect(s.timeMs).toBe(T0 + 65 * H)
    expect(s.flyTo).toBeNull()
  })

  it('uses the seek target, clamps it to the timeline and selects non-event items by their id', () => {
    const live = byId(full({ manifest: manifest('live'), forecast: forecast('live') }), 'forecast:fc-1')
    selectFeedItem(live)
    expect(useStore.getState().timeMs).toBe(T0 + 31 * H)
    expect(useStore.getState().selectedEventId).toBe(selectionId(live))
    selectFeedItem({ ...live, seekMs: T0 + 1000 * H })
    expect(useStore.getState().timeMs).toBe(T0 + 31 * H + 72 * H)
    useStore.setState({ timeMs: T0 + 5 * H })
    selectFeedItem({ ...live, seekable: false })
    expect(useStore.getState().timeMs).toBe(T0 + 5 * H)
  })
})
