// Local officials' messages relayed by NWS and archived by FEMA (brief 3, CONTRACT §14.7).
import { describe, expect, it } from 'vitest'
import { NOT_FOUND_TEXT } from '../extras/format'
import { timeFmt } from '../lib/time'
import { LOCAL_ARCHIVE_KERN_FRW, LOCAL_ARCHIVE_PENDING_BLACK_COVE, LOCAL_ARCHIVE_SHERIDAN_WY, LOCAL_LIVE_LA_CEM, LOCAL_LIVE_NONE_RENO } from './__fixtures__/localAlerts'
import { localAlertFeedItems, localAlertLink, localAlertsState, localAlertText, OPENFEMA_NOTICE, sentText } from './localAlerts'
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
