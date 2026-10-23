import { describe, expect, it } from 'vitest'
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialZone } from '../../official/model'
import { calfireLine, evacuationLine, fireWeatherLine, localAlertsLine, officialSummary } from './officialSummary'
import { setCaliforniaCommandClock } from '../../extras/__fixtures__/clock.testutil'
import { LOCAL_ARCHIVE_HORSE_GULCH } from '../../official/__fixtures__/localAlerts'
import { localAlertFeedItems, localAlertPlace, localAlertsState, localPhaseText } from '../../official/localAlerts'
import { feedCompareMs, feedStatusLabel, feedView, isLaterItem } from '../feed/feedModel'
import { officialBadge } from '../../official/model'
import type { LocalAlert } from '../../official/types'
import { localAlertLines } from '../../location/official'
import { timeFmt } from '../../lib/time'

setCaliforniaCommandClock()

const evac = (over: Partial<EvacuationOfficial>): EvacuationOfficial =>
  ({ state: 'none-listed', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: '', ...over }) as EvacuationOfficial
const zone = (over: Partial<OfficialZone>): OfficialZone =>
  ({ id: 'z', status: 'Evacuation Order', group: 'order', issuer: 'Orange County', distanceKm: 25.7, outsideAnalysisArea: true, name: null, message: null, ...over }) as OfficialZone
const fw = (over: Partial<FireWeatherOfficial>): FireWeatherOfficial =>
  ({ state: 'none', alerts: [], checkedMs: null, archived: false, credit: '', sourceUrl: '', caveat: '', ...over }) as FireWeatherOfficial
const alert = (over: Partial<OfficialAlert>): OfficialAlert =>
  ({ id: 'a', event: 'Red Flag Warning', senderName: 'National Weather Service Los Angeles/Oxnard CA', headline: '', url: null, archived: false, phase: 'active', timeText: 'until Jan 10, 14:48 PST', coversReportedLocation: true, nearestKm: 0, ugcs: [], bounds: null, ...over }) as OfficialAlert

describe('Public official summary lines', () => {
  it("quotes the zone status, names its issuer and distance, and the most urgent group's tone", () => {
    const l = evacuationLine(evac({ state: 'listed', zones: [zone({}), zone({ id: 'y', status: 'Evacuation Warning', group: 'warning', issuer: 'Riverside County' })] }), false)
    expect(l.text).toBe('Evacuation Order · 1 zone, 16 mi away · +1 more')
    expect(l.source).toBe('Orange County')
    expect(l.tone).toBe('order')
  })

  it('never reads silence as safety', () => {
    expect(evacuationLine(evac({ state: 'none-listed' }), true).text).toBe('None listed within 15 km. Not an all-clear.')
    expect(evacuationLine(evac({ state: 'past-date' }), true).text).toBe('Not available for past dates.')
    expect(fireWeatherLine(fw({ state: 'none' })).text).toMatch(/Not an all-clear\.$/)
    expect(fireWeatherLine(fw({ state: 'past-date' })).tone).toBe('muted')
  })

  it("keeps the NWS event verbatim with its time, shortens the sender and marks archived copies", () => {
    const l = fireWeatherLine(fw({ state: 'active', archived: true, alerts: [alert({}), alert({ id: 'b', event: 'Fire Weather Watch', phase: 'expired' })] }))
    expect(l.text).toBe('Red Flag Warning until Jan 10, 14:48 PST')
    expect(l.source).toBe('NWS Los Angeles/Oxnard CA, archived copy')
  })

  it("gives CAL FIRE's record with its own update time; a past fire's final record says so", () => {
    const nowMs = Date.UTC(2026, 9, 18, 17)
    const live = calfireLine({ state: 'available', acres: 3160, percentContained: 65, isActive: true, updatedMs: Date.UTC(2026, 9, 18, 15, 1) } as CalFireOfficial, nowMs)
    expect(live.text).toBe('3,160 ac · 65% contained · updated Oct 18, 08:01 PDT')
    const past = calfireLine({ state: 'available', acres: 14021, percentContained: 100, isActive: false, final: true, updatedMs: Date.UTC(2026, 7, 6, 17, 47) } as CalFireOfficial, nowMs)
    // a record that is no longer active keeps its year (a replay of 2025 must not read "Aug 6" as 2025)
    expect(past.text).toBe('14,021 ac · 100% contained · final record · updated Aug 6, 2026 10:47 PDT')
    expect(calfireLine({ state: 'unavailable' } as CalFireOfficial, nowMs).tone).toBe('muted')
    // no record vs an outage: an unreachable source is never reported as "no record"
    expect(calfireLine({ state: 'unavailable', reason: 'No CAL FIRE record is linked to this fire.' } as CalFireOfficial, nowMs).text).toBe('No record for this fire.')
    expect(calfireLine({ state: 'unavailable', reason: 'Could not reach the Fire-3d server.', unreachable: true } as CalFireOfficial, nowMs).text).toBe('Unavailable right now.')
  })

  it('always lists the three sources in order', () => {
    const lines = officialSummary({ evacuation: evac({}), calfire: { state: 'loading' } as CalFireOfficial, fireWeather: fw({ state: 'loading' }) }, 0, false)
    expect(lines.map((l) => l.key)).toEqual(['evacuation', 'calfire', 'fire-weather'])
  })
})

