import { describe, expect, it } from 'vitest'
import { EVAC_SAMPLE } from '../extras/__fixtures__/samples'
import { EVAC_RENO_NOT_AVAILABLE, OR_EVAC_KLAMATH_NONE, OR_EVAC_MEDFORD } from '../extras/__fixtures__/samplesUs'
import type { EvacuationsResponse, EvacZoneFeature } from '../extras/types'
import type { FireReference } from './fire'
import {
  evacuationAtPointState,
  evacuationNow,
  checkedScope,
  coversLower48,
  fireWeatherAtPointState,
  fireWeatherNow,
  groupZones,
  LOWER48_CODES,
  officialNowScope,
  statesChecked,
  needsPointQuery,
  needsStatewideFireWeather,
  officialBadge,
  pointQueryBbox,
  statewideCountText,
  type EvacuationOfficial,
  type FireWeatherOfficial,
} from './model'
import { FW_COOLEY_LIVE_QUIET, FW_EATON_ARCHIVE, NWS_LIVE_LOX_RFW } from './__fixtures__/samples'
import type { FireWeatherResponse } from './types'
import { timeFmt } from '../lib/time'
import { fireWeatherLines } from '../location/official'

const LA24 = timeFmt('America/Los_Angeles', '24h')

const ok = <T,>(data: T | null, extra: { loading?: boolean; error?: string | null } = {}) => ({ data, loading: false, error: null, ...extra })
const ORDER = EVAC_SAMPLE.zones.features[0]
const [cx, cy] = ORDER.geometry.type === 'Polygon' ? ORDER.geometry.coordinates[0][0] : [0, 0]
const INSIDE_ORDER = ((): [number, number] => {
  // a point inside the recorded order zone: the centroid of its first ring
  const r = (ORDER.geometry as { coordinates: number[][][] }).coordinates[0]
  const n = r.length - 1
  return [r.slice(0, n).reduce((a, p) => a + p[0], 0) / n, r.slice(0, n).reduce((a, p) => a + p[1], 0) / n]
})()
const FIRE: FireReference = { points: [[-118.6, 34.1]], rings: [], aoi: [[-118.9, 34.0], [-118.5, 34.0], [-118.5, 34.25], [-118.9, 34.25]], perimeterMs: null, detections: 0 }
const noZones: EvacuationsResponse = { ...EVAC_SAMPLE, zones: { type: 'FeatureCollection', features: [] } }

describe('evacuation near the fire (Official now)', () => {
  it('lists shown zones by urgency with their distance, else says none listed is not an all-clear', () => {
    const e = evacuationNow(ok(EVAC_SAMPLE), FIRE, { hasIncident: true, layerOn: true, marginKm: 15 })
    expect(e.state).toBe('listed')
    expect(e.zones[0]).toMatchObject({ status: 'Evacuation Order', group: 'order', issuer: 'Los Angeles County' })
    expect(e.zones.every((z) => z.distanceKm != null)).toBe(true)
    expect(e.zones.some((z) => z.issuedMs != null)).toBe(false) // Cal OES gives no issue time
    expect(e.checkedMs).toBe(EVAC_SAMPLE.retrieved_ms)
    expect(e.sourceUpdatedMs).toBe(EVAC_SAMPLE.source_updated_ms)
    expect(e.bounds).not.toBeNull()
    const none = evacuationNow(ok(noZones), FIRE, { hasIncident: true, layerOn: false, marginKm: 15 })
    expect(none).toMatchObject({ state: 'none-listed', layerOff: true })
    expect(none.caveat).toBe('No orders or warnings are listed within 15 km of this fire right now. That is not an all-clear: follow local officials.')
  })

  it('says loading, past date, unavailable (with county maps) and not checked, never "none"', () => {
    expect(evacuationNow(ok(null, { loading: true }), FIRE, { hasIncident: true, layerOn: true, marginKm: 15 }).state).toBe('loading')
    expect(evacuationNow(ok(null, { error: 'Could not reach the Fire-3d server.' }), FIRE, { hasIncident: true, layerOn: true, marginKm: 15 })).toMatchObject({ state: 'unavailable', reason: 'Could not reach the Fire-3d server.' })
    const past = { ...noZones, status: 'not_available_for_past_dates' as const, reason: 'Current only.' }
    expect(evacuationNow(ok(past), FIRE, { hasIncident: true, layerOn: true, marginKm: 15 })).toMatchObject({ state: 'past-date', reason: 'Current only.' })
    const notCovered = { ...noZones, status: 'unavailable' as const, reason: 'Not in the statewide layer.', coverage: [{ county: 'Ventura', in_statewide_layer: false, acquisition_status: null, zone_source: null, reference_url: 'https://www.venturacountyemergency.com/' }] }
    expect(evacuationNow(ok(notCovered), FIRE, { hasIncident: true, layerOn: true, marginKm: 15 })).toMatchObject({ state: 'unavailable', links: [{ label: 'Ventura County evacuation map', url: 'https://www.venturacountyemergency.com/' }] })
    expect(evacuationNow(null, null, { hasIncident: false, layerOn: true, marginKm: 15 })).toMatchObject({ state: 'not-checked', reason: expect.stringMatching(/^Zoom in on a fire or pick one/) })
  })
})

