import { describe, expect, it } from 'vitest'
import type { EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialInfo, OfficialZone } from '../official/hooks'
import { fmtAt, timeFmt } from '../lib/time'
import { NOT_FOUND_TEXT } from '../extras/format'
import { LOCAL_ARCHIVE_KERN_FRW, LOCAL_ARCHIVE_PENDING_BLACK_COVE, LOCAL_ARCHIVE_SHERIDAN_WY, LOCAL_LIVE_LA_CEM, LOCAL_LIVE_NONE_RENO } from '../official/__fixtures__/localAlerts'
import { localAlertsState } from '../official/localAlerts'

const ok = <T,>(data: T | null, extra: { loading?: boolean; error?: string | null } = {}) => ({ data, loading: false, error: null, ...extra })
import { alertsInEffect, calfireLine, officialBlock, officialFireWeatherNote, withoutFollow, type OfficialContext } from './official'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const LA24 = timeFmt('America/Los_Angeles', '24h')
const at = (ms: number) => fmtAt(ms, LA24, { zone: true })
const CTX: OfficialContext = { tf: LA24, nowMs: NOW, units: 'us', fireName: 'the Henderson Fire', incidentUrl: 'https://www.fire.ca.gov/incidents/2026/10/15/henderson-fire' }

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
    expect(b.evacuation[0].subCompact).toBe('Cal OES, checked 2 min ago · not an all-clear')
  })
  it('not checked, past date, unavailable and loading are said as such', () => {
    const nc = officialBlock(info({ state: 'not-checked', checkedMs: null, reason: 'Not checked here: Fire-3d reads Cal OES zones only near the selected fire and the selected point.' }), CTX)
    expect(nc.evacuation[0]).toMatchObject({ text: 'Evacuation zones: not checked here', official: false, sub: 'Fire-3d reads Cal OES zones only near the selected fire and the selected point.' })
    expect(officialBlock(info({ state: 'past-date' }), CTX).evacuation[0]).toMatchObject({ text: 'Evacuation orders: not shown for past dates', official: false, sub: null })
    expect(officialBlock(info({ state: 'unavailable', reason: 'Cal OES did not answer.' }), CTX).evacuation[0]).toMatchObject({ text: 'Evacuation zones: unavailable right now', sub: 'Cal OES did not answer.' })
    expect(officialBlock(info({ state: 'loading' }), CTX).evacuation[0]).toMatchObject({ text: 'Checking official evacuation zones…', tone: 'loading' })
    expect(officialBlock(info({ state: 'listed', zones: [] }), CTX).evacuation).toHaveLength(1) // never empty
  })
  it('a state without an official evacuation feed says so, never "none" (CONTRACT §14.8.5, §14.14)', () => {
    const na = officialBlock(info({ state: 'not-available', checkedMs: null, reason: 'Not available in this state (Nevada). Follow local officials.' }), CTX)
    expect(na.evacuation).toHaveLength(1)
    expect(na.evacuation[0]).toMatchObject({ text: 'Evacuation zones: not available in this state', sub: 'Not available in this state (Nevada).', official: false, tone: 'unknown' })
  })
  it("words times in the given zone and clock (CONTRACT §14.9.6)", () => {
    const den = officialBlock(info({ state: 'listed', zones: [zone({ updatedMs: Date.UTC(2026, 9, 18, 14, 5) })] }), { ...CTX, tf: timeFmt('America/Denver', '12h') })
    expect(den.evacuation[0].sub).toContain('updated Oct 18, 8:05 AM MDT')
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
  it('the alert lines while one is in effect or upcoming here, verbatim, with sender, time and archive label; else the NWS status (brief 3)', () => {
    expect(officialBlock(info({}, { state: 'none' }), CTX).fireWeather).toEqual([
      { key: 'nws-none', text: 'Fire weather alerts (NWS): checked, none in effect here', sub: 'Not an all-clear', subCompact: 'Not an all-clear', official: true, tone: 'quiet', url: null },
    ])
    const b = officialBlock(info({}, { state: 'active', alerts: [alert({}), alert({ id: 'old', phase: 'expired', timeText: 'Expired Oct 17, 18:00 PDT' })] }), CTX)
    expect(b.fireWeather).toHaveLength(1)
    expect(b.fireWeather[0]).toMatchObject({ text: 'Fire weather alert here: Red Flag Warning until Oct 20, 18:00 PDT', official: true, url: 'https://api.weather.gov/alerts/a1' })
    expect(b.fireWeather[0].sub).toBe('NWS San Diego CA · a weather warning, not an evacuation order')
    // the sender and the caveat stay on a phone's short card too (as does "not an all-clear" on the evacuation line)
    expect(b.fireWeather[0].subCompact).toBe('NWS San Diego CA · a weather warning, not an evacuation order')
    expect(b.evacuation[0].subCompact).toBe('Cal OES, checked 2 min ago · not an all-clear')
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
    expect(calfireLine({ state: 'available', acres: 14021, percentContained: 100, updatedMs: NOW }, 'us', LA24)).toBe(`CAL FIRE: 14,021 acres, 100% contained · updated ${at(NOW)}`)
    expect(calfireLine({ state: 'loading' }, 'us')).toBeNull()
  })
})

