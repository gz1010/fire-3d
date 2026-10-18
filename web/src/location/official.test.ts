import { describe, expect, it } from 'vitest'
import type { EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialInfo, OfficialZone } from '../official/hooks'
import { fmtDateTime, tzLabel } from '../lib/time'
import { alertsInEffect, calfireLine, officialBlock, officialFireWeatherNote, withoutFollow, type OfficialContext } from './official'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const at = (ms: number) => `${fmtDateTime(ms)} ${tzLabel(ms)}`
const CTX: OfficialContext = { nowMs: NOW, units: 'us', fireName: 'the Henderson Fire', incidentUrl: 'https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire' }

const evac = (over: Partial<EvacuationOfficial>): EvacuationOfficial => ({
  state: 'none-listed',
  zones: [],
  checkedMs: NOW - 120_000,
  sourceUpdatedMs: NOW - 3_600_000,
  sourceUrl: 'https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer',
  caveat: 'No orders or warnings are listed at this point right now. That is not an all-clear: follow local officials.',
  ...over,
})
const fw = (over: Partial<FireWeatherOfficial> = {}): FireWeatherOfficial => ({
  state: 'none',
  alerts: [],
  checkedMs: NOW,
  archived: false,
  credit: 'National Weather Service',
  sourceUrl: 'https://api.weather.gov/alerts',
  caveat: 'A fire weather alert is a weather warning, not an evacuation order. Follow local officials.',
  ...over,
})
const info = (e: Partial<EvacuationOfficial>, f: Partial<FireWeatherOfficial> = {}): OfficialInfo => ({
  evacuation: evac(e),
  fireWeather: fw(f),
  calfire: { state: 'available', acres: 1520, percentContained: 65, updatedMs: NOW - 7_200_000, url: 'https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire' },
})
const zone = (over: Partial<OfficialZone>): OfficialZone => ({
  id: 'ORC-1',
  status: 'Evacuation Order',
  group: 'order',
  issuer: 'Orange County',
  distanceKm: 0,
  outsideAnalysisArea: false,
  name: 'Zone 1',
  message: null,
  ...over,
})
const alert = (over: Partial<OfficialAlert>): OfficialAlert => ({
  id: 'a1',
  event: 'Red Flag Warning',
  senderName: 'NWS San Diego CA',
  headline: 'Red Flag Warning issued October 18',
  url: 'https://api.weather.gov/alerts/a1',
  archived: false,
  phase: 'active',
  timeText: 'until Oct 20, 18:00 PDT',
  coversReportedLocation: true,
  nearestKm: 0,
  ugcs: ['CAZ243'],
  bounds: null,
  ...over,
})

describe('officialBlock: the evacuation line is always present and honest', () => {
  it('listed zones keep their wording, issuer and own time; a neighbouring fire is named as such', () => {
    const b = officialBlock(info({ state: 'listed', zones: [zone({ updatedMs: NOW - 3_600_000 }), zone({ id: 'W', status: 'Evacuation Warning', group: 'warning', listedMs: NOW - 600_000 }), zone({ id: 'X' })] }), CTX)
    expect(b.evacuation.map((l) => [l.text, l.official, l.tone])).toEqual([
      ['Evacuation Order', true, 'order'],
      ['Evacuation Warning', true, 'warning'],
    ])
    expect(b.evacuation[0].sub).toBe(`Orange County · updated ${at(NOW - 3_600_000)}`)
    expect(b.evacuation[1].sub).toBe(`Orange County · issuer time not given; listed by Cal OES ${at(NOW - 600_000)}`)
    expect(b.moreZones).toBe(1)
    const far = officialBlock(info({ state: 'listed', zones: [zone({ outsideAnalysisArea: true, distanceKm: 27 })] }), CTX)
    expect(far.evacuation[0].sub).toBe('Orange County · issuer time not given · 17 mi from the Henderson Fire; Cal OES does not say which fire this is for')
    // phones keep the issuer, the source's own time and the caveat (integration: standing rule for official items)
    expect(b.evacuation[0].subCompact).toBe(`Orange County · updated ${at(NOW - 3_600_000)}`)
    expect(b.evacuation[1].subCompact).toBe(`Orange County · listed by Cal OES ${at(NOW - 600_000)}`)
    expect(far.evacuation[0].subCompact).toBe('Orange County · 17 mi from the Henderson Fire; Cal OES does not say which fire this is for')
  })
  it('none listed only where checked, with the check time, and never an all-clear', () => {
    const b = officialBlock(info({}), CTX)
    expect(b.evacuation).toEqual([expect.objectContaining({ text: 'No evacuation order or warning listed here', official: true, tone: 'quiet' })])
    expect(b.evacuation[0].sub).toBe('Cal OES, checked 2 min ago · not an all-clear')
    // on phones too
    expect(b.evacuation[0].subCompact).toBe('Cal OES · not an all-clear')
  })
  it('not checked, past date, unavailable and loading are said as such', () => {
    const nc = officialBlock(info({ state: 'not-checked', checkedMs: null, reason: 'Not checked here: Fire-3d reads Cal OES zones only near the selected fire and the selected point.' }), CTX)
    expect(nc.evacuation[0]).toMatchObject({ text: 'Evacuation zones: not checked here', official: false, sub: 'Fire-3d reads Cal OES zones only near the selected fire and the selected point.' })
    expect(officialBlock(info({ state: 'past-date' }), CTX).evacuation[0]).toMatchObject({ text: 'Evacuation orders: not shown for past dates', official: false, sub: null })
    expect(officialBlock(info({ state: 'unavailable', reason: 'Cal OES did not answer.' }), CTX).evacuation[0]).toMatchObject({ text: 'Evacuation zones: unavailable right now', sub: 'Cal OES did not answer.' })
    expect(officialBlock(info({ state: 'loading' }), CTX).evacuation[0]).toMatchObject({ text: 'Checking official evacuation zones…', tone: 'loading' })
    expect(officialBlock(info({ state: 'listed', zones: [] }), CTX).evacuation).toHaveLength(1) // never empty
  })
  it('always says "Follow local officials" with the CAL FIRE page and Cal OES (https only)', () => {
    const b = officialBlock(info({ links: [{ label: 'Orange County evacuation map', url: 'https://ocgis.example/evac' }, { label: 'bad', url: 'http://insecure.example' }] }), CTX)
    expect(b.follow).toBe('Follow local officials.')
    expect(b.links.map((l) => l.label)).toEqual(['CAL FIRE', 'Cal OES', 'Orange County evacuation map'])
    const noCalfire = officialBlock({ ...info({}), calfire: { state: 'unavailable' } }, { ...CTX, incidentUrl: null })
    expect(noCalfire.links.map((l) => l.label)).toEqual(['Cal OES'])
  })
})