describe('evacuation at a point (location card)', () => {
  const inc = ok(EVAC_SAMPLE)
  const base = { incident: inc, incidentBbox: EVAC_SAMPLE.bbox, point: null, past: false, fire: FIRE }

  it('lists the zones at the point inside the checked area, with times by who set them', () => {
    const e = evacuationAtPointState({ ...base, lon: INSIDE_ORDER[0], lat: INSIDE_ORDER[1] })
    expect(e.state).toBe('listed')
    expect(e.zones.map((z) => z.status)).toContain('Evacuation Order')
    const z = e.zones.find((x) => x.status === 'Evacuation Order')!
    expect(z.updatedMs).toBe(ORDER.properties.status_updated_ms)
    expect(z.issuedMs).toBeUndefined()
  })

  it('"none listed" only inside the checked area; outside, its own point query decides', () => {
    // inside the bbox, outside every zone
    const none = evacuationAtPointState({ ...base, lon: -118.99, lat: 34.29 })
    expect(none.state).toBe('none-listed')
    expect(none.caveat).toMatch(/That is not an all-clear: follow local officials\.$/)
    // outside the fire's area (Irvine): the point needs its own query; until it answers: loading
    const irvine = { lon: -117.79, lat: 33.68 }
    expect(needsPointQuery({ ...irvine, incidentBbox: EVAC_SAMPLE.bbox, past: false, incidentData: EVAC_SAMPLE })).toBe(true)
    expect(evacuationAtPointState({ ...base, ...irvine, point: ok(null, { loading: true }) }).state).toBe('loading')
    const pointAnswer = { ...noZones, bbox: pointQueryBbox(irvine.lon, irvine.lat), incident_id: null }
    expect(evacuationAtPointState({ ...base, ...irvine, point: ok(pointAnswer) }).state).toBe('none-listed')
    expect(evacuationAtPointState({ ...base, ...irvine, point: ok(null, { error: 'Could not reach the Fire-3d server.' }) }).state).toBe('unavailable')
  })

  it('past dates and no point are said as such; a point outside the fire always asks the backend (brief 3)', () => {
    expect(evacuationAtPointState({ ...base, lon: -118.99, lat: 34.29, past: true })).toMatchObject({ state: 'past-date', reason: 'Official status is shown only for the current time.' })
    expect(evacuationAtPointState({ ...base, lon: null, lat: null }).state).toBe('not-checked')
    // a past time in a state without a feed (the fire's own answer is state_not_available): the state reason, as the
    // fire's panel says, never "not shown for past dates" (integration)
    const reno = { ...base, incident: ok(EVAC_RENO_NOT_AVAILABLE), incidentBbox: EVAC_RENO_NOT_AVAILABLE.bbox, past: true }
    expect(evacuationAtPointState({ ...reno, lon: -119.81, lat: 39.53 })).toMatchObject({ state: 'not-available', reason: 'Not available in this state (Nevada)' })
    // outside that fire's area a past time stays "not shown for past dates"
    expect(evacuationAtPointState({ ...reno, lon: -118.0, lat: 39.53 }).state).toBe('past-date')
    // no California rectangle any more: a Kansas point is asked about too (the backend answers from its registry)
    expect(needsPointQuery({ lon: -100, lat: 40, incidentBbox: null, past: false, incidentData: null })).toBe(true)
    expect(evacuationAtPointState({ ...base, lon: -100, lat: 40, point: ok(null, { loading: true }) }).state).toBe('loading')
    expect(needsPointQuery({ lon: -100, lat: 40, incidentBbox: null, past: true, incidentData: null })).toBe(false)
    expect(needsPointQuery({ lon: -118.99, lat: 34.29, incidentBbox: EVAC_SAMPLE.bbox, past: false, incidentData: EVAC_SAMPLE })).toBe(false)
  })

  it('queries a small box that always contains the point', () => {
    const b = pointQueryBbox(-117.7912345, 33.6812345)
    expect(b[0] < -117.7912345 && b[2] > -117.7912345 && b[1] < 33.6812345 && b[3] > 33.6812345).toBe(true)
    expect(b[2] - b[0]).toBeCloseTo(0.01, 6)
  })
})

