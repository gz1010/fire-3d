// Brief 2 additions to the feed model (official-web): filters, day groups of satellite passes, the live quiet-period
// row, official seeking rules, Public wording.
import { describe, expect, it } from 'vitest'
import type { IncidentManifest } from '../../api/types'
import { extendFeedBaseline, feedBaseline, filterFeed, groupPassesByDay, isLaterItem, isNewFeedItem, plainRuns, quietItem, seekTarget } from './feedModel'
import type { FeedItem } from './types'
import { timeFmt } from '../../lib/time'

const H = 3_600_000
const DAY0 = Date.UTC(2026, 9, 16, 15) // Oct 16, 2026 08:00 PDT
const LA24 = timeFmt('America/Los_Angeles', '24h')
const LA12 = timeFmt('America/Los_Angeles', '12h')
const DEN24 = timeFmt('America/Denver', '24h')
const item = (id: string, tMs: number, extra: Partial<FeedItem> = {}): FeedItem => ({
  id,
  topic: 'detection',
  kind: 'observation',
  tMs,
  title: 'Satellite pass: 3 heat detections',
  detail: null,
  source: 'NASA FIRMS (VIIRS, NOAA-20)',
  automated: true,
  key: false,
  confidence: 'observed',
  location: null,
  seekable: true,
  eventId: null,
  facts: [{ label: 'Heat detections', text: '3', scientific: null }],
  ...extra,
})

describe('filters', () => {
  it('Official keeps only official items; Key events keeps key items; All keeps everything', () => {
    const items = [item('a', 1), item('b', 2, { kind: 'official', key: true, topic: 'calfire' }), item('c', 3, { key: true, kind: 'estimate', topic: 'rapid_growth' })]
    expect(filterFeed(items, 'official').map((i) => i.id)).toEqual(['b'])
    expect(filterFeed(items, 'key').map((i) => i.id)).toEqual(['b', 'c'])
    expect(filterFeed(items, 'all')).toHaveLength(3)
  })
})

describe('satellite passes grouped per day (live)', () => {
  it("makes one row per Pacific day with each pass in it, says 'today', and keeps single passes as they are", () => {
    const passes = [item('p1', DAY0), item('p2', DAY0 + 2 * H, { facts: [{ label: 'Heat detections', text: '1,200', scientific: null }] }), item('p3', DAY0 + 30 * H)]
    const g = groupPassesByDay(passes, DAY0 + 3 * H, LA24)
    expect(g).toHaveLength(2)
    const day = g.find((x) => x.children)!
    expect(day).toMatchObject({ id: `passes:${Date.UTC(2026, 9, 16, 7)}`, title: 'Satellite passes today: 2', tMs: DAY0 + 2 * H, seekable: true, automated: true })
    expect(day.children!.map((c) => c.id)).toEqual(['p2', 'p1'])
    expect(day.detail).toMatch(/^1,203 heat detections in 2 passes \(VIIRS, NOAA-20\), newest 10:00 PDT\./)
    expect(groupPassesByDay(passes, DAY0 + 48 * H, LA24).find((x) => x.children)!.title).toBe('Satellite passes on Oct 16: 2')
    expect(g.find((x) => x.id === 'p3')).toBeDefined()
  })

  it('marks a day "new" when it holds a pass that arrived after the page loaded', () => {
    const before = groupPassesByDay([item('p1', DAY0), item('p2', DAY0 + H)], null, LA24)
    const b = feedBaseline('fire', before)
    expect(b.ids.has('p1')).toBe(true)
    const after = groupPassesByDay([item('p1', DAY0), item('p2', DAY0 + H), item('p3', DAY0 + 2 * H)], null, LA24)
    expect(isNewFeedItem(b, 'fire', after[0], true)).toBe(true)
    expect(isNewFeedItem(b, 'fire', before[0], true)).toBe(false)
    expect(extendFeedBaseline(b, after)).toBeNull()
  })
})

