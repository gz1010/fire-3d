// The per-run skill table (V-R13, CONTRACT §14.4): growth first when the run has it, the total labelled "total-area
// overlap" with "(includes the area already burned at the start)" always visible, and tone-neutral bars only.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillTable } from './AnalysisTab'

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
const headers = (h: string) => [...h.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((m) => decode(m[1]))

const row = (lead_h: number, sorensen: number, growth?: number | null) => ({
  lead_h,
  sorensen,
  observed_acres: 1000 * lead_h,
  forecast_acres_p50: 1100 * lead_h,
  ...(growth !== undefined ? { growth_sorensen: growth } : {}),
})

describe('SkillTable (§14.4)', () => {
  it('with growth scores: Growth first, the total relabelled, the burned-at-start wording under the table, neutral bars', () => {
    const html = renderToStaticMarkup(createElement(SkillTable, { skill: [row(24, 0.82, 0.41), row(48, 0.76, null)] }))
    expect(headers(html).slice(0, 3)).toEqual(['Lead', 'Growth', 'Total-area overlap'])
    const t = text(html)
    expect(t).toContain('Total-area overlap includes the area already burned at the start.')
    expect(t).toContain('0.41')
    expect(t).not.toContain('is not stored for this run')
    // a missing growth value is a dash, never a zero
    expect(html).toMatch(/<span class="muted mono">—<\/span>/)
    // no green / amber / red verdict colours
    expect(html).not.toMatch(/tone-(good|ok|warn|bad|green|amber|red)/)
    expect((html.match(/sbar-fill tone-neutral/g) ?? []).length).toBe(3) // one growth bar + two total bars
  })

  it('without growth scores: the full total label in the header and the "not stored" note', () => {
    const html = renderToStaticMarkup(createElement(SkillTable, { skill: [row(24, 0.82), row(48, 0.76)] }))
    expect(headers(html).slice(0, 2)).toEqual(['Lead', 'Total-area overlap (includes the area already burned at the start)'])
    expect(headers(html)).not.toContain('Growth')
    expect(text(html)).toContain('The growth score (new spread only) is not stored for this run.')
    expect(html).not.toMatch(/tone-(good|ok|warn|bad|green|amber|red)/)
  })
})
