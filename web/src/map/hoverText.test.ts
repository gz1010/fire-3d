// Map hover texts that carry official information (CONTRACT §14.5, §14.8.5): a fire record keeps its own issuer,
// status and time (the Timber Fire: CAL FIRE's line never says "Active" when only NIFC does), and an evacuation zone
// names the state source it came through from the answer's `sources[]` (Cal OES in California, Oregon OEM in Oregon).
import { describe, expect, it } from 'vitest'
import { otherRecordFixture, summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import { EVAC_SAMPLE } from '../extras/__fixtures__/samples'
import { OR_EVAC_MEDFORD } from '../extras/__fixtures__/samplesUs'
import { timeFmt } from '../lib/time'
import { recordHoverLines, zoneHoverLines } from './hoverText'

const LA12 = timeFmt('America/Los_Angeles', '12h') // tz-ok: a California fire's own zone
const NOW = Date.UTC(2026, 9, 23, 3, 0)
const texts = (lines: { text: string }[]) => lines.map((l) => l.text)

const timber = summaryFixture({
  id: '2026-timber-fire-51374d',
  name: 'Timber Fire',
  mode: 'live',
  year: 2026,
  is_active: true,
  acres: 25_352,
  percent_contained: 97,
  updated_ms: Date.UTC(2026, 9, 20, 17, 0),
  active_sources: ['wfigs'],
  other_records: [otherRecordFixture({ name: 'Timber', is_active: true, updated_ms: Date.UTC(2026, 9, 22, 16, 5) })],
})

describe('recordHoverLines (§14.5)', () => {
  it("the Timber Fire: CAL FIRE's own status, then NIFC's record with its own issuer and time", () => {
    const t = texts(recordHoverLines(timber, 'us', LA12, NOW))
    expect(t).toContain('CAL FIRE (official): 25,352 acres · 97 % contained · Not listed as active')
    expect(t.join('\n')).not.toMatch(/CAL FIRE \(official\):[^\n]*· Active/)
    expect(t).toContain('Updated Oct 20, 10:00 AM PDT')
    expect(t).toContain('Timber: Active (USFS via NIFC WFIGS, updated Oct 22, 9:05 AM PDT)')
  })

  it('agencies that agree: one record, its own status', () => {
    const t = texts(recordHoverLines({ ...timber, active_sources: ['calfire', 'wfigs'] }, 'us', LA12, NOW))
    expect(t).toContain('CAL FIRE (official): 25,352 acres · 97 % contained · Active')
    expect(t.join('\n')).not.toContain('NIFC')
  })

  it('a NIFC WFIGS fire in its own zone, contained; a past year is written out', () => {
    const t = texts(recordHoverLines(wfigsSummaryFixture(), 'us', timeFmt('America/Denver', '24h'), NOW))
    expect(t[0]).toBe('Lewis and Clark Co., MT')
    expect(t).toContain('USFS (USDA Forest Service) via NIFC WFIGS (official): 9,450 acres · 100 % contained · Contained')
    expect(t).toContain('Updated Aug 2, 2024 09:30 MDT')
  })
})

describe('zoneHoverLines (§14.8.5)', () => {
  it('a California zone: "via Cal OES"', () => {
    const z = EVAC_SAMPLE.zones.features[0]
    const t = zoneHoverLines(z, EVAC_SAMPLE, EVAC_SAMPLE.now_ms, LA12)
    expect(t[0].cls).toBe('fxm-tip-title')
    expect(t[3].text).toBe('Official status from local officials via Cal OES. Fire-3d forecasts are not evacuation instructions.')
  })

  it('an Oregon zone: "via Oregon OEM", never Cal OES', () => {
    const z = OR_EVAC_MEDFORD.zones.features[0]
    const t = texts(zoneHoverLines(z, OR_EVAC_MEDFORD, OR_EVAC_MEDFORD.now_ms, LA12))
    expect(t[3]).toBe('Official status from local officials via Oregon OEM. Fire-3d forecasts are not evacuation instructions.')
    expect(t.join('\n')).not.toContain('Cal OES')
  })
})
