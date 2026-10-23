// Local officials' messages relayed by NWS and archived by FEMA (brief 3, CONTRACT §14.7).
import { describe, expect, it } from 'vitest'
import { NOT_FOUND_TEXT } from '../extras/format'
import { timeFmt } from '../lib/time'
import { LOCAL_ARCHIVE_EATON, LOCAL_ARCHIVE_HORSE_GULCH, LOCAL_ARCHIVE_KERN_FRW, LOCAL_ARCHIVE_PENDING_BLACK_COVE, LOCAL_ARCHIVE_SHERIDAN_WY, LOCAL_LIVE_LA_CEM, LOCAL_LIVE_NONE_RENO } from './__fixtures__/localAlerts'
import {
  answeredChannelsText,
  LOCAL_LOOKUP_FAILED_REASON,
  LOCAL_LOWER48_REASON,
  LOCAL_PLACE_NOTE,
  localAlertCredits,
  localAlertFeedItems,
  localAlertLink,
  localAlertPlace,
  localAlertsAt,
  localAlertsAtPoint,
  localAlertsAtSelectedPoint,
  localAlertsForPointState,
  localAlertsState,
  localAlertText,
  localPhaseAt,
  localPhaseText,
  OPENFEMA_NOTICE,
  sentText,
} from './localAlerts'
import { localAlertLines } from '../location/official'
import type { LocalAlert } from './types'

const ok = <T,>(data: T | null, extra: { loading?: boolean; error?: string | null } = {}) => ({ data, loading: false, error: null, ...extra })
const LA12 = timeFmt('America/Los_Angeles', '12h')

