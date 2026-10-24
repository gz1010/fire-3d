import { describe, expect, it } from 'vitest'
import type { IncidentSummary, Perimeter } from '../../api/types'
import { lonLatToLocal } from '../../lib/reproject'
import { timeFmt } from '../../lib/time'
import type { CalFireOfficial, EvacuationOfficial, FireWeatherOfficial, OfficialAlert } from '../../official/model'
import {
  distanceChipText,
  distanceToFire,
  evacReasonRest,
  factsSource,
  fireDateLine,
  fireEnd,
  fireFacts,
  fireLabel,
  fitName,
  hazardStatus,
  perimeterKey,
  recordFigures,
  shortPerimeterSource,
  updateYear,
  type FactsInput,
} from './fireView'

const TZ = 'America/Denver'
const TF = timeFmt(TZ, '12h')
const NOW = Date.UTC(2026, 9, 24, 18, 0)
const JUN28 = Date.UTC(2026, 5, 28, 18, 0)

const willow: IncidentSummary = {
  id: '2026-willow-548a8d',
  name: 'Willow',
  mode: 'live',
  year: 2026,
  calfire_uid: '',
  started_ms: JUN28,
  updated_ms: Date.UTC(2026, 9, 22, 19, 28),
  contained_ms: null,
  acres: 7359,
  percent_contained: 92,
  is_active: true,
  county: 'Lake',
  location: null,
  admin_unit: 'COPSF',
  url: 'https://services3.arcgis.com/x/query?f=html',
  lat: 39.23358,
  lon: -106.44033,
  detections_24h: 0,
  bundle_status: 'none',
  bundle_built_ms: null,
  uid: '548A8D28',
  record_source: 'wfigs',
  record_issuer: 'USFS via NIFC WFIGS',
  state: 'CO',
  time_zone: TZ,
  active_sources: ['wfigs'],
  contained_kind: null,
}

const pastFire: IncidentSummary = {
  ...willow,
  id: '2025-lower-sugarloaf-569fb7',
  name: 'Lower Sugarloaf',
  mode: 'historical',
  year: 2025,
  is_active: false,
  active_sources: [],
  started_ms: Date.UTC(2025, 8, 1, 16, 21),
  contained_ms: Date.UTC(2025, 10, 14, 20, 0),
  contained_kind: 'contained',
  percent_contained: 99,
  state: 'WA',
}

const record = (over: Partial<CalFireOfficial> = {}): CalFireOfficial => ({ state: 'loading', ...over }) as CalFireOfficial
const evac = (over: Partial<EvacuationOfficial>): EvacuationOfficial => ({ state: 'loading', zones: [], checkedMs: null, sourceUpdatedMs: null, sourceUrl: null, caveat: '', ...over })
const fw = (over: Partial<FireWeatherOfficial>): FireWeatherOfficial => ({ state: 'none', alerts: [], checkedMs: NOW - 120_000, archived: false, credit: 'National Weather Service', sourceUrl: 'https://api.weather.gov', caveat: '', ...over })

const input = (over: Partial<FactsInput> = {}): FactsInput => ({
  summary: willow,
  record: record(),
  evacuation: evac({ state: 'not-available', reason: 'Not available in this state (Colorado)', notAvailableIn: ['Colorado'] }),
  fireWeather: fw({}),
  local: null,
  demo: false,
  tf: TF,
  nowMs: NOW,
  ...over,
})

describe('fire view title', () => {
  it('says PRESENT while the record lists the fire as active', () => {
    expect(fireDateLine(JUN28, true, null, TZ)).toBe('JUN 28 2026 — PRESENT')
  })

  it('ends with the record’s own end and its label, else the start alone', () => {
    const end = fireEnd(pastFire, null)
    expect(end).toEqual({ label: 'contained', ms: pastFire.contained_ms })
    expect(fireDateLine(pastFire.started_ms, false, end, 'America/Los_Angeles')).toBe('SEP 1 2025 — CONTAINED NOV 14 2025')
    expect(fireDateLine(pastFire.started_ms, false, null, 'America/Los_Angeles')).toBe('SEP 1 2025')
    expect(fireDateLine(null, true, null, TZ)).toBeNull()
  })

  it('prefers the record endpoint’s latest stage (a fire-out time is never called containment)', () => {
    const out = Date.UTC(2025, 11, 1)
    expect(fireEnd(pastFire, record({ containedMs: pastFire.contained_ms ?? undefined, outMs: out }))).toEqual({ label: 'declared out', ms: out })
    // an older NIFC WFIGS row without contained_kind gives no date
    expect(fireEnd({ ...pastFire, contained_kind: null }, null)).toBeNull()
  })
})

