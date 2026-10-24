// Command's left readout (brief 4, CommandView.dc.html; PLAN-4 §3.2): the "value — LABEL" rows come from the agency
// record only (official values, the issuer named in the label when the bundle used that agency's record, the record's
// own time), with the reported location and the incident identifier (copy buttons); without a selected point the
// readout says how to pick one and keeps the rows. Demo, synthetic or local data never carries an issuer (review H2-B3).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import type { IncidentManifest } from '../api/types'
import { makeManifest, ZONE11 } from './fixtures.testutil'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { restoreSsrState, ssrState } from '../ui/ssr.testutil'
import { CommandReadout, RecordRows } from './CommandReadout'

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

afterEach(() => restoreSsrState())

/** A bundle built from an agency's incident record (CAL FIRE in California, the NIFC WFIGS record elsewhere). */
const withRecord = (id: string, record: string): IncidentManifest => {
  const m = makeManifest({ ...ZONE11, id })
  return { ...m, data_sources: [{ name: record, detail: 'incident record', fetched_ms: 0 }, ...m.data_sources] }
}

describe("Command readout rows (brief 4)", () => {
  it('shows the agency record as "value — LABEL" rows with the issuer and the record time', () => {
    const s = summaryFixture()
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: withRecord(s.id, 'CAL FIRE incidents') })
    const html = renderToStaticMarkup(createElement(RecordRows))
    const t = text(html)
    expect(t).toContain('1,234 ac — Burned')
    expect(t).toContain('40 % — Contained')
    expect(t).toMatch(/Jul 3, 2025,? 11:00( AM)? PDT — Record updated · CAL FIRE/)
    expect(t).toContain('34.20000° N · 118.10000° W')
    expect(t).toContain('— Reported location · CAL FIRE')
    expect(t).toContain(`${s.id} — Incident ID`)
    // copy buttons for the reported coordinates and the identifier; centre the map on the reported location
    expect(html).toContain('aria-label="Copy reported incident coordinates"')
    expect(html).toContain('aria-label="Copy incident id"')
    expect(html).toContain('aria-label="Center the map on the reported incident location"')
    // official values only: no model output in the rows
    expect(t).not.toMatch(/model|forecast|experimental/i)
  })

  it('says "Not given" for a missing figure and names a NIFC WFIGS issuer', () => {
    const s = wfigsSummaryFixture({ acres: null, percent_contained: null })
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: withRecord(s.id, 'NIFC WFIGS incident record (IRWIN)') })
    const t = text(renderToStaticMarkup(createElement(RecordRows)))
    expect(t).toContain('Not given — Burned')
    expect(t).toContain('Not given — Contained')
    expect(t).toMatch(/— Record updated · .*NIFC WFIGS/)
  })

  it('names no issuer for demo, synthetic or local data, or before the bundle says where the record came from', () => {
    // fixture-live: a demo bundle whose summary still names CAL FIRE
    const s = summaryFixture({ id: 'fixture-live' })
    const synthetic = { ...makeManifest({ ...ZONE11, id: 'fixture-live' }), data_sources: [{ name: 'Fire observations (synthetic)', detail: '', fetched_ms: 0 }] }
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: synthetic })
    const t = text(renderToStaticMarkup(createElement(RecordRows)))
    expect(t).not.toContain('CAL FIRE')
    expect(t).toMatch(/— Record updated(?! ·)/)
    expect(t).toContain('— Reported location (incident data)')
    expect(t).toContain('Demo data: a simulated fire, not an agency record.')
    // a real fire whose bundle did not use the agency record (or is not loaded yet): plain labels
    const r = summaryFixture()
    ssrState(useStore, { incidentId: r.id, summary: r, manifest: null })
    const t2 = text(renderToStaticMarkup(createElement(RecordRows)))
    expect(t2).not.toContain('· CAL FIRE')
    expect(t2).toContain('— Reported location (incident data)')
  })

  it('waits for the record of the open fire and shows nothing without a fire', () => {
    const s = summaryFixture()
    ssrState(useStore, { incidentId: 'another-fire', summary: s, manifest: null })
    const t = text(renderToStaticMarkup(createElement(RecordRows)))
    expect(t).toContain('Loading the agency record…')
    expect(t).toContain('another-fire — Incident ID')
    ssrState(useStore, { incidentId: null, summary: null })
    expect(renderToStaticMarkup(createElement(RecordRows))).toBe('')
  })

  it('without a selected point: how to pick one, then the rows', () => {
    const s = summaryFixture()
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: null })
    ssrState(useWorkspace, { selection: null })
    const html = renderToStaticMarkup(createElement(CommandReadout))
    const t = text(html)
    expect(t).toContain('Selected point')
    expect(t).toContain('Click the map or search to select a point')
    expect(t).toContain('— Burned')
    expect(html).toContain('aria-labelledby="cro-title"')
  })
})