describe('evacuation summary line (brief 3)', () => {
  it('a state without a feed: "Not available in this state (Montana)." with no source tag; Oregon names Oregon OEM', () => {
    const na = { state: 'not-available' as const, zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: '', sources: [] }
    expect(evacuationLine({ ...na, notAvailableIn: ['Montana'] }, false)).toMatchObject({ text: 'Not available in this state (Montana).', source: null })
    // an area across two states names both, as the full panel does (review UX-m6: Black Cove, NC and SC)
    expect(evacuationLine({ ...na, notAvailableIn: ['North Carolina', 'South Carolina'] }, false)).toMatchObject({ text: 'Not available in these states (North Carolina, South Carolina).' })
    // no state named (outside the lower 48): the backend's own sentence, else "here"
    expect(evacuationLine(na, false)).toMatchObject({ text: 'Not available here.', source: null })
    expect(evacuationLine({ ...na, reason: 'Fire-3d covers the lower 48 states only. Follow local officials.' }, false).text).toBe('Fire-3d covers the lower 48 states only.')
    expect(evacuationLine({ state: 'none-listed', zones: [], checkedMs: 1, sourceUpdatedMs: 1, sourceUrl: null, caveat: '', checkedBy: 'Oregon OEM' }, false).source).toBe('Oregon OEM')
    expect(evacuationLine({ state: 'none-listed', zones: [], checkedMs: 1, sourceUpdatedMs: 1, sourceUrl: null, caveat: '' }, false).source).toBe('Cal OES') // brief-2 shape
  })
})