describe('hazard circle status (decision i-10: the agency record only)', () => {
  it('reads ACTIVE only while the record lists the fire', () => {
    expect(hazardStatus(willow, null, false, 'USFS via NIFC WFIGS', TZ)).toMatchObject({ line: 'WILDFIRE · ACTIVE', tone: 'active' })
    expect(hazardStatus(pastFire, fireEnd(pastFire, null), false, 'USFS via NIFC WFIGS', TZ)).toMatchObject({ line: 'WILDFIRE · CONTAINED', tone: 'quiet' })
    expect(hazardStatus(pastFire, fireEnd(pastFire, null), false, null, TZ).meaning).toContain('Contained is not out')
    expect(hazardStatus(pastFire, { label: 'declared out', ms: NOW }, false, null, TZ).line).toBe('WILDFIRE · DECLARED OUT')
    expect(hazardStatus(pastFire, { label: 'controlled', ms: NOW }, false, null, TZ).line).toBe('WILDFIRE · CONTROLLED')
    expect(hazardStatus({ ...pastFire, contained_ms: null, percent_contained: 40 }, null, false, null, TZ).line).toBe('WILDFIRE · NOT LISTED AS ACTIVE')
  })

  it('says a demo fire is simulated, and nothing before the record is in', () => {
    expect(hazardStatus(willow, null, true, null, TZ).line).toBe('SIMULATED FIRE · DEMO')
    expect(hazardStatus(null, null, false, null, TZ).line).toBe('WILDFIRE')
  })
})

describe('fitting the name in the circle', () => {
  // a fake font: 0.55 em per character
  const measure = (t: string, px: number) => t.length * px * 0.55
  it('keeps a short name at 72 px on one line', () => {
    expect(fitName('Willow', measure)).toEqual({ lines: ['Willow'], px: 72 })
  })
  it('shrinks, then breaks over two lines when that is clearly larger', () => {
    const f = fitName('Lower Sugarloaf', measure)
    expect(f.lines).toEqual(['Lower', 'Sugarloaf'])
    expect(f.px).toBeGreaterThanOrEqual(40)
    expect(f.px).toBeLessThanOrEqual(72)
    expect(Math.max(...f.lines.map((l) => measure(l, f.px)))).toBeLessThanOrEqual(256)
    // one line when two would not be 8 px larger
    expect(fitName('Big Ash', measure)).toEqual({ lines: ['Big Ash'], px: 66 })
    // and two lines when they are
    expect(fitName('Big Fire', measure)).toEqual({ lines: ['Big', 'Fire'], px: 72 })
  })
  it('takes a long name below 40 px over up to three (at 28-30 px four) lines, every word kept in order (review DF-H34-6)', () => {
    const f = fitName('Pontotoc Pennington Road Complex North', measure)
    expect(f.px).toBeLessThan(40)
    expect(f.px).toBeGreaterThanOrEqual(28)
    expect(f.lines.length).toBeLessThanOrEqual(3)
    expect(f.lines.join(' ')).toBe('Pontotoc Pennington Road Complex North')
    expect(Math.max(...f.lines.map((l) => measure(l, f.px)))).toBeLessThanOrEqual(256)
    expect(f.clamp).toBeUndefined()
    // the name that lost its middle words before: "Campbell -…" over "Wildlife Mg…"
    const c = fitName('Campbell -N Cumberland Wildlife Mgt Area', measure)
    expect(c.lines.join(' ').replace('- ', '-')).toBe('Campbell -N Cumberland Wildlife Mgt Area')
    expect(Math.max(...c.lines.map((l) => measure(l, c.px)))).toBeLessThanOrEqual(256)
  })

  it('clamps a name too long even at 28 px as one block (cut at its end, never in the middle)', () => {
    expect(fitName('Supercalifragilisticexpialidocious', measure)).toEqual({ lines: ['Supercalifragilisticexpialidocious'], px: 28, clamp: true })
  })
})