describe('quiet-period row (live)', () => {
  const m = (det: number | undefined, pass: number | undefined, mode: 'live' | 'historical' = 'live') => ({ mode, time_range: { start_ms: 0, end_ms: 0, now_ms: 0, last_detection_ms: det, last_pass_ms: pass } }) as Pick<IncidentManifest, 'mode' | 'time_range'>

  it('says satellites saw no new heat since the last detection when later passes saw none; never an all-clear', () => {
    const q = quietItem(m(DAY0, DAY0 + 5 * H), DAY0 + 6 * H, undefined, LA24)!
    expect(q.title).toBe('No new heat seen by satellites since Oct 16, 08:00 PDT')
    expect(q.detail).toMatch(/^Later satellite passes \(the newest at Oct 16, 13:00 PDT\) saw no new heat over the fire\. Smoke, cloud or smoldering can hide fire; this is not an all-clear\.$/)
    expect(q).toMatchObject({ kind: 'observation', automated: true, seekable: false, tMs: DAY0 + 5 * H, topic: 'quiet' })
  })

  it('says how old the newest detection is when no later pass is known, and stays silent otherwise', () => {
    expect(quietItem(m(DAY0, undefined), DAY0 + 7 * H, undefined, LA24)!.title).toBe('No new satellite heat detection since Oct 16, 08:00 PDT')
    expect(quietItem(m(DAY0, DAY0 + 5 * 60_000), DAY0 + 2 * H)).toBeNull() // recent, no later pass
    expect(quietItem(m(DAY0, DAY0 + 5 * H, 'historical'), DAY0 + 6 * H)).toBeNull()
    expect(quietItem(m(undefined, DAY0), DAY0 + 6 * H)).toBeNull()
  })

  it("uses the fire's own zone and the preset's clock (brief 3, never Pacific by default)", () => {
    expect(quietItem(m(DAY0, undefined), DAY0 + 7 * H, undefined, LA12)!.title).toBe('No new satellite heat detection since Oct 16, 8:00 AM PDT')
    expect(quietItem(m(DAY0, undefined), DAY0 + 7 * H, undefined, DEN24)!.title).toBe('No new satellite heat detection since Oct 16, 09:00 MDT')
    // a Mountain-time day starts at 06:00 UTC: passes at 05:00 and 07:00 UTC fall on two local days
    const g = groupPassesByDay([item('a', Date.UTC(2026, 9, 17, 5)), item('b', Date.UTC(2026, 9, 17, 7)), item('c', Date.UTC(2026, 9, 17, 8))], null, DEN24)
    expect(g.find((x) => x.children)!.title).toBe('Satellite passes on Oct 17: 2')
  })
})

describe('official seeking rules (U-R5)', () => {
  const bounds = { startMs: 0, endMs: 100 }
  const observed = { startMs: 0, endMs: 60 }
  it('official rows seek only inside the observed record; others are clamped to the timeline; status rows never seek', () => {
    expect(seekTarget({ seekable: true, tMs: 50, kind: 'official' }, bounds, observed)).toBe(50)
    expect(seekTarget({ seekable: true, tMs: 70, kind: 'official' }, bounds, observed)).toBeNull() // would land in the forecast
    expect(seekTarget({ seekable: true, tMs: 70, kind: 'observation' }, bounds, observed)).toBe(70)
    expect(seekTarget({ seekable: true, tMs: 170, kind: 'model' }, bounds, observed)).toBe(100)
    expect(seekTarget({ seekable: false, tMs: 50, kind: 'official' }, bounds, observed)).toBeNull()
  })

  it('live official rows after the latest observation are never dimmed "later"', () => {
    expect(isLaterItem({ tMs: 90, seekable: false }, 60, true)).toBe(false)
    expect(isLaterItem({ tMs: 90, seekable: false }, 60, false)).toBe(true) // replay: current status is not history
  })

  it('Public names the ensemble in plain words', () => {
    expect(plainRuns(31, 'gfs025')).toBe('31 simulated fires, each with slightly different weather')
    expect(plainRuns(1, 'none')).toBe('one simulated fire with one weather series')
  })
})
