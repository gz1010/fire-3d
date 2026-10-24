// Command's left readout (brief 4, CommandView.dc.html; PLAN-4 §3.2): the "value — LABEL" rows come from the agency
// record only (official values, the issuer named in the label, the record's own time), with the reported location and
// the incident identifier (copy buttons); without a selected point the readout says how to pick one and keeps the rows.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { summaryFixture, wfigsSummaryFixture } from '../api/fixtures.testutil'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { restoreSsrState, ssrState } from '../ui/ssr.testutil'
import { CommandReadout, RecordRows } from './CommandReadout'

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

afterEach(() => restoreSsrState())

describe("Command readout rows (brief 4)", () => {
  it('shows the agency record as "value — LABEL" rows with the issuer and the record time', () => {
    const s = summaryFixture()
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: null })
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
    ssrState(useStore, { incidentId: s.id, summary: s, manifest: null })
    const t = text(renderToStaticMarkup(createElement(RecordRows)))
    expect(t).toContain('Not given — Burned')
    expect(t).toContain('Not given — Contained')
    expect(t).toMatch(/— Record updated · .*NIFC WFIGS/)
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