describe('local alerts state', () => {
  it('a live relayed message: issuer not named for a platform sender, verbatim text, its own time and the NWS record link', () => {
    const l = localAlertsState(ok(LOCAL_LIVE_LA_CEM))
    expect(l.state).toBe('listed')
    const a = l.alerts[0]
    expect(a).toMatchObject({ archived: false, issuer: null, lead: 'Alert, issuer not named', event: 'Civil Emergency Message', phase: 'active', timeZone: 'America/Los_Angeles' })
    expect(a.text).toBe('Alert from AlertLACounty') // the headline (no WEA text in this message), verbatim
    expect(a.link).toEqual({ url: 'https://api.weather.gov/alerts/v2-3.13.8-1556392-1792113838542', label: 'source record (NWS)' })
    expect(a.full.find((x) => x.label === 'Message')?.text).toMatch(/^This is an emergency message from the County of Los Angeles\./)
    expect(sentText(a, LA12)).toBe('sent Oct 15, 6:23 PM PDT')
    expect(l.archive).toBe(false)
    expect(l.credits).toEqual(["National Weather Service (relayed local officials' messages)"])
    expect(l.caveats[0]).toMatch(/^Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed/)
  })

  it("an archived message: 'Archived alert from …', the FEMA record link, the archive credit and FEMA's notice", () => {
    const l = localAlertsState(ok(LOCAL_ARCHIVE_KERN_FRW))
    const a = l.alerts[0]
    expect(a).toMatchObject({ archived: true, issuer: 'Kern County OES', lead: 'Archived alert from Kern County OES', event: 'Fire Warning' })
    expect(a.text).toBe('Kern County Sheriff: Cyrus Fire updated to an Evacuation Order. Leave NOW.')
    expect(a.link.label).toBe('source record (FEMA archive)')
    expect(a.link.url).toMatch(/^https:\/\/www\.fema\.gov\/api\/open\/v1\/IpawsArchivedAlerts\?\$filter=identifier%20eq%20/)
    expect(l.archive).toBe(true)
    expect(l.credits).toContain('FEMA IPAWS archive via OpenFEMA')
    expect(l.caveats.join(' ')).toContain(OPENFEMA_NOTICE)
    const feed = localAlertFeedItems(l, { manifest: null, tf: LA12 })
    expect(feed[0]).toMatchObject({ topic: 'local-alert', kind: 'official', archived: true, source: 'Kern County OES (FEMA IPAWS archive via OpenFEMA)', url: a.link.url })
    expect(feed[0].title).toBe('Archived alert from Kern County OES: "Kern County Sheriff: Cyrus Fire updated to an Evacuation Order. Leave NOW."')
    expect(feed[0].notes?.join(' ')).toContain(`FEMA IPAWS archive via OpenFEMA: ${OPENFEMA_NOTICE}.`)
  })

  it("a county match says it is not tied to this fire; times in the message's own zone", () => {
    // decided from its own times (review round 4): sent 93 s after the answer's time, so not current there; ended from
    // its own expiry (the fixture's hand-set "ended" is only the backend's hint)
    const msg = LOCAL_ARCHIVE_SHERIDAN_WY.alerts[0]
    expect(localAlertsState(ok(LOCAL_ARCHIVE_SHERIDAN_WY)).alerts[0].phase).toBe('upcoming')
    const l = localAlertsState(ok(LOCAL_ARCHIVE_SHERIDAN_WY), { refMs: msg.expires_ms! })
    expect(l.alerts[0]).toMatchObject({ match: 'county', coversReportedLocation: null, timeZone: 'America/Denver', phase: 'expired' })
    expect(sentText(l.alerts[0], LA12)).toMatch(/ M[DS]T$/)
    expect(localAlertFeedItems(l, { manifest: null, tf: LA12 })[0].notes?.join(' ')).toMatch(/Matched by county/)
  })

  it('none relayed: "none" only where a channel answered; a pending archive alone is not a check', () => {
    expect(localAlertsState(ok(LOCAL_LIVE_NONE_RENO)).state).toBe('none')
    const p = localAlertsState(ok(LOCAL_ARCHIVE_PENDING_BLACK_COVE))
    expect(p).toMatchObject({ state: 'not-checked', archivePending: true, archive: true })
    expect(p.reason).toMatch(/NWS keeps about 7 days of alerts\. FEMA's archive is being fetched; ask again in a minute\./)
  })

  it('an older backend (HTTP 404) or a failure is "not checked", never "none"', () => {
    expect(localAlertsState(ok(null, { error: NOT_FOUND_TEXT }))).toMatchObject({ state: 'not-checked', alerts: [] })
    expect(localAlertsState(ok(null, { error: 'Could not reach the Fire-3d server.' }))).toMatchObject({ state: 'unavailable' })
    expect(localAlertsState(ok(null, { loading: true })).state).toBe('loading')
    expect(localAlertsState(null, { demo: true }).state).toBe('not-checked')
  })

  it("every message has a link: the issuer's own web link when present, else its record; none without one", () => {
    const base = LOCAL_LIVE_LA_CEM.alerts[0]
    expect(localAlertLink({ ...base, web: 'https://alertla.org/x' })).toEqual({ url: 'https://alertla.org/x', label: "issuer's link" })
    expect(localAlertLink({ ...base, web: 'http://insecure.example' })?.label).toBe('source record (NWS)')
    expect(localAlertLink({ ...base, web: null, source_url: 'http://x' })).toBeNull()
    const noLink: LocalAlert = { ...base, id: 'x', web: null, source_url: '' }
    expect(localAlertsState(ok({ ...LOCAL_LIVE_LA_CEM, alerts: [noLink] })).state).toBe('none') // dropped, never shown linkless
    expect(localAlertText({ wea_text: null, headline: null, description: 'x'.repeat(400), event: 'Fire Warning' })).toHaveLength(220)
  })
})

describe('review R1: where each message applies, most relevant first (Eaton, replay 2025-01-09 03:40 UTC)', () => {
  const eaton = () => localAlertsState(ok(LOCAL_ARCHIVE_EATON))
  // the backend lists the 3 newest first: LA City's Sunset Fire and Runyon Canyon messages, 26-30 km away
  it('the backend order puts other fires first; Fire-3d lists the nearest in-effect message first', () => {
    expect(LOCAL_ARCHIVE_EATON.alerts.slice(0, 3).map((a) => a.nearest_km)).toEqual([29.5, 26.2, 26.5])
    const l = eaton()
    expect(l.alerts.map((a) => a.nearestKm)).toEqual([2.7, 2.7, 3.1, 12.7, 26.2, 26.5, 29.5, 8.5])
    expect(l.alerts[0]).toMatchObject({ id: 'test-lac-951391-1736317607330', lead: 'Archived alert, issuer not named', phase: 'active' }) // the newer of the two 2.7 km orders
    expect(l.alerts[0].text).toBe('LACo OEM: Fast moving wildfire. EVACUATION ORDER. LEAVE NOW. Alertla.org')
    expect(l.alerts.at(-1)).toMatchObject({ phase: 'expired', issuer: '201723,La Canada Flintridge - Citizen Alert,City of La Canada Flintridge' }) // ended last
    // a message whose area covers the reported location comes before a nearer-sent one that does not
    const covering = { ...LOCAL_ARCHIVE_EATON.alerts[0], id: 'covers', covers_reported_location: true, nearest_km: 0, sent_ms: 1 }
    expect(localAlertsState(ok({ ...LOCAL_ARCHIVE_EATON, alerts: [...LOCAL_ARCHIVE_EATON.alerts, covering] })).alerts[0].id).toBe('covers')
  })

  it('every line says where the area lies (Official now, the feed, the card), in the viewer\'s units', () => {
    const l = eaton()
    const places = l.alerts.map((a) => localAlertPlace(a, { metric: false }))
    expect(places[0]).toBe("area 1.7 mi from the fire's reported location · may be about another fire")
    expect(places[6]).toBe("area 18 mi from the fire's reported location · may be about another fire") // the Sunset Fire message
    expect(localAlertPlace(l.alerts[0], { metric: true })).toBe("area 2.7 km from the fire's reported location · may be about another fire")
    expect(localAlertPlace({ match: 'polygon', where: { from: 'fire', covers: true, km: 0 } }, { metric: false })).toBe("area covers the fire's reported location")
    expect(localAlertPlace({ match: 'county', where: { from: 'fire', covers: null, km: null } }, { metric: false })).toBe('matched by county, not by an exact area · may be about another fire')
    // the feed: every row carries the phrase as its own `place` (shown unclamped; review round 2, N1), and the note
    // explains it
    const feed = localAlertFeedItems(l, { manifest: null, tf: LA12, metric: false })
    expect(feed).toHaveLength(8)
    feed.forEach((f, i) => expect(f.place).toBe(places[i]))
    expect(feed[0].notes).toContain(LOCAL_PLACE_NOTE)
    // the card (fire's list, e.g. the overview card of the open fire): every local-alert line has the phrase, phones too
    const lines = localAlertLines(l, LA12, 3, { units: 'us', fireOpen: true }).filter((x) => x.key.startsWith('local-') && x.url)
    expect(lines).toHaveLength(3)
    for (const x of lines) {
      expect(x.sub).toMatch(/area [\d.]+ mi from the fire's reported location · may be about another fire/)
      expect(x.subCompact).toMatch(/area [\d.]+ mi from the fire's reported location/)
      expect(x.url).toMatch(/^https:\/\//)
    }
  })

  it('at a point inside the fire\'s area, the card measures from the point and keeps only the messages that reach it', () => {
    // a point inside the area of the newest 2.7 km LACo OEM order; the 3.1 km order's area is 0.9 km away (kept:
    // within about the live card's box); the other 6 are elsewhere
    const p = localAlertsAtPoint(eaton(), -118.0426, 34.1705, { countyFips: '06037' })
    expect(p.state).toBe('listed')
    expect(p.alerts.map((a) => a.id)).toEqual(['test-lac-951391-1736317607330', 'test-lac-951496-1736320054083'])
    expect(p.alerts.map((a) => a.where)).toEqual([
      { from: 'point', covers: true, km: 0 },
      { from: 'point', covers: false, km: 0.9 },
    ])
    expect(p.elsewhere).toBe(6)
    const lines = localAlertLines(p, LA12, 3, { units: 'us', fireOpen: true })
    expect(lines[0].sub).toContain('area covers this point')
    expect(lines[0].sub).not.toContain('another fire')
    expect(lines[1].sub).toContain('area 0.6 mi from this point · may be about another fire')
    expect(lines[1].subCompact).toContain('area 0.6 mi from this point')
    expect(lines.at(-1)?.text).toBe("6 of the fire's local alerts are for other places in its area (see Updates).")
    // far from every message (the reported location): checked, none here, never an all-clear
    const none = localAlertsAtPoint(eaton(), -118.069155, 34.203483, { countyFips: '06037' })
    expect(none).toMatchObject({ state: 'none', alerts: [], elsewhere: 8 })
    const noneLine = localAlertLines(none, LA12)[0]
    // a replay older than NWS keeps: only FEMA's archive was read, so the line names it, not NWS (review UX-m3)
    expect(noneLine.text).toBe("Local officials' alerts (FEMA archive): none here · not an all-clear")
    expect(noneLine.sub).toMatch(/^8 of the fire's local alerts are for other places in its area \(see Updates\)\. Fire-3d lists only/)
  })

  it('a county match at a point: kept in the point\'s county (or while the county is unknown), measured as such', () => {
    const wy = localAlertsState(ok(LOCAL_ARCHIVE_SHERIDAN_WY))
    const code = wy.alerts[0].sameCodes[0]
    expect(localAlertsAtPoint(wy, -106.9, 44.8, { countyFips: code.slice(-5) }).alerts).toHaveLength(1)
    expect(localAlertsAtPoint(wy, -106.9, 44.8, { countyFips: null }).alerts).toHaveLength(1)
    expect(code).toBe('056033') // Sheridan County, WY
    expect(localAlertsAtPoint(wy, -106.9, 44.8, { countyFips: '56019' }).state).toBe('none') // Johnson County: another county
    const a = localAlertsAtPoint(wy, -106.9, 44.8).alerts[0]
    expect(localAlertPlace(a, { metric: false, fireOpen: false })).toBe('matched by county, not by an exact area')
    expect(localAlertPlace(a, { metric: false, fireOpen: true })).toBe('matched by county, not by an exact area · may be about another fire')
  })
})

describe('review round 2', () => {
  const eaton = () => localAlertsState(ok(LOCAL_ARCHIVE_EATON))

  it('N1: a collapsed feed row shows where the area lies: `place` (never clamped), not the end of the clamped detail', () => {
    const l = eaton()
    const feed = localAlertFeedItems(l, { manifest: null, tf: LA12, metric: false })
    // in time order (the feed's order) the newest is LA City's Sunset Fire warning, 18 mi away
    const newest = [...feed].sort((a, b) => b.tMs - a.tMs)[0]
    expect(newest.title).toMatch(/^Archived alert from 200277,LA City Public Alerts.*Sunset Fire/)
    expect(newest.place).toBe("area 18 mi from the fire's reported location · may be about another fire")
    for (const f of feed) {
      expect(f.place).toMatch(/^area (covers|[\d.]+ mi from) the fire's reported location|^matched by county/)
      expect(f.detail).not.toContain('reported location') // said once, in the unclamped line
    }
    expect(feed[0].detail).toBe('Evacuation Immediate · sent Jan 7, 2025 10:26 PM PST · FEMA archive')
    expect(localAlertFeedItems(l, { manifest: null, tf: LA12, metric: true })[0].place).toBe("area 2.7 km from the fire's reported location · may be about another fire")
  })

  // the live `?bbox=` answers at a point outside the lower 48 (recorded from the endpoint by the round-2 review):
  // NWS 'available' with no county and no message, because the national request covers the lower 48 only
  const outside = (bbox: [number, number, number, number]) => ({ ...LOCAL_LIVE_NONE_RENO, area_bbox: bbox, counties: [] })
  const TIJUANA = outside([-117.025, 32.505, -117.015, 32.515])
  const ANCHORAGE = outside([-149.905, 61.195, -149.895, 61.205])

  it('N2: outside the lower 48 local alerts are "not checked", never "none here"; loading while the state is looked up', () => {
    for (const [d, lon, lat] of [
      [TIJUANA, -117.02, 32.51],
      [ANCHORAGE, -149.9, 61.2],
    ] as const) {
      const live = localAlertsState(ok(d))
      expect(live.state).toBe('none') // the raw answer reads as a check
      const out = localAlertsAtSelectedPoint({ lon, lat, live, fire: null, countyFips: null, pointState: null })
      expect(out).toMatchObject({ state: 'not-checked', reason: LOCAL_LOWER48_REASON, alerts: [] })
      const lines = localAlertLines(out, LA12)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ text: "Local officials' alerts: not checked", sub: "Fire-3d checks local officials' alerts in the lower 48 states only.", official: false })
      expect(lines.map((x) => x.text).join(' ')).not.toMatch(/none here/)
      // the point's state not known yet: checking, never "none" for a moment
      const wait = localAlertsAtSelectedPoint({ lon, lat, live, fire: null, pointState: undefined })
      expect(wait.state).toBe('loading')
      expect(localAlertLines(wait, LA12)[0].text).toBe("Checking local officials' alerts…")
    }
    // the lookup failed: not checked, saying why
    expect(localAlertsAtSelectedPoint({ lon: -117.02, lat: 32.51, live: localAlertsState(ok(TIJUANA)), fire: null, pointState: null, lookupFailed: true })).toMatchObject({
      state: 'not-checked',
      reason: LOCAL_LOOKUP_FAILED_REASON,
    })
    // in the lower 48 (Reno, NV) "none here" stays, never an all-clear
    const reno = localAlertsAtSelectedPoint({ lon: -119.81, lat: 39.53, live: localAlertsState(ok(LOCAL_LIVE_NONE_RENO)), fire: null, countyFips: '32031', pointState: 'NV' })
    expect(reno.state).toBe('none')
    expect(localAlertLines(reno, LA12)[0].text).toBe("Local officials' alerts relayed by NWS: none here · not an all-clear")
    // a message listed there stays listed (its area reaches the point), whatever the lookup said
    const la = localAlertsState(ok(LOCAL_LIVE_LA_CEM))
    expect(localAlertsForPointState(la, { pointState: null }).state).toBe('listed')
    // not checked, unavailable and loading answers pass through as they are
    const failed = localAlertsState(ok(null, { error: 'Could not reach the Fire-3d server.' }))
    expect(localAlertsForPointState(failed, { pointState: undefined })).toBe(failed)
  })

  it("N2: the fire's own answer (a past time, the point in its area) waits for the point's state too", () => {
    const fire = eaton()
    expect(localAlertsAtSelectedPoint({ lon: -118.0426, lat: 34.1705, live: null, fire, countyFips: null, pointState: undefined }).state).toBe('loading')
    const p = localAlertsAtSelectedPoint({ lon: -118.0426, lat: 34.1705, live: null, fire, countyFips: '06037', pointState: 'CA' })
    expect(p).toMatchObject({ state: 'listed', elsewhere: 6 })
    expect(p.nearby).toBeUndefined()
    // a past time outside the fire's area: not checked
    expect(localAlertsAtSelectedPoint({ lon: -100, lat: 40, live: null, fire: null, pointState: 'NE' })).toMatchObject({
      state: 'not-checked',
      reason: "Past local alerts are checked for the selected fire's area only.",
    })
  })

  it("N3: the live box answer's left-out messages are 'nearby' (a neighbouring county), never the fire's", () => {
    // a point on the Los Angeles side of the Los Angeles / Ventura county line: the ±0.005° box touches both counties,
    // so the backend matches a Ventura County-wide message too
    const la = LOCAL_LIVE_LA_CEM.alerts[0]
    const ventura = { ...la, id: 'ventura-cem', area_desc: 'Ventura', same_codes: ['006111'], headline: 'Alert from VC Alert' }
    const box = { ...LOCAL_LIVE_LA_CEM, area_bbox: [-118.6385, 34.1665, -118.6285, 34.1765] as [number, number, number, number], counties: [{ fips: '06037', name: 'Los Angeles County', state: 'CA' }, { fips: '06111', name: 'Ventura County', state: 'CA' }] }
    const at = (alerts: (typeof la)[]) =>
      localAlertsAtSelectedPoint({ lon: -118.6335, lat: 34.1715, live: localAlertsState(ok({ ...box, alerts })), fire: null, countyFips: '06037', pointState: 'CA' })
    const onlyVentura = at([ventura])
    expect(onlyVentura).toMatchObject({ state: 'none', nearby: { county: 1, area: 0 } })
    expect(onlyVentura.elsewhere).toBeUndefined()
    const none = localAlertLines(onlyVentura, LA12)[0]
    expect(none.text).toBe("Local officials' alerts relayed by NWS: none here · not an all-clear")
    expect(none.sub).toMatch(/^1 nearby local alert is for a neighbouring county, not this point's county\. Fire-3d lists only/)
    expect(none.sub).not.toMatch(/fire's local alert|see Updates/)
    const both = at([la, ventura])
    expect(both.alerts.map((a) => a.id)).toEqual([la.id])
    const lines = localAlertLines(both, LA12, 3, { units: 'us', fireOpen: false })
    expect(lines.map((x) => x.text)).toEqual(['Alert, issuer not named: "Alert from AlertLACounty"', "1 nearby local alert is for a neighbouring county, not this point's county."])
    // an area match left out of a box answer is said as such
    const far = localAlertsAtPoint(
      localAlertsState(ok({ ...box, alerts: [{ ...la, id: 'poly', match: 'polygon', same_codes: [], polygon: { type: 'Polygon', coordinates: [[[-118.7, 34.3], [-118.69, 34.3], [-118.69, 34.31], [-118.7, 34.3]]] } }] })),
      -118.6335,
      34.1715,
      { countyFips: '06037', source: 'box' },
    )
    expect(far.nearby).toEqual({ county: 0, area: 1 })
    expect(localAlertLines(far, LA12)[0].sub).toMatch(/^1 nearby local alert is for an area that does not reach this point\./)
  })

  it('a backend answer outside the lower 48 (state_not_available) is "not checked", never "none" or an outage', () => {
    const outside = {
      ...LOCAL_LIVE_LA_CEM,
      status: 'unavailable' as const,
      reason_code: 'state_not_available',
      reason: "Fire-3d checks local officials' alerts in the lower 48 states only. Outside the United States: Fire-3d has no data here.",
      alerts: [],
      counties: [],
      channels: LOCAL_LIVE_LA_CEM.channels.map((c) => ({ ...c, status: 'not_checked' as const, retrieved_ms: null, reason: "Fire-3d checks local officials' alerts in the lower 48 states only." })),
    }
    const s = localAlertsState(ok(outside))
    expect(s.state).toBe('not-checked')
    const at = localAlertsAtSelectedPoint({ lon: -117.02, lat: 32.51, live: s, fire: null, pointState: null })
    const line = localAlertLines(at, LA12)[0]
    expect(line.text).toBe("Local officials' alerts: not checked")
    expect(line.sub).toMatch(/lower 48 states only\. Outside the United States/)
    expect(`${line.text} ${line.sub}`).not.toMatch(/none here|does not mean there were none/)
  })

  it('an unreachable service is "unavailable right now", and "that does not mean there were none" is said once (panel SR-m1)', () => {
    const down = {
      ...LOCAL_LIVE_LA_CEM,
      status: 'unavailable' as const,
      reason_code: 'upstream_error',
      reason: "The National Weather Service alert service could not be reached (no response). Local officials' alerts relayed by NWS are not shown; that does not mean there were none.",
      alerts: [],
      counties: [],
      channels: LOCAL_LIVE_LA_CEM.channels.map((c) => ({ ...c, status: 'unavailable' as const, retrieved_ms: null })),
    }
    const s = localAlertsState(ok(down))
    expect(s.state).toBe('unavailable')
    const line = localAlertLines(s, LA12)[0]
    expect(line.text).toBe("Local officials' alerts: unavailable right now")
    expect(`${line.text} ${line.sub}`.match(/does not mean there were none/gi)?.length).toBe(1)
  })

  it("N3 (integration): every message of the live box answer that reaches the point is listed, never '+N more (see Updates)'", () => {
    // Updates lists the open fire's messages, not the point's box answer, so the card must not send people there
    const la = LOCAL_LIVE_LA_CEM.alerts[0]
    const five = [0, 1, 2, 3, 4].map((i) => ({ ...la, id: `la-${i}`, headline: `Alert ${i}`, wea_text: null, sent_ms: (la.sent_ms ?? 0) + i * 60_000 }))
    const at = localAlertsAtSelectedPoint({ lon: -118.6335, lat: 34.1715, live: localAlertsState(ok({ ...LOCAL_LIVE_LA_CEM, alerts: five })), fire: null, countyFips: '06037', pointState: 'CA' })
    expect(at).toMatchObject({ state: 'listed', pointSource: 'box' })
    const lines = localAlertLines(at, LA12, 3, { units: 'us', fireOpen: false })
    expect(lines.filter((x) => x.key.startsWith('local-la-'))).toHaveLength(5)
    expect(lines.map((x) => `${x.text} ${x.sub ?? ''}`).join(' ')).not.toMatch(/see Updates/)
    // the fire's own answer keeps three lines and points to Updates for the rest (they are listed there)
    const fire = localAlertsAtSelectedPoint({ lon: -118.6335, lat: 34.1715, live: null, fire: localAlertsState(ok({ ...LOCAL_LIVE_LA_CEM, alerts: five })), countyFips: '06037', pointState: 'CA' })
    expect(fire.pointSource).toBe('fire')
    const fireLines = localAlertLines(fire, LA12, 3, { units: 'us', fireOpen: true })
    expect(fireLines.filter((x) => x.key.startsWith('local-la-'))).toHaveLength(3)
    expect(fireLines.find((x) => x.key === 'local-more')?.text).toBe('+2 more local alerts (see Updates)')
  })
})

describe('review R4: map credits for local officials\' alerts', () => {
  it('NWS when its channel answered; FEMA\'s archive with the OpenFEMA notice when the archive answered; nothing unchecked', () => {
    expect(localAlertCredits(localAlertsState(ok(LOCAL_LIVE_LA_CEM))).map((c) => c.text)).toEqual(["Local officials' alerts: National Weather Service (relayed local officials' messages)"])
    expect(localAlertCredits(localAlertsState(ok(LOCAL_LIVE_NONE_RENO))).map((c) => c.id)).toEqual(['official-local-nws'])
    const eaton = localAlertCredits(localAlertsState(ok(LOCAL_ARCHIVE_EATON)))
    expect(eaton).toEqual([
      {
        id: 'official-local-openfema',
        text: "Local officials' alerts: FEMA IPAWS archive via OpenFEMA. This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA.",
        href: 'https://www.fema.gov/about/openfema/terms-conditions',
      },
    ]) // NWS was not checked for that time (older than 7 days)
    expect(localAlertCredits(localAlertsState(ok(LOCAL_ARCHIVE_PENDING_BLACK_COVE)))).toEqual([])
    expect(localAlertCredits(localAlertsState(ok(null, { error: NOT_FOUND_TEXT })))).toEqual([])
    expect(localAlertCredits(null)).toEqual([])
  })
})

// Integration part 1 review UX-m2 / UX-m3: a message sent after the replay time is never called "upcoming", and a
// "none here" line names the channels that actually answered.
describe('phase words and the channels that answered (integration review)', () => {
  const hg = localAlertsState({ data: LOCAL_ARCHIVE_HORSE_GULCH, loading: false, error: null })
  const a = hg.alerts[0]
  const MDT12 = timeFmt('America/Denver', '12h')

  it('sent after the reference time: "sent 32 min after this time"; onset later: "not yet in effect"; ended: "ended"', () => {
    const up = { ...a, phase: 'upcoming' as const }
    expect(localPhaseText(up, a.sentMs! - 32 * 60_000)).toBe('sent 32 min after this time')
    expect(localPhaseText(up, a.sentMs! - 65 * 60_000)).toBe('sent 1 h 5 min after this time')
    expect(localPhaseText(up, a.sentMs! + 60_000)).toBe('not yet in effect')
    expect(localPhaseText(up, null)).toBe('not yet in effect')
    expect(localPhaseText({ ...a, phase: 'expired' }, null)).toBe('ended')
    expect(localPhaseText(a, a.sentMs! + 1)).toBeNull()
  })

  // review round 3, N4: the Helena police's evacuation was sent at 5:45 PM MDT, its onset and effective times 5:00 PM
  it('a message is never quoted as current before its own sent time, whatever its phase (Horse Gulch at 5:00 PM MDT)', () => {
    const at5 = 1720652400000 // Jul 10, 2024 5:00 PM MDT
    expect(a.sentMs).toBe(1720655112000)
    // an answer that still has it in effect (an older backend): the words say when it was sent
    expect(localPhaseText({ ...a, phase: 'active' }, at5)).toBe('sent 45 min after this time')
    expect(localPhaseText({ ...a, phase: 'upcoming' }, at5)).toBe('sent 45 min after this time')
    expect(localPhaseText({ ...a, phase: 'expired' }, at5)).toBe('sent 45 min after this time')
    // from its sent time on: in effect (no words), ended stays "ended"
    expect(localPhaseText({ ...a, phase: 'active' }, a.sentMs)).toBeNull()
    expect(localPhaseText({ ...a, phase: 'expired' }, a.sentMs! + 60_000)).toBe('ended')
    // the answer for 5:00 PM: the item is not in effect there, the older ones (sent before 5:00 PM) are
    const older = { ...LOCAL_ARCHIVE_HORSE_GULCH, requested_at_ms: at5 } // phases as an older backend gave them
    const fixed = { ...older, alerts: older.alerts.map((x) => (x.sent_ms! > at5 ? { ...x, phase: 'upcoming' as const } : x)) }
    for (const data of [older, fixed]) {
      const l = localAlertsState({ data, loading: false, error: null })
      expect(l.alerts.find((x) => x.id === a.id)!.phase).toBe('upcoming')
      expect(l.alerts.map((x) => x.phase)).toEqual(['active', 'active', 'upcoming']) // in effect first
      expect(localAlertFeedItems(l, { manifest: null, tf: MDT12 }).find((f) => f.id === `local-alert:${a.id}`)).toMatchObject({ key: false, status: 'upcoming' })
      // the location card's lines say it too
      const lines = localAlertLines(l, MDT12, 3, { refMs: at5 })
      expect(lines.find((x) => x.text.includes('Urgent! Evacuation for Horse Gulch'))?.sub).toContain('sent 45 min after this time')
    }
    // the issuer's own times are kept (sent 5:45 PM MDT, in the message's own zone)
    expect(sentText(a, MDT12)).toBe('sent Jul 10, 2024 5:45 PM MDT')
    // at 6:00 PM (the fixture's own time) it is in effect
    expect(hg.alerts.find((x) => x.id === a.id)!.phase).toBe('active')
  })

  it('the location card and the panel never say "upcoming" for a message sent after this time', () => {
    const later = { ...hg, alerts: [{ ...a, phase: 'upcoming' as const }] }
    const [line] = localAlertLines(later, MDT12, 3, { refMs: a.sentMs! - 32 * 60_000 })
    expect(line.sub).toContain('FEMA archive · sent 32 min after this time')
    expect(line.subCompact).toContain('sent 32 min after this time')
    expect(`${line.sub} ${line.subCompact}`).not.toMatch(/upcoming/i)
  })

  it('"none here" names what answered: NWS, FEMA\'s archive, or both', () => {
    expect(answeredChannelsText(hg)).toBe('FEMA archive') // NWS keeps about 7 days: not checked for 2024
    expect(answeredChannelsText(localAlertsState({ data: LOCAL_LIVE_NONE_RENO, loading: false, error: null }))).toBe('relayed by NWS')
    const both = { channels: [
      { id: 'nws_api' as const, status: 'available' as const, retrieved_ms: 1, source_updated_ms: null, reason: null },
      { id: 'openfema_archive' as const, status: 'available' as const, retrieved_ms: 1, source_updated_ms: null, reason: null },
    ] }
    expect(answeredChannelsText(both)).toBe('NWS, FEMA archive')
    const none = { ...hg, state: 'none' as const, alerts: [], elsewhere: 1 }
    const [line] = localAlertLines(none, MDT12)
    expect(line.text).toBe("Local officials' alerts (FEMA archive): none here · not an all-clear")
    // one message elsewhere: "1 of the fire's local alerts is …" (was "1 of the fire's local alert is …")
    expect(line.sub).toMatch(/^1 of the fire's local alerts is for other places in its area \(see Updates\)\./)
  })
})

describe("a local message's phase at the panel's time, from its own times (review round 4)", () => {
  const T = 1_720_655_400_000
  const m = (over: Partial<Parameters<typeof localPhaseAt>[0]> = {}) => ({ cancelled: false, sentMs: T - 60_000, onsetMs: null, expiresMs: null, ...over })
  it('in effect from max(sent, onset else effective) until its expiry; sent later reads "sent N min after this time"', () => {
    // an onset before its sent time (Horse Gulch: sent 5:45 PM, effective 5:00 PM): in effect once sent
    expect(localPhaseAt(m({ sentMs: T - 5 * 60_000, onsetMs: T - 50 * 60_000 }), T)).toBe('active')
    expect(localPhaseAt(m({ sentMs: T + 60_000, onsetMs: T - 50 * 60_000 }), T)).toBe('upcoming')
    expect(localPhaseText({ phase: 'upcoming', sentMs: T + 32 * 60_000 }, T)).toBe('sent 32 min after this time')
    // sent, its own onset still ahead (a scheduled one): the only "not yet in effect"
    const scheduled = m({ onsetMs: T + 30 * 60_000 })
    expect(localPhaseAt(scheduled, T)).toBe('upcoming')
    expect(localPhaseText({ ...scheduled, phase: localPhaseAt(scheduled, T) }, T)).toBe('not yet in effect')
    // expiry: ended at its own expiry time, in effect just before
    expect(localPhaseAt(m({ expiresMs: T }), T)).toBe('expired')
    expect(localPhaseAt(m({ expiresMs: T + 1 }), T)).toBe('active')
    expect(localPhaseText({ phase: 'expired', sentMs: T - 60_000 }, T)).toBe('ended')
    // a Cancel is ended; a message without times is in effect until told otherwise
    expect(localPhaseAt(m({ cancelled: true }), T)).toBe('expired')
    expect(localPhaseAt(m({ sentMs: null }), T)).toBe('active')
  })
  it('localAlertsAt re-decides the phases and the order at another time; the same object when nothing changes', () => {
    const at6 = localAlertsState(ok(LOCAL_ARCHIVE_HORSE_GULCH)) // the answer's own 6:00 PM
    expect(localAlertsAt(at6, at6.refMs)).toBe(at6)
    expect(localAlertsAt(at6, null)).toBe(at6)
    const at5 = localAlertsAt(at6, 1_720_652_400_000)
    expect(at5.refMs).toBe(1_720_652_400_000)
    expect(at5.alerts.map((a) => a.phase)).toEqual(['active', 'active', 'upcoming'])
    expect(at5.alerts.at(-1)!.sentMs).toBe(1_720_655_112_000)
    const none = localAlertsState(ok(LOCAL_LIVE_NONE_RENO))
    expect(localAlertsAt(none, T)).toBe(none)
  })
})