describe('distance chip (decision i-7)', () => {
  const grid = { utm_zone: 13, center_e: 0, center_n: 0 }
  // a ~2 km square around the reported location, in the fire's local metres (x east, z south)
  const g = (() => {
    const [cx, cz] = lonLatToLocal(willow.lon, willow.lat, { utm_zone: 13, center_e: 400000, center_n: 4340000 })
    return { grid: { utm_zone: 13, center_e: 400000, center_n: 4340000 }, cx, cz }
  })()
  const square: Pick<Perimeter, 'rings'> = {
    rings: [
      [
        [g.cx - 1000, g.cz - 1000],
        [g.cx + 1000, g.cz - 1000],
        [g.cx + 1000, g.cz + 1000],
        [g.cx - 1000, g.cz + 1000],
        [g.cx - 1000, g.cz - 1000],
      ],
    ],
  }

  it('measures to the newest perimeter’s nearest edge and says so', () => {
    // about 20 mi south-west of the fire
    const me = { lat: willow.lat - 0.2, lon: willow.lon - 0.25 }
    const d = distanceToFire(me, { perimeter: square, grid: g.grid, reported: willow })
    expect(d?.to).toBe('edge')
    expect(d?.inside).toBe(false)
    const toReported = distanceToFire(me, { perimeter: null, grid: null, reported: willow })
    expect(toReported?.to).toBe('reported')
    // the edge is closer than the reported location at the square's centre
    expect((d?.meters ?? 0) < (toReported?.meters ?? 0)).toBe(true)
    const t = distanceChipText(d!, 'us', 'Oct 23')
    expect(t.direction).toBe('northeast of you')
    expect(t.unit).toBe('mi')
    expect(t.measures).toBe('to the mapped edge, Oct 23 perimeter')
    expect(t.spoken).toMatch(/^The fire is \d+(\.\d)? mi northeast of you, to the mapped edge, Oct 23 perimeter\.$/)
    expect(distanceChipText(toReported!, 'metric', null).measures).toBe('to the reported location, not its edge')
    expect(distanceChipText(toReported!, 'metric', null).unit).toBe('km')
  })

  it('says when the viewer is inside the mapped area, without a safety word', () => {
    const d = distanceToFire({ lat: willow.lat, lon: willow.lon }, { perimeter: square, grid: g.grid, reported: willow })
    expect(d?.inside).toBe(true)
    const t = distanceChipText(d!, 'us', 'Oct 23')
    expect(t.spoken).toBe('Your location is inside the mapped fire area (Oct 23 perimeter).')
    for (const s of Object.values(t)) expect(String(s)).not.toMatch(/safe|low risk/i)
    expect(grid).toBeTruthy()
  })

  it('needs a perimeter or a reported location', () => {
    expect(distanceToFire({ lat: 1, lon: 1 }, { perimeter: null, grid: null, reported: null })).toBeNull()
  })
})

describe('map key (decision i-3)', () => {
  it('names the perimeter’s source and own time; a live fire’s day-old perimeter is stale', () => {
    const k = perimeterKey({ t_ms: NOW - 30 * 3_600_000, source: 'NIFC WFIGS daily perimeters' }, NOW, true, TF)
    // the publisher in the key (one line), the source as the data names it in the tooltip (review DF-H34-8)
    expect(k.text).toBe('Latest perimeter · NIFC WFIGS')
    expect(k.source).toBe('NIFC WFIGS daily perimeters')
    expect(k.time).toMatch(/^Oct 23, .* MDT$/)
    expect(k.age).toBe('30 h ago')
    expect(k.stale).toBe(true)
    const past = perimeterKey({ t_ms: Date.UTC(2025, 9, 5, 20, 23), source: 'NIFC WFIGS' }, NOW, false, timeFmt('America/Los_Angeles', '12h'))
    expect(past.time).toBe('Oct 5, 2025 1:23 PM PDT')
    expect(past.age).toBeNull()
    expect(past.stale).toBe(false)
  })
})

