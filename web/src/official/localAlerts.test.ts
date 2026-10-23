// Local officials' messages relayed by NWS and archived by FEMA (brief 3, CONTRACT §14.7).
import { describe, expect, it } from 'vitest'
import { NOT_FOUND_TEXT } from '../extras/format'
import { timeFmt } from '../lib/time'
import { LOCAL_ARCHIVE_EATON, LOCAL_ARCHIVE_KERN_FRW, LOCAL_ARCHIVE_PENDING_BLACK_COVE, LOCAL_ARCHIVE_SHERIDAN_WY, LOCAL_LIVE_LA_CEM, LOCAL_LIVE_NONE_RENO } from './__fixtures__/localAlerts'
import {
  LOCAL_PLACE_NOTE,
  localAlertCredits,
  localAlertFeedItems,
  localAlertLink,
  localAlertPlace,
  localAlertsAtPoint,
  localAlertsState,
  localAlertText,
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
    const l = localAlertsState(ok(LOCAL_ARCHIVE_SHERIDAN_WY))
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
    // the feed: every row's detail carries the phrase, and the note explains it
    const feed = localAlertFeedItems(l, { manifest: null, tf: LA12, metric: false })
    expect(feed).toHaveLength(8)
    feed.forEach((f, i) => expect(f.detail).toContain(places[i]))
    expect(feed[0].detail).toBe("Evacuation Immediate · sent Jan 7, 2025 10:26 PM PST · FEMA archive · area 1.7 mi from the fire's reported location · may be about another fire")
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
    expect(noneLine.text).toBe("Local officials' alerts relayed by NWS: none here · not an all-clear")
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