describe('NWS fire weather in the card', () => {
  it('a line only while an alert is in effect or upcoming here, verbatim, with sender, time and archive label', () => {
    expect(officialBlock(info({}, { state: 'none' }), CTX).fireWeather).toEqual([])
    const b = officialBlock(info({}, { state: 'active', alerts: [alert({}), alert({ id: 'old', phase: 'expired', timeText: 'Expired Oct 17, 18:00 PDT' })] }), CTX)
    expect(b.fireWeather).toHaveLength(1)
    expect(b.fireWeather[0]).toMatchObject({ text: 'Fire weather alert here: Red Flag Warning until Oct 20, 18:00 PDT', official: true, url: 'https://api.weather.gov/alerts/a1' })
    expect(b.fireWeather[0].sub).toBe('NWS San Diego CA · a weather warning, not an evacuation order')
    // the sender and the caveat stay on a phone's short card too (as does "not an all-clear" on the evacuation line)
    expect(b.fireWeather[0].subCompact).toBe('NWS San Diego CA · a weather warning, not an evacuation order')
    expect(b.evacuation[0].subCompact).toBe('Cal OES · not an all-clear')
    const longSender = officialBlock(info({}, { state: 'active', alerts: [alert({ senderName: 'National Weather Service Los Angeles/Oxnard CA' })] }), CTX)
    expect(longSender.fireWeather[0].sub).toMatch(/^NWS Los Angeles\/Oxnard CA · /)
    const arch = officialBlock(info({}, { state: 'active', archived: true, alerts: [alert({ archived: true, phase: 'upcoming', timeText: 'from Jan 7, 04:00 PST' })] }), CTX)
    expect(arch.fireWeather[0].text).toBe('Fire weather alert starting here: Red Flag Warning from Jan 7, 04:00 PST')
    expect(arch.fireWeather[0].sub).toBe('NWS San Diego CA · archived copy · a weather warning, not an evacuation order')
    expect(arch.fireWeather[0].subCompact).toBe(arch.fireWeather[0].sub)
  })
  it('the dryness reason may cite only an alert in effect', () => {
    expect(officialFireWeatherNote(fw({ state: 'active', alerts: [alert({})] }))).toBe('NWS Red Flag Warning in effect')
    expect(officialFireWeatherNote(fw({ state: 'active', alerts: [alert({ phase: 'upcoming' })] }))).toBeNull()
    expect(officialFireWeatherNote(fw({ state: 'none' }))).toBeNull()
    expect(alertsInEffect(fw({ state: 'past-date', alerts: [alert({})] }))).toEqual([])
  })
})

describe('helpers', () => {
  it('drops the follow sentence from caveats (it is said once)', () => {
    expect(withoutFollow('That is not an all-clear: follow local officials.')).toBe('That is not an all-clear.')
    expect(withoutFollow('Follow local officials.')).toBeNull()
    expect(withoutFollow('A weather warning. Follow local officials.')).toBe('A weather warning.')
  })
  it('CAL FIRE record in one line', () => {
    expect(calfireLine({ state: 'available', acres: 14021, percentContained: 100, updatedMs: NOW }, 'us')).toBe(`CAL FIRE: 14,021 acres, 100% contained · updated ${at(NOW)}`)
    expect(calfireLine({ state: 'loading' }, 'us')).toBeNull()
  })
})