describe('facts (decision i-1, i-2: verbatim, own times, never N/A)', () => {
  it('lists the record rows in the screen’s order', () => {
    const rows = fireFacts(input())
    expect(rows.map((r) => r.key)).toEqual(['burned', 'contained', 'started', 'reported', 'fire-weather', 'evacuation', 'updated'])
    expect(rows[0]).toMatchObject({ value: '7,359', unit: 'ac', label: 'Burned', size: 26 })
    expect(rows[1]).toMatchObject({ value: '92', unit: '%', label: 'Contained' })
    expect(rows[2]).toMatchObject({ value: 'Jun 28', label: 'Started' })
    expect(rows[3]).toMatchObject({ value: '39.234°N, 106.440°W', label: 'Reported' })
    expect(rows[6]).toMatchObject({ value: 'Oct 22', unit: '1:28 PM MDT', label: 'Last official update' })
  })

  it('says "None in effect" and "Not available in this state", never N/A, and never an all-clear', () => {
    const rows = fireFacts(input())
    const fwRow = rows.find((r) => r.key === 'fire-weather')!
    expect(fwRow).toMatchObject({ value: 'None in effect', label: 'Red Flag Warning (NWS)' })
    expect(fwRow.sub).toContain('not an all-clear')
    expect(fwRow.sub).toContain('checked 2 min ago')
    const ev = rows.find((r) => r.key === 'evacuation')!
    // the state is in the label; the sub-line does not repeat the value (review DF-H34-10 / R8)
    expect(ev).toMatchObject({ value: 'Not available in this state', label: 'Evacuation zones (CO)' })
    expect(ev.sub).toBe('follow local officials')
    for (const r of rows) expect(`${r.value} ${r.sub ?? ''}`).not.toMatch(/\bN\/A\b|\bsafe\b|low risk/i)
  })

  it('quotes an NWS alert in effect with its own end time and issuer', () => {
    const alert = { id: 'a', event: 'Red Flag Warning', senderName: 'National Weather Service Grand Junction CO', headline: '', url: 'https://alerts.weather.gov/x', archived: false, phase: 'active', timeText: 'until Oct 25, 6:00 PM MDT', coversReportedLocation: true, nearestKm: 0, ugcs: [], bounds: null } as OfficialAlert
    const row = fireFacts(input({ fireWeather: fw({ state: 'active', alerts: [alert] }) })).find((r) => r.key === 'fire-weather')!
    expect(row).toMatchObject({ value: 'In effect', label: 'Red Flag Warning (NWS)', tone: 'alert' })
    expect(row.sub).toContain('until Oct 25, 6:00 PM MDT')
    expect(row.sub).toContain('NWS Grand Junction CO')
    expect(row.link?.url).toBe('https://alerts.weather.gov/x')
  })

  it('shows evacuation zones verbatim with their issuer, and none listed is not an all-clear', () => {
    const zone = { id: 'z', status: 'Evacuation Order', group: 'order' as const, issuer: 'Lake County', updatedMs: NOW - 3_600_000, distanceKm: 0, outsideAnalysisArea: false, name: 'Z1', message: null }
    const listed = fireFacts(input({ evacuation: evac({ state: 'listed', zones: [zone], checkedBy: 'Cal OES', sources: [] }) })).find((r) => r.key === 'evacuation')!
    expect(listed).toMatchObject({ value: 'Evacuation Order', tone: 'alert' })
    expect(listed.sub).toContain('Lake County')
    expect(listed.sub).toContain('updated Oct 24')
    const none = fireFacts(input({ evacuation: evac({ state: 'none-listed', checkedBy: 'Oregon OEM', checkedMs: NOW - 60_000 }) })).find((r) => r.key === 'evacuation')!
    expect(none.value).toBe('None listed')
    expect(none.sub).toContain('Oregon OEM')
    expect(none.sub).toContain('not an all-clear')
  })

  it('adds local officials’ alerts only while one is in effect', () => {
    expect(fireFacts(input()).some((r) => r.key === 'local')).toBe(false)
    const local = { key: 'local' as const, label: "Local officials' alerts", text: 'Alert from Lake County: “Leave now” · sent Oct 24, 9:00 AM MDT', source: null, tone: 'order' as const, link: { url: 'https://example.gov/a', label: 'Lake County' } }
    const row = fireFacts(input({ local })).find((r) => r.key === 'local')!
    expect(row.sub).toContain('“Leave now”')
    expect(row.link?.url).toBe('https://example.gov/a')
  })

  it('takes the record endpoint’s figures over the list row, and says when a figure is not given', () => {
    expect(recordFigures({ summary: willow, record: record({ state: 'available', acres: 8000, percentContained: 95, updatedMs: NOW }) })).toEqual({ acres: 8000, contained: 95, updatedMs: NOW })
    expect(recordFigures({ summary: willow, record: record() })).toEqual({ acres: 7359, contained: 92, updatedMs: willow.updated_ms })
    const rows = fireFacts(input({ summary: { ...willow, acres: null, percent_contained: null, updated_ms: null } }))
    expect(rows[0]).toMatchObject({ value: 'Not given', size: 17 })
    expect(rows.find((r) => r.key === 'updated')?.value).toBe('No update time given')
  })

  it('names the sources with the latest check, OFFICIAL only for an agency record', () => {
    const src = factsSource(input({ record: record({ checkedMs: NOW - 120_000, url: 'https://example.gov/record', source: 'wfigs' }) }))
    expect(src.badge).toBe('official')
    expect(src.line).toBe('USFS via NIFC WFIGS · NWS · checked 2 min ago')
    expect(src.link).toEqual({ url: 'https://example.gov/record', label: 'NIFC WFIGS' })
    expect(factsSource(input({ demo: true })).badge).toBe('demo')
  })
})