describe('NWS fire weather states', () => {
  const REPLAY = 1736366400000
  const LIVE_AT = 1792260000000
  const live = (alerts = NWS_LIVE_LOX_RFW): FireWeatherResponse => ({
    ...FW_COOLEY_LIVE_QUIET,
    incident_id: null,
    area_bbox: null,
    alerts,
    zones: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-118.7, 34.3], [-118.4, 34.3], [-118.4, 34.5], [-118.7, 34.5], [-118.7, 34.3]]] }, properties: { ugc: 'CAZ288', name: 'Santa Clarita Valley', alert_ids: [NWS_LIVE_LOX_RFW[0].id] } }] },
  })

  it('near the fire: in effect, quiet ("not an all-clear"), past date and demo', () => {
    const fw = fireWeatherNow(ok(FW_EATON_ARCHIVE), REPLAY, { demo: false, hasIncident: true, tf: LA24 })
    expect(fw.state).toBe('active')
    expect(fw.archived).toBe(true)
    expect(fw.credit).toBe('National Weather Service via Iowa Environmental Mesonet archive')
    expect(fw.alerts.map((a) => [a.event, a.phase])).toEqual([
      ['Red Flag Warning', 'active'],
      ['Fire Weather Watch', 'upcoming'],
    ])
    expect(fw.alerts[0]).toMatchObject({ senderName: 'National Weather Service Los Angeles/Oxnard CA', timeText: 'until Jan 10, 14:48 PST', coversReportedLocation: true, archived: true })
    const quiet = fireWeatherNow(ok(FW_COOLEY_LIVE_QUIET), Date.now(), { demo: false, hasIncident: true, tf: LA24 })
    expect(quiet).toMatchObject({ state: 'none', archived: false, credit: 'National Weather Service' })
    expect(quiet.caveat).toMatch(/near this fire\. That is not an all-clear/)
    expect(fireWeatherNow(ok({ ...FW_COOLEY_LIVE_QUIET, status: 'not_available_for_past_dates', reason: 'Archive down.' }), Date.now(), { demo: false, hasIncident: true, tf: LA24 })).toMatchObject({ state: 'past-date', reason: 'Archive down.' })
    // the archive could not be reached: unavailable right now, never "not available for this time" (panel SR-m1)
    expect(
      fireWeatherNow(ok({ ...FW_COOLEY_LIVE_QUIET, status: 'not_available_for_past_dates', reason_code: 'upstream_error', reason: 'The archive could not be reached.' }), Date.now(), { demo: false, hasIncident: true, tf: LA24 }),
    ).toMatchObject({ state: 'unavailable', reasonCode: 'upstream_error' })
    expect(fireWeatherNow(ok(FW_COOLEY_LIVE_QUIET), Date.now(), { demo: true, hasIncident: true, tf: LA24 })).toMatchObject({ state: 'unavailable', reasonCode: 'demo' })
    expect(fireWeatherNow(ok(live()), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }).state).toBe('active')
    expect(fireWeatherNow(ok({ ...live([]) }), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }).caveat).toMatch(/in California\. That is not an all-clear/)
  })

  it("at a point: the fire's area decides inside it; the statewide answer elsewhere; never 'none' unchecked", () => {
    const base = { refMs: LIVE_AT, hasIncident: true, demo: false, past: false, fallbackArea: null, statewide: null, pointState: 'CA', tf: LA24 }
    // inside the fire's checked area (Cooley's area_bbox), no alert there
    const [w, s, e, n] = FW_COOLEY_LIVE_QUIET.area_bbox!
    expect(fireWeatherAtPointState({ ...base, lon: (w + e) / 2, lat: (s + n) / 2, incident: ok(FW_COOLEY_LIVE_QUIET) }).state).toBe('none')
    // elsewhere: the statewide answer
    const out = { lon: -118.5, lat: 34.4 }
    expect(needsStatewideFireWeather({ ...out, hasIncident: true, demo: false, past: false, fallbackArea: null, incidentData: FW_COOLEY_LIVE_QUIET })).toBe(true)
    const st = fireWeatherAtPointState({ ...base, ...out, incident: ok(FW_COOLEY_LIVE_QUIET), statewide: ok(live()) })
    expect(st.state).toBe('active')
    expect(st.alerts[0]).toMatchObject({ event: 'Red Flag Warning', phase: 'active', senderName: 'NWS Los Angeles/Oxnard CA', timeText: 'until Oct 17, 20:00 PDT' })
    expect(fireWeatherAtPointState({ ...base, lon: -121.9, lat: 37.3, incident: ok(FW_COOLEY_LIVE_QUIET), statewide: ok(live()) }).state).toBe('none')
    expect(fireWeatherAtPointState({ ...base, ...out, incident: ok(FW_COOLEY_LIVE_QUIET), statewide: ok(null, { loading: true }) }).state).toBe('loading')
    // past times outside the fire's area are not checked: said as such
    expect(fireWeatherAtPointState({ ...base, ...out, past: true, incident: ok(FW_COOLEY_LIVE_QUIET) })).toMatchObject({ state: 'past-date', reasonCode: 'past_date' })
    expect(fireWeatherAtPointState({ ...base, lon: -100, lat: 40, pointState: 'KS', incident: ok(FW_COOLEY_LIVE_QUIET), statewide: ok(live()) })).toMatchObject({ state: 'unavailable', reasonCode: 'not_checked' })
    expect(fireWeatherAtPointState({ ...base, lon: null, lat: null, incident: ok(FW_COOLEY_LIVE_QUIET) })).toMatchObject({ state: 'unavailable', reasonCode: 'not_checked' })
    // the overview (no fire open): the statewide answer
    expect(needsStatewideFireWeather({ ...out, hasIncident: false, demo: false, past: false, fallbackArea: null, incidentData: null })).toBe(true)
    expect(fireWeatherAtPointState({ ...base, ...out, hasIncident: false, incident: null, statewide: ok(live()) }).state).toBe('active')
  })
})