// Integration part 1 review UX-M1: local officials' evacuation messages in the two places a non-expert sees first. Horse
// Gulch (Montana: no state evacuation feed) at Jul 10, 2024 6:00 PM MDT has three in-effect messages from
// MTHelenaPoliceDepartment in FEMA's archive; before, the Public summary said only "Evacuations: Not available in this
// state." and the phone badge counted nothing.
describe("local officials' alerts in the Public summary and the phone badge (Horse Gulch, MT)", () => {
  const AT = 1720656000000 // Jul 10, 2024 18:00 MDT
  const MDT12 = timeFmt('America/Denver', '12h')
  const local = localAlertsState({ data: LOCAL_ARCHIVE_HORSE_GULCH, loading: false, error: null })
  const notAvailable = evac({ state: 'not-available', notAvailableIn: ['Montana'] })

  it('quotes the newest message verbatim with its issuer, own sent time, the archive and its link, separate from the evacuation line', () => {
    const l = localAlertsLine(local, MDT12, AT)
    expect(l).not.toBeNull()
    expect(l!.label).toBe("Local officials' alerts")
    expect(l!.text).toBe(
      "Archived alert from MTHelenaPoliceDepartment: “Urgent! Evacuation for Horse Gulch Fire: Residences between Cave Gulch to Magpie Gulch” · sent Jul 10, 2024 5:45 PM MDT · FEMA archive · area covers the fire's reported location · +2 more in Details",
    )
    expect(l!.tone).toBe('order') // "Evacuation Immediate", the issuer's own event
    expect(l!.link?.url).toMatch(/^https:\/\/www\.fema\.gov\/api\/open\/v1\/IpawsArchivedAlerts/)
    const lines = officialSummary({ evacuation: notAvailable, calfire: { state: 'loading' } as CalFireOfficial, fireWeather: fw({ state: 'none' }), local }, AT, false, MDT12, AT)
    expect(lines.map((x) => x.key)).toEqual(['evacuation', 'local', 'calfire', 'fire-weather'])
    // the evacuation line keeps its own words; the message is never merged into it
    expect(lines[0].text).toBe('Not available in this state (Montana).')
  })

  it('no line when nothing is in effect, not checked or none (the full block says those)', () => {
    expect(localAlertsLine(localAlertsState(null), MDT12, AT)).toBeNull()
    const ended = { ...local, alerts: local.alerts.map((a) => ({ ...a, phase: 'expired' as const })) }
    expect(localAlertsLine(ended, MDT12, AT)).toBeNull()
    expect(officialSummary({ evacuation: notAvailable, calfire: { state: 'loading' } as CalFireOfficial, fireWeather: fw({ state: 'none' }) }, AT, false).map((x) => x.key)).toEqual(['evacuation', 'calfire', 'fire-weather'])
  })

  it("says where the message's area lies, in the full block's words and the viewer's units (review round 2, N1)", () => {
    const away = { ...local.alerts[0], where: { from: 'fire' as const, covers: false, km: 1.6 } }
    const one = { ...local, alerts: [away] }
    expect(localAlertsLine(one, MDT12, AT)!.text).toBe(
      "Archived alert from MTHelenaPoliceDepartment: “Urgent! Evacuation for Horse Gulch Fire: Residences between Cave Gulch to Magpie Gulch” · sent Jul 10, 2024 5:45 PM MDT · FEMA archive · area 1 mi from the fire's reported location · may be about another fire",
    )
    // metric viewers, through the summary the panel uses
    const lines = officialSummary({ evacuation: notAvailable, calfire: { state: 'loading' } as CalFireOfficial, fireWeather: fw({ state: 'none' }), local: one }, AT, true, MDT12, AT)
    expect(lines.find((x) => x.key === 'local')!.text).toContain("· area 1.6 km from the fire's reported location · may be about another fire")
    // matched by county: said so, never a distance
    const county = { ...local, alerts: [{ ...away, match: 'county' as const, where: { from: 'fire' as const, covers: null, km: null } }] }
    expect(localAlertsLine(county, MDT12, AT)!.text).toContain('· matched by county, not by an exact area · may be about another fire')
    // the same words as the full block (OfficialNow's LocalAlertsRow uses localAlertPlace)
    expect(localAlertsLine(one, MDT12, AT)!.text).toContain(localAlertPlace(away, { metric: false }))
  })

  it('a message sent after the replay time says so, never "upcoming" (review UX-m2)', () => {
    const later = { ...local, alerts: [{ ...local.alerts[0], phase: 'upcoming' as const }] }
    const l = localAlertsLine(later, MDT12, local.alerts[0].sentMs! - 32 * 60_000)
    expect(l!.text).toContain('· sent 32 min after this time')
    expect(l!.text).not.toMatch(/upcoming/i)
  })

  it('at 5:00 PM MDT the 5:45 PM evacuation is not quoted as current: in effect first, "sent 45 min after this time" (review round 3, N4)', () => {
    const at5 = 1720652400000
    const data = { ...LOCAL_ARCHIVE_HORSE_GULCH, requested_at_ms: at5 } // even with the phases of an older backend
    const l5 = localAlertsState({ data, loading: false, error: null })
    const line = localAlertsLine(l5, MDT12, at5)!
    // the short line quotes a message in effect at 5:00 PM (sent earlier), never the later evacuation
    expect(line.text).not.toContain('Urgent! Evacuation for Horse Gulch')
    expect(line.text).toBe(
      'Archived alert from MTHelenaPoliceDepartment: “Urgent. A fire evacuation notice has been issued by the Sheriff for the Cave Gulch area.” · sent Jul 10, 2024 3:53 PM MDT · FEMA archive · matched by county, not by an exact area · may be about another fire · +2 more in Details',
    )
    // the later message alone: quoted with when it was sent, relative to 5:00 PM
    const only = { ...l5, alerts: l5.alerts.filter((a) => a.sentMs! > at5) }
    expect(only.alerts).toHaveLength(1)
    expect(localAlertsLine(only, MDT12, at5)!.text).toContain('· sent Jul 10, 2024 5:45 PM MDT · FEMA archive · sent 45 min after this time ·')
  })

  it('the phone badge never counts a message sent after the answer’s time as active (review round 3, N4)', () => {
    const at5 = 1720652400000 // Jul 10, 2024 5:00 PM MDT: the 5:45 PM evacuation was not sent yet
    const upcomingAfter = (at: number) => ({
      ...LOCAL_ARCHIVE_HORSE_GULCH,
      requested_at_ms: at,
      alerts: LOCAL_ARCHIVE_HORSE_GULCH.alerts.map((x) => (x.sent_ms! > at ? { ...x, phase: 'upcoming' as const } : x)),
    })
    const l5 = localAlertsState({ data: upcomingAfter(at5), loading: false, error: null })
    expect(l5.refMs).toBe(at5)
    // the two messages sent before 5:00 PM (the 3:53 PM one an Evacuation Immediate); never the 5:45 PM one
    expect(officialBadge(notAvailable, fw({ state: 'none' }), l5)).toEqual({ count: 2, level: 'order' })
    // an older backend's answer (the later message still "in effect"): the same count
    const older = localAlertsState({ data: { ...LOCAL_ARCHIVE_HORSE_GULCH, requested_at_ms: at5 }, loading: false, error: null })
    expect(officialBadge(notAvailable, fw({ state: 'none' }), older)).toEqual({ count: 2, level: 'order' })
    // 2:00 PM: every message was sent later (the replay's next hour lists them): nothing counted, no level
    const at2 = 1720641600000
    const l2 = localAlertsState({ data: upcomingAfter(at2), loading: false, error: null })
    expect(l2.alerts.every((a) => a.phase === 'upcoming')).toBe(true)
    expect(officialBadge(notAvailable, fw({ state: 'none' }), l2)).toEqual({ count: 0, level: null })
    // a live answer (no requested time) is decided at its own now (review round 4): these 2024 messages have all passed
    // their own expiry, so none counts; at the panel's time (6:00 PM that day) all three do
    const live = localAlertsState({ data: { ...LOCAL_ARCHIVE_HORSE_GULCH, requested_at_ms: null }, loading: false, error: null })
    expect(live.refMs).toBe(LOCAL_ARCHIVE_HORSE_GULCH.now_ms)
    expect(officialBadge(notAvailable, fw({ state: 'none' }), live)).toEqual({ count: 0, level: null })
    expect(officialBadge(notAvailable, fw({ state: 'none' }), live, 1720656000000)).toEqual({ count: 3, level: 'order' })
  })

  it('the phone badge counts the in-effect local messages; an Evacuation Immediate is the most urgent level', () => {
    expect(officialBadge(notAvailable, fw({ state: 'none' }), local)).toEqual({ count: 3, level: 'order' })
    // a Fire Warning alone: a local officials' alert, more urgent than a fire weather alert
    const warning = { ...local, alerts: local.alerts.filter((a) => a.event === 'Fire Warning') }
    expect(officialBadge(notAvailable, fw({ state: 'active', alerts: [alert({})] }), warning)).toEqual({ count: 2, level: 'local' })
    // before: nothing counted
    expect(officialBadge(notAvailable, fw({ state: 'none' }))).toEqual({ count: 0, level: null })
  })
})