// ---- brief 3: Oregon OEM and "not available in this state" (CONTRACT §14.8.5, §14.14) ---------------------------
describe('evacuation lines outside California (brief 3)', () => {
  const oem = { id: 'or_oem_evacuations', aggregator: 'Oregon OEM', credit: 'Oregon Department of Emergency Management', url: 'https://www.arcgis.com/home/item.html?id=dd2bee51e3004dc4b1004df34fbd9e29', homeState: 'OR', answered: true, checkedMs: NOW - 120_000, updatedMs: NOW - 3_600_000, reason: null }
  it('Oregon, none listed: "No evacuation order or warning listed here · Oregon OEM, checked … · not an all-clear", with the OEM link and no Cal OES', () => {
    const b = officialBlock({ ...info({ checkedBy: 'Oregon OEM', sources: [oem], sourceUrl: oem.url }), calfire: { state: 'unavailable' } }, { ...CTX, incidentUrl: null })
    expect(b.evacuation[0]).toMatchObject({ text: 'No evacuation order or warning listed here', sub: 'Oregon OEM, checked 2 min ago · not an all-clear', subCompact: 'Oregon OEM, checked 2 min ago · not an all-clear', official: true })
    expect(b.links).toEqual([{ label: 'Oregon OEM', url: oem.url }])
    expect(JSON.stringify(b)).not.toMatch(/Cal OES/)
  })
  it('not available in this state: the short form with the state, no source link', () => {
    const b = officialBlock({ ...info({ state: 'not-available', checkedMs: null, sourceUrl: null, reason: 'Not available in this state (Nevada)', notAvailableIn: ['Nevada'], sources: [] }), calfire: { state: 'unavailable' } }, { ...CTX, incidentUrl: null })
    expect(b.evacuation).toEqual([
      { key: 'evac-not-available', text: 'Evacuation zones: not available in this state', sub: 'Not available in this state (Nevada)', subCompact: null, official: false, tone: 'unknown', url: null },
    ])
    expect(b.links).toEqual([])
    expect(b.follow).toBe('Follow local officials.')
    expect(JSON.stringify(b)).not.toMatch(/Cal OES|none listed|safe/i)
  })
  it('an Oregon zone: OEM level definition, "Oregon OEM level", the state-layer time in Pacific time, the fire name as recorded', () => {
    const z = zone({
      id: 'or1',
      status: 'Level 3: GO NOW – Leave Immediately!',
      issuer: 'Jackson County',
      listedMs: Date.UTC(2026, 7, 14, 0, 20),
      aggregator: 'Oregon OEM',
      listedPhrase: 'added to the Oregon state layer',
      verbatim: false,
      incidentNote: 'Fire name as recorded by Oregon OEM: Fielders Mountain; a name match is not proof it is this fire',
      hazardNote: null,
    })
    const b = officialBlock(info({ state: 'listed', zones: [z], checkedBy: 'Oregon OEM', sources: [oem] }), { ...CTX, tf: timeFmt('America/Los_Angeles', '12h') })
    expect(b.evacuation[0].text).toBe('Level 3: GO NOW – Leave Immediately!')
    expect(b.evacuation[0].sub).toBe(
      'Jackson County · Oregon OEM level; definition by Oregon OEM · issuer time not given; added to the Oregon state layer Aug 13, 5:20 PM PDT · Fire name as recorded by Oregon OEM: Fielders Mountain; a name match is not proof it is this fire',
    )
    expect(b.evacuation[0].subCompact).toBe('Jackson County · Oregon OEM level; definition by Oregon OEM · added to the Oregon state layer Aug 13, 5:20 PM PDT')
    const far = officialBlock(info({ state: 'listed', zones: [{ ...z, outsideAnalysisArea: true, distanceKm: 12 }], sources: [oem] }), CTX)
    expect(far.evacuation[0].sub).toContain('Oregon OEM does not say which fire this is for')
  })
})

describe('the fire record link and line (brief 3, CONTRACT §14.5)', () => {
  it('a NIFC WFIGS record is linked and worded from its issuer, never as CAL FIRE', () => {
    const rec = { state: 'available' as const, acres: 9450, percentContained: 100, updatedMs: Date.UTC(2024, 7, 2, 15, 30), url: 'https://nifc.example/horse-gulch', source: 'wfigs' as const, issuer: 'USFS (USDA Forest Service) via NIFC WFIGS', linkLabel: 'NIFC WFIGS' }
    const b = officialBlock({ ...info({ state: 'not-available', checkedMs: null, sourceUrl: null, reason: 'Not available in this state (Montana)', notAvailableIn: ['Montana'], sources: [] }), calfire: rec }, { ...CTX, incidentUrl: null })
    expect(b.links).toEqual([{ label: 'NIFC WFIGS', url: 'https://nifc.example/horse-gulch' }])
    expect(calfireLine(rec, 'us', timeFmt('America/Denver', '24h'))).toBe('USFS (USDA Forest Service) via NIFC WFIGS: 9,450 acres, 100% contained · updated Aug 2, 09:30 MDT')
    expect(JSON.stringify(b)).not.toMatch(/CAL FIRE|Cal OES/)
  })
})