describe('badge and grouping', () => {
  const zone = (status: string, group: 'order' | 'warning' | 'other', issuer: string, d: number | null = 1) => ({ id: `${status}${issuer}${d}`, status, group, issuer, distanceKm: d, outsideAnalysisArea: false, name: null, message: null })
  const listed = (zones: ReturnType<typeof zone>[]): EvacuationOfficial => ({ state: 'listed', zones, checkedMs: 1, sourceUpdatedMs: 1, sourceUrl: null, caveat: '' })
  const fw = (state: FireWeatherOfficial['state'], phases: FireWeatherOfficial['alerts'][number]['phase'][] = []): FireWeatherOfficial =>
    ({ state, alerts: phases.map((phase, i) => ({ id: `${i}`, event: 'Red Flag Warning', senderName: 'NWS', headline: '', url: null, archived: false, phase, timeText: '', coversReportedLocation: null, nearestKm: null, ugcs: [], bounds: null })), checkedMs: 1, archived: false, credit: '', sourceUrl: '', caveat: '' }) as FireWeatherOfficial

  it('counts active official items and names the most urgent level', () => {
    expect(officialBadge(listed([zone('Evacuation Order', 'order', 'A'), zone('Evacuation Order', 'order', 'A', 2), zone('Evacuation Warning', 'warning', 'B'), zone('Advisory', 'other', 'C')]), fw('active', ['active', 'expired']))).toEqual({ count: 3, level: 'order' })
    expect(officialBadge(listed([zone('Evacuation Warning', 'warning', 'B')]), fw('none'))).toEqual({ count: 1, level: 'warning' })
    expect(officialBadge({ ...listed([]), state: 'none-listed' }, fw('active', ['upcoming']))).toEqual({ count: 1, level: 'fire-weather' })
    expect(officialBadge({ ...listed([]), state: 'past-date' }, fw('past-date'))).toEqual({ count: 0, level: null })
  })

  it('groups zones by wording and issuer, most urgent and nearest first', () => {
    const g = groupZones([zone('Evacuation Warning', 'warning', 'B', 3), zone('Evacuation Order', 'order', 'A', 9), zone('Evacuation Order', 'order', 'A', 2)])
    expect(g.map((x) => [x.status, x.zones.length, x.distanceKm])).toEqual([
      ['Evacuation Order', 2, 2],
      ['Evacuation Warning', 1, 3],
    ])
  })
})

