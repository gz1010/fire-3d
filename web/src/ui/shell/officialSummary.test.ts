import { describe, expect, it } from 'vitest'
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert, OfficialZone } from '../../official/model'
import { calfireLine, evacuationLine, fireWeatherLine, officialSummary } from './officialSummary'
import { setCaliforniaCommandClock } from '../../extras/__fixtures__/clock.testutil'

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
    expect(past.text).toBe('14,021 ac · 100% contained · final record · updated Aug 6, 10:47 PDT')
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
  it('a state without a feed: "Not available in this state." with no source tag; Oregon names Oregon OEM', () => {
    expect(evacuationLine({ state: 'not-available', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: '', sources: [] }, false)).toMatchObject({ text: 'Not available in this state.', source: null })
    expect(evacuationLine({ state: 'none-listed', zones: [], checkedMs: 1, sourceUpdatedMs: 1, sourceUrl: null, caveat: '', checkedBy: 'Oregon OEM' }, false).source).toBe('Oregon OEM')
    expect(evacuationLine({ state: 'none-listed', zones: [], checkedMs: 1, sourceUpdatedMs: 1, sourceUrl: null, caveat: '' }, false).source).toBe('Cal OES') // brief-2 shape
  })
})