describe('review fixes (H3+H4 fix)', () => {
  it('keeps only a further explanation of "Not available in this state" (DF-H34-10, R8)', () => {
    const v = 'Not available in this state'
    expect(evacReasonRest('Not available in this state (Washington)', v)).toBeNull()
    expect(evacReasonRest('Not available in this state', v)).toBeNull()
    expect(evacReasonRest('Not available in this state (Oregon): the state feed is offline', v)).toBe('the state feed is offline')
    expect(evacReasonRest('The state has no public zone feed', v)).toBe('The state has no public zone feed')
    expect(evacReasonRest(null, v)).toBeNull()
  })

  it('shows the update row’s year whenever the start shows one or the years differ (DF-H34-9)', () => {
    const tz = 'America/Los_Angeles'
    const start = Date.UTC(2025, 8, 1, 16)
    const may7 = Date.UTC(2026, 4, 7, 18, 53)
    expect(updateYear(start, may7, NOW, tz)).toBe('always')
    // a fire of this year, updated this year: no year needed
    expect(updateYear(JUN28, Date.UTC(2026, 9, 22), NOW, tz)).toBe('auto')
    expect(updateYear(null, may7, NOW, tz)).toBe('auto')
    const rows = fireFacts(input({ summary: { ...pastFire, updated_ms: may7 }, tf: timeFmt(tz, '12h') }))
    expect(rows.find((r) => r.key === 'started')?.value).toBe('Sep 1, 2025')
    expect(rows.find((r) => r.key === 'updated')?.value).toBe('May 7, 2026')
  })

  it('never says "Fire fire" (R9)', () => {
    expect(fireLabel('Willow')).toBe('Willow fire')
    expect(fireLabel('Cedar Canyon Fire')).toBe('Cedar Canyon Fire')
    expect(fireLabel('Eaton fire')).toBe('Eaton fire')
    expect(fireLabel('Firestone')).toBe('Firestone fire')
  })

  it('names the perimeter’s publisher in the key (DF-H34-8)', () => {
    expect(shortPerimeterSource('NIFC WFIGS daily perimeters (final extent, mapped 2025-01-31)')).toBe('NIFC WFIGS')
    expect(shortPerimeterSource('NIFC WFIGS daily perimeter (fixture)')).toBe('NIFC WFIGS')
    expect(shortPerimeterSource('NIFC WFIGS')).toBe('NIFC WFIGS')
    expect(shortPerimeterSource('CAL FIRE perimeter')).toBe('CAL FIRE')
    expect(shortPerimeterSource('(fixture)')).toBe('(fixture)')
  })
})