// keep the recorded sample honest: a zone of the sample has the issuer time the tests rely on
describe('fixture sanity', () => {
  it('has an issuer time on the recorded order zone', () => {
    expect((ORDER as EvacZoneFeature).properties.status_updated_ms).toBeGreaterThan(0)
    expect(Number.isFinite(cx) && Number.isFinite(cy)).toBe(true)
  })
})

// ---- brief 3: evacuations across the lower 48 (CONTRACT §14.8.5) ------------------------------------------------
describe('evacuations outside California (brief 3)', () => {
  const NA = (state: string, name: string, bbox: [number, number, number, number]): EvacuationsResponse => ({
    ...EVAC_RENO_NOT_AVAILABLE,
    bbox,
    reason: `Official evacuation zones are not available in this state (${name}). Follow local officials.`,
    states: [{ ...EVAC_RENO_NOT_AVAILABLE.states![0], state, name }],
  })
  const borderPoints: [string, number, number, string, string][] = [
    ['Reno', -119.81, 39.53, 'NV', 'Nevada'],
    ['Las Vegas', -115.17, 36.17, 'NV', 'Nevada'],
    ['Yuma', -114.56, 32.69, 'AZ', 'Arizona'],
    ['Bozeman', -111.04, 45.68, 'MT', 'Montana'],
  ]
  it.each(borderPoints)('%s: not available in this state, never "none" (the backend answers from its registry)', (_name, lon, lat, st, name) => {
    expect(needsPointQuery({ lon, lat, incidentBbox: null, past: false, incidentData: null })).toBe(true)
    const e = evacuationAtPointState({ lon, lat, incident: null, incidentBbox: null, point: ok(NA(st, name, pointQueryBbox(lon, lat))), past: false, fire: null, pointState: st })
    expect(e).toMatchObject({ state: 'not-available', reason: `Not available in this state (${name})`, zones: [], checkedMs: null, sourceUrl: null })
    expect(e.notAvailableIn).toEqual([name])
    expect(JSON.stringify(e)).not.toMatch(/Cal OES|none listed/i)
  })

  it('a fire in a state without a feed: Official now says not available, never "none listed"', () => {
    const e = evacuationNow(ok(NA('NV', 'Nevada', [-120, 39.4, -119.6, 39.7])), null, { hasIncident: true, layerOn: true, marginKm: 15 })
    expect(e.state).toBe('not-available')
    expect(e.reason).toBe('Not available in this state (Nevada)')
  })

  it('outside the lower 48: the backend sentence, no state named', () => {
    const ak: EvacuationsResponse = { ...EVAC_RENO_NOT_AVAILABLE, states: [], reason: 'Fire-3d does not support Alaska, Hawaii or US territories yet.' }
    const e = evacuationAtPointState({ lon: -149.9, lat: 61.2, incident: null, incidentBbox: null, point: ok(ak), past: false, fire: null, pointState: null })
    expect(e).toMatchObject({ state: 'not-available', reason: 'Fire-3d does not support Alaska, Hawaii or US territories yet.', notAvailableIn: [] })
  })

  it('a Medford OR point is checked: Oregon OEM zones with OEM level definitions and the state-layer time', () => {
    const inside = { lon: -123.18767, lat: 42.45705 }
    const e = evacuationAtPointState({ ...inside, incident: null, incidentBbox: null, point: ok(OR_EVAC_MEDFORD), past: false, fire: null, pointState: 'OR' })
    expect(e.state).toBe('listed')
    expect(e.checkedBy).toBe('Oregon OEM')
    const z = e.zones[0]
    expect(z).toMatchObject({ status: 'Level 3: GO NOW – Leave Immediately!', group: 'order', issuer: 'Jackson County', verbatim: false, aggregator: 'Oregon OEM', listedPhrase: 'added to the Oregon state layer', listedMs: 1786666812468 })
    expect(z.updatedMs).toBeUndefined() // OEM gives no issue time
    expect(z.levelNote).toBe('"Level 3" is Fire-3d\'s wording of Oregon OEM\'s level number; Oregon OEM defines it as "Level 3: GO NOW – Leave Immediately!".')
    expect(z.incidentNote).toBe('Fire name as recorded by Oregon OEM: Fielders Mountain; a name match is not proof it is this fire')
    expect(e.sources?.map((s) => [s.aggregator, s.credit, s.answered])).toEqual([['Oregon OEM', 'Oregon Department of Emergency Management', true]])
    // inside the checked area but in no zone: none listed by Oregon OEM, not an all-clear
    const none = evacuationAtPointState({ lon: -122.65, lat: 42.55, incident: null, incidentBbox: null, point: ok(OR_EVAC_MEDFORD), past: false, fire: null, pointState: 'OR' })
    expect(none).toMatchObject({ state: 'none-listed', checkedBy: 'Oregon OEM' })
    expect(none.caveat).toMatch(/not an all-clear/)
    const klamath = evacuationAtPointState({ lon: -121.78, lat: 42.22, incident: null, incidentBbox: null, point: ok(OR_EVAC_KLAMATH_NONE), past: false, fire: null, pointState: 'OR' })
    expect(klamath).toMatchObject({ state: 'none-listed', checkedBy: 'Oregon OEM', sourceUrl: 'https://www.arcgis.com/home/item.html?id=dd2bee51e3004dc4b1004df34fbd9e29' })
  })

  it('a border answer (CA checked, NV not): the point state decides; unknown while it is looked up', () => {
    const mixed: EvacuationsResponse = {
      ...noZones,
      bbox: [-120.1, 39.0, -119.9, 39.2],
      states: [
        { state: 'CA', name: 'California', availability: 'available', checked: true, source_ids: ['caloes_evacuations'], note: null, links: [] },
        { state: 'NV', name: 'Nevada', availability: 'not_available', checked: false, source_ids: [], note: null, links: [] },
      ],
    }
    const pt = { lon: -119.95, lat: 39.1, incident: null, incidentBbox: null, past: false, fire: null }
    expect(evacuationAtPointState({ ...pt, point: ok(mixed), pointState: undefined }).state).toBe('loading')
    expect(evacuationAtPointState({ ...pt, point: ok(mixed), pointState: 'NV' })).toMatchObject({ state: 'not-available', reason: 'Not available in this state (Nevada)' })
    expect(evacuationAtPointState({ ...pt, point: ok(mixed), pointState: 'CA' }).state).toBe('none-listed')
  })
})