describe('NWS status and local officials\' alerts in the card (brief 3, CONTRACT §14.6, §14.7)', () => {
  const LA12 = timeFmt('America/Los_Angeles', '12h')
  const na = info({ state: 'not-available', checkedMs: null, sourceUrl: null, reason: 'Not available in this state (Nevada)', notAvailableIn: ['Nevada'], sources: [] })
  it('NWS not checked here (the answer does not cover the point\'s state)', () => {
    const b = officialBlock({ ...na, fireWeather: fw({ state: 'unavailable', reasonCode: 'not_checked', reason: 'Fire-3d did not check NWS fire weather alerts in Nevada for this answer.' }) }, CTX)
    expect(b.fireWeather[0]).toMatchObject({ key: 'nws-unchecked', text: 'Fire weather alerts (NWS): not checked here', official: false })
    expect(JSON.stringify(b)).not.toMatch(/lower 48/)
  })
  it('a live relayed alert and an archived one with the FEMA notice; every local line links', () => {
    const live = officialBlock({ ...na, local: localAlertsState(ok(LOCAL_LIVE_LA_CEM)) }, { ...CTX, tf: LA12 })
    const l = live.fireWeather.find((x) => x.key.startsWith('local-'))!
    expect(l).toMatchObject({ text: 'Alert, issuer not named: "Alert from AlertLACounty"', official: true, tone: 'warning', url: 'https://api.weather.gov/alerts/v2-3.13.8-1556392-1792113838542', urlLabel: 'source record (NWS)' })
    // review R1: where the message's area lies (this one was matched by county)
    expect(l.sub).toBe('Civil Emergency Message · sent Oct 15, 6:23 PM PDT · relayed by the National Weather Service · matched by county, not by an exact area · may be about another fire')
    const arch = officialBlock({ ...na, local: localAlertsState(ok(LOCAL_ARCHIVE_KERN_FRW)) }, { ...CTX, tf: LA12 })
    const a = arch.fireWeather.find((x) => x.key.startsWith('local-'))!
    expect(a.text).toBe('Archived alert from Kern County OES: "Kern County Sheriff: Cyrus Fire updated to an Evacuation Order. Leave NOW."')
    expect(a.sub).toMatch(/· FEMA archive · (area [^·]+|area covers [^·]+)( · may be about another fire)? · FEMA IPAWS archive via OpenFEMA: This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA$/)
    expect(a.urlLabel).toBe('source record (FEMA archive)')
    for (const b of [live, arch, officialBlock({ ...na, local: localAlertsState(ok(LOCAL_ARCHIVE_SHERIDAN_WY)) }, CTX)])
      for (const line of b.fireWeather.filter((x) => x.key.startsWith('local-') && !['local-none', 'local-unchecked', 'local-unavailable', 'local-loading', 'local-pending', 'local-more'].includes(x.key))) {
        expect(line.url).toMatch(/^https:\/\//)
        // review R1: every message line says where its area lies, on phones too
        expect(line.sub).toMatch(/area covers|area [\d.]+ (mi|km) from|matched by county/)
        expect(line.subCompact).toMatch(/area covers|area [\d.]+ (mi|km) from|matched by county/)
      }
  })
  it('none here: one status line with the standing caveat; HTTP 404: "not checked", never "none"', () => {
    const none = officialBlock({ ...na, local: localAlertsState(ok(LOCAL_LIVE_NONE_RENO)) }, CTX)
    expect(none.fireWeather.find((x) => x.key === 'local-none')).toMatchObject({ text: "Local officials' alerts relayed by NWS: none here · not an all-clear", official: true, tone: 'quiet' })
    expect(none.fireWeather.find((x) => x.key === 'local-none')!.sub).toMatch(/^Fire-3d lists only the local alerts the National Weather Service relays/)
    const missing = officialBlock({ ...na, local: localAlertsState(ok(null, { error: NOT_FOUND_TEXT })) }, CTX)
    expect(missing.fireWeather.find((x) => x.key.startsWith('local-'))).toMatchObject({ key: 'local-unchecked', text: "Local officials' alerts: not checked" })
    expect(JSON.stringify(missing.fireWeather)).not.toMatch(/none here/)
    const pending = officialBlock({ ...na, local: localAlertsState(ok(LOCAL_ARCHIVE_PENDING_BLACK_COVE)) }, CTX)
    expect(pending.fireWeather.find((x) => x.key.startsWith('local-'))!.text).toBe("Local officials' alerts: not checked")
  })
  it('NWS first, then the local lines, in the existing fireWeather array (no new block field)', () => {
    const b = officialBlock({ ...info({}, { state: 'none' }), local: localAlertsState(ok(LOCAL_LIVE_LA_CEM)) }, CTX)
    expect(b.fireWeather.map((x) => x.key.split('-')[0])).toEqual(['nws', 'local'])
  })
})
