import { describe, expect, it } from 'vitest'
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialZone } from '../../official/model'
import { calfireLine, evacuationLine, fireWeatherLine, localAlertsLine, officialSummary } from './officialSummary'
import { setCaliforniaCommandClock } from '../../extras/__fixtures__/clock.testutil'
import { LOCAL_ARCHIVE_HORSE_GULCH } from '../../official/__fixtures__/localAlerts'
import { localAlertPlace, localAlertsState } from '../../official/localAlerts'
import { officialBadge } from '../../official/model'
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

  it('the phone badge counts the in-effect local messages; an Evacuation Immediate is the most urgent level', () => {
    expect(officialBadge(notAvailable, fw({ state: 'none' }), local)).toEqual({ count: 3, level: 'order' })
    // a Fire Warning alone: a local officials' alert, more urgent than a fire weather alert
    const warning = { ...local, alerts: local.alerts.filter((a) => a.event === 'Fire Warning') }
    expect(officialBadge(notAvailable, fw({ state: 'active', alerts: [alert({})] }), warning)).toEqual({ count: 2, level: 'local' })
    // before: nothing counted
    expect(officialBadge(notAvailable, fw({ state: 'none' }))).toEqual({ count: 0, level: null })
  })
})