describe('NWS "checked" follows states_checked only (CONTRACT §14.6)', () => {
  const LIVE_AT = 1792260000000
  const caOnly: FireWeatherResponse = { ...FW_COOLEY_LIVE_QUIET, incident_id: null, area_bbox: null, alerts: [], states_checked: ['CA'] }
  const national: FireWeatherResponse = { ...caOnly, states_checked: [...LOWER48_CODES] }
  const base = { refMs: LIVE_AT, hasIncident: false, demo: false, past: false, fallbackArea: null, incident: null }
  it('a California-only answer: Reno is "not checked", never claimed for the lower 48', () => {
    expect(needsStatewideFireWeather({ lon: -119.81, lat: 39.53, hasIncident: false, demo: false, past: false, fallbackArea: null, incidentData: null })).toBe(true)
    const reno = fireWeatherAtPointState({ ...base, lon: -119.81, lat: 39.53, statewide: ok(caOnly), pointState: 'NV' })
    expect(reno).toMatchObject({ state: 'unavailable', reasonCode: 'not_checked' })
    expect(fireWeatherAtPointState({ ...base, lon: -118.5, lat: 34.4, statewide: ok(caOnly), pointState: 'CA' }).state).toBe('none')
    // a missing states_checked (older backend) is read as ["CA"]
    const { states_checked: _drop, ...legacy } = caOnly
    expect(fireWeatherAtPointState({ ...base, lon: -119.81, lat: 39.53, statewide: ok(legacy as FireWeatherResponse), pointState: 'NV' }).reasonCode).toBe('not_checked')
    expect(statesChecked(legacy as FireWeatherResponse)).toEqual(['CA'])
    expect(coversLower48(caOnly)).toBe(false)
    expect(checkedScope(caOnly)).toBe('California')
    const quiet = fireWeatherNow(ok(caOnly), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 })
    expect(quiet.caveat).toMatch(/in California\. That is not an all-clear/)
    expect(JSON.stringify(quiet)).not.toMatch(/lower 48/)
  })
  it('a 49-code answer: Reno is checked, none in effect here', () => {
    expect(fireWeatherAtPointState({ ...base, lon: -119.81, lat: 39.53, statewide: ok(national), pointState: 'NV' }).state).toBe('none')
    expect(fireWeatherAtPointState({ ...base, lon: -149.9, lat: 61.2, statewide: ok(national), pointState: null }).reasonCode).toBe('not_checked') // Alaska
    expect(coversLower48(national)).toBe(true)
    expect(checkedScope(national)).toBe('the lower 48 states')
    expect(fireWeatherNow(ok(national), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }).caveat).toMatch(/in the lower 48 states\. That is not an all-clear/)
    expect(checkedScope({ states_checked: [] })).toBeNull()
    // the Official now header follows states_checked
    expect(officialNowScope(fireWeatherNow(ok(national), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }))).toBe('lower 48 states')
    expect(officialNowScope(fireWeatherNow(ok(caOnly), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }))).toBe('California')
    expect(officialNowScope(fireWeatherNow(ok({ ...caOnly, states_checked: ['CA', 'OR'] }), LIVE_AT, { demo: false, hasIncident: false, statewide: true, tf: LA24 }))).toBe('California, Oregon')
  })
  it('review R2: while the point\'s state is being looked up, even a 49-code answer waits (never "checked" for Anchorage or Tijuana)', () => {
    const points = { Reno: [-119.81, 39.53], Anchorage: [-149.9, 61.2], Tijuana: [-117.02, 32.51] }
    for (const [lon, lat] of Object.values(points)) {
      const st = fireWeatherAtPointState({ ...base, lon, lat, statewide: ok(national), pointState: undefined })
      expect(st.state).toBe('loading')
      expect(fireWeatherLines(st).map((l) => l.text)).toEqual(['Checking NWS fire weather alerts…'])
    }
    // once the lookup answers: Anchorage and Tijuana (outside the lower 48: null) are not checked; Reno is checked
    for (const [lon, lat] of [points.Anchorage, points.Tijuana]) {
      const st = fireWeatherAtPointState({ ...base, lon, lat, statewide: ok(national), pointState: null })
      expect(fireWeatherLines(st)[0].text).toBe('Fire weather alerts (NWS): not checked here')
    }
    expect(fireWeatherAtPointState({ ...base, lon: -119.81, lat: 39.53, statewide: ok(national), pointState: 'NV' }).state).toBe('none')
  })
})

// Integration part 1 review UX-m5: the national summary never calls upcoming alerts "in effect".
describe('national fire weather count', () => {
  it('in effect / upcoming / in effect or upcoming', () => {
    const up = { phase: 'upcoming' }
    const on = { phase: 'active' }
    expect(statewideCountText([up, up, up, up], 4, 'the lower 48 states')).toBe('4 alerts upcoming in 4 states; the 3 most recent:')
    expect(statewideCountText([on, up, on, on], 4, 'the lower 48 states')).toBe('4 alerts in effect or upcoming in 4 states; the 3 most recent:')
    expect(statewideCountText([on, on, on, on], 1, 'California')).toBe('4 alerts in effect in California; the 3 most recent:')
  })
})