describe('Horse Gulch local messages at the panel’s own time, from an hour-quantised answer (review round 4)', () => {
  const H = 3_600_000
  const MDT12 = timeFmt('America/Denver', '12h')
  const notAvailable = evac({ state: 'not-available', notAvailableIn: ['Montana'] })
  const none = fw({ state: 'none' })
  // the backend's answer for the hour the web asks about (at_ms = the hour): the messages sent in [hour − 24 h, hour +
  // 1 h], each with the backend's hour-level phase (nws.local_phase at the hour), as the API answers it
  const hourPhase = (x: LocalAlert, at: number): LocalAlert['phase'] => {
    const start = Math.max(...[x.onset_ms ?? x.effective_ms, x.sent_ms].filter((t): t is number => t != null))
    if (at < start) return 'upcoming'
    return x.expires_ms != null && at >= x.expires_ms ? 'ended' : 'in_effect'
  }
  const answerAt = (atMs: number) => {
    const hour = Math.floor(atMs / H) * H
    const alerts = LOCAL_ARCHIVE_HORSE_GULCH.alerts.filter((x) => x.sent_ms! >= hour - 24 * H && x.sent_ms! <= hour + H).map((x) => ({ ...x, phase: hourPhase(x, hour) }))
    return { ...LOCAL_ARCHIVE_HORSE_GULCH, requested_at_ms: hour, alerts }
  }
  // the hooks: decided at the panel's time (useOfficialNow); the panels: given their own time
  const atPanel = (t: number) => localAlertsState({ data: answerAt(t), loading: false, error: null }, { refMs: t })
  const atHour = (t: number) => localAlertsState({ data: answerAt(t), loading: false, error: null })
  const EVAC_545 = 'Archived alert from MTHelenaPoliceDepartment: “Urgent! Evacuation for Horse Gulch Fire: Residences between Cave Gulch to Magpie Gulch” · sent Jul 10, 2024 5:45 PM MDT · FEMA archive · area covers the fire\'s reported location · +2 more in Details'
  const CAVE_353 = 'Archived alert from MTHelenaPoliceDepartment: “Urgent. A fire evacuation notice has been issued by the Sheriff for the Cave Gulch area.” · sent Jul 10, 2024 3:53 PM MDT · FEMA archive · matched by county, not by an exact area · may be about another fire'

  it('5:50 PM MDT: the 5:45 PM evacuation (effective 5:00 PM) is in effect, quoted first and counted; never "not yet in effect"', () => {
    const t = 1720655400000
    expect(answerAt(t).alerts.find((x) => x.sent_ms === 1720655112000)!.phase).toBe('upcoming') // the backend's 5:00 PM hint
    const l = atPanel(t)
    expect(l.refMs).toBe(t)
    expect(l.alerts.map((a) => [a.sentMs, a.phase])).toEqual([
      [1720655112000, 'active'],
      [1720648395000, 'active'],
      [1720644330000, 'active'],
    ])
    expect(l.alerts.map((a) => localPhaseText(a, l.refMs))).toEqual([null, null, null])
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(EVAC_545)
    expect(officialBadge(notAvailable, none, l, t)).toEqual({ count: 3, level: 'order' })
    // the panels and the badge re-decide an answer decided at the query's hour at their own time: the same result
    const hour = atHour(t)
    expect(hour.refMs).toBe(1720652400000)
    expect(localAlertsLine(hour, MDT12, t)!.text).toBe(EVAC_545)
    expect(officialBadge(notAvailable, none, hour, t)).toEqual({ count: 3, level: 'order' })
    // the location card's lines (Command and phones): the 5:45 PM message first, in effect, no phase words
    const card = localAlertLines(hour, MDT12, 3, { units: 'us', fireOpen: true, refMs: t }).filter((x) => x.url)
    expect(card[0].text).toBe('Archived alert from MTHelenaPoliceDepartment: "Urgent! Evacuation for Horse Gulch Fire: Residences between Cave Gulch to Magpie Gulch"')
    expect(card[0].tone).toBe('warning')
    for (const line of card) expect(line.sub).not.toMatch(/not yet in effect|after this time|ended/)
  })

  it('2:50 PM MDT: the 2:45 PM pre-evacuation Fire Warning (effective 2:28 PM) is in effect; the badge shows 1', () => {
    const t = 1720644600000
    const l = atPanel(t)
    expect(l.alerts).toHaveLength(1) // the 2:00 PM answer lists messages sent up to 3:00 PM: only this one
    expect(l.alerts[0]).toMatchObject({ event: 'Fire Warning', phase: 'active' })
    expect(localPhaseText(l.alerts[0], l.refMs)).toBeNull()
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(
      'Archived alert from MTHelenaPoliceDepartment: “Urgent. A fire pre-evacuation notice has been issued by the Sheriff for Horse Gulch area.” · sent Jul 10, 2024 2:45 PM MDT · FEMA archive · matched by county, not by an exact area · may be about another fire',
    )
    expect(officialBadge(notAvailable, none, l, t)).toEqual({ count: 1, level: 'local' })
    expect(officialBadge(notAvailable, none, atHour(t), t)).toEqual({ count: 1, level: 'local' })
    // 2:20 PM, the same hour's answer: not sent yet (and before its effective time): said so, never counted
    const early = 1720642800000
    const e = atPanel(early)
    // "sent 2:45 PM" (2:45:30 cut to the minute, as shown) at 2:20 PM: 25 min, never a rounded 26 (integration part 2)
    expect(localPhaseText(e.alerts[0], e.refMs)).toBe('sent 25 min after this time')
    expect(localAlertsLine(e, MDT12, early)!.text).toContain('· sent Jul 10, 2024 2:45 PM MDT · FEMA archive · sent 25 min after this time ·')
    expect(officialBadge(notAvailable, none, e, early)).toEqual({ count: 0, level: null })
  })

  it('5:00 PM MDT (round 3 kept): the 5:45 PM message reads "sent 45 min after this time"; the badge shows 2', () => {
    const t = 1720652400000
    const l = atPanel(t)
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(`${CAVE_353} · +2 more in Details`)
    const later = l.alerts.find((a) => a.sentMs === 1720655112000)!
    expect(later.phase).toBe('upcoming')
    expect(localPhaseText(later, l.refMs)).toBe('sent 45 min after this time')
    expect(l.alerts.at(-1)).toBe(later) // in effect first
    expect(officialBadge(notAvailable, none, l, t)).toEqual({ count: 2, level: 'order' })
  })

  it('6:00 PM MDT: all three in effect; the badge shows 3', () => {
    const t = 1720656000000
    const l = atPanel(t)
    expect(l.alerts.every((a) => a.phase === 'active')).toBe(true)
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(EVAC_545)
    expect(officialBadge(notAvailable, none, l, t)).toEqual({ count: 3, level: 'order' })
  })

  it('5:45:12 and 5:45:30 PM MDT (the sent second and later in its minute): the feed and the panels use one time (integration part 2)', () => {
    const sent = 1720655112000 // 5:45:12 PM MDT
    const tf = timeFmt('America/Denver', '12h')
    for (const timeMs of [sent, sent + 18_000]) {
      // the panels' time is the replay minute (useOfficialPanelTime / the official context's refMs): 5:45:00 PM
      const panel = Math.floor(timeMs / 60_000) * 60_000
      const l = atPanel(panel)
      const evac = l.alerts.find((a) => a.sentMs === sent)!
      expect(evac.phase).toBe('upcoming')
      expect(localPhaseText(evac, l.refMs)).toBe('sent less than a minute after this time')
      expect(officialBadge(notAvailable, none, l, panel)).toEqual({ count: 2, level: 'order' })
      // the feed splits at the exact timeline time: the message joins it at 5:46:00, so it sits with the later updates,
      // labelled "Sent after this time", never listed as "Not yet in effect"
      const items = localAlertFeedItems(l, { manifest: null, tf })
      const row = items.find((i) => i.issuedMs === sent)!
      expect(feedCompareMs(row)).toBe(1720655160000)
      const chrono = items.slice().sort((x, y) => feedCompareMs(x) - feedCompareMs(y))
      const view = feedView(chrono, timeMs, false, false)
      expect(view.listed.map((i) => i.id)).not.toContain(row.id)
      expect(view.later.map((i) => i.id)).toContain(row.id)
      expect(feedStatusLabel(row, isLaterItem(row, timeMs, false))).toBe('Sent after this time')
      // a live fire's feed lists everything (nothing is "later"): the label still follows the panels' time
      expect(feedStatusLabel(row, false)).toBe('Sent after this time')
    }
    // 5:46:00 PM: listed and in effect (effective 5:00 PM), no status label, at the same minute in every panel
    const t = 1720655160000
    const l = atPanel(t)
    const row = localAlertFeedItems(l, { manifest: null, tf: MDT12 }).find((i) => i.issuedMs === sent)!
    expect(row.status).toBe('active')
    expect(feedView([row], t, false, false).listed).toEqual([row])
    expect(feedStatusLabel(row, isLaterItem(row, t, false))).toBeUndefined()
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(EVAC_545)
  })

  it('expiry: the 5:45 PM evacuation ends at its own expiry (7:45:12 PM MDT), at the panel’s minute', () => {
    const before = 1720662300000 // 7:45 PM: 12 s before it expires
    expect(officialBadge(notAvailable, none, atPanel(before), before)).toEqual({ count: 3, level: 'order' })
    const t = 1720662600000 // 7:50 PM
    const l = atPanel(t)
    const ended = l.alerts.find((a) => a.sentMs === 1720655112000)!
    expect(ended.phase).toBe('expired')
    expect(localPhaseText(ended, l.refMs)).toBe('ended')
    expect(l.alerts.at(-1)).toBe(ended)
    expect(localAlertsLine(l, MDT12, t)!.text).toBe(`${CAVE_353} · +1 more in Details`)
    expect(officialBadge(notAvailable, none, l, t)).toEqual({ count: 2, level: 'order' })
    // the 7:00 PM answer still says "in effect" at its hour; the panel's 7:50 PM decides
    expect(officialBadge(notAvailable, none, atHour(t), t)).toEqual({ count: 2, level: 'order' })
  })
})
