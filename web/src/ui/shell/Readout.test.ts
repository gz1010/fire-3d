// "value unit — LABEL" readout rows (brief 4, CONTRACT §15.2).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReadoutRow } from './Readout'

const text = (h: string) => h.replace(/<[^>]+>/g, '')

describe('ReadoutRow', () => {
  it('class by size and tone', () => {
    const cls = (p: Partial<Parameters<typeof ReadoutRow>[0]>) => renderToStaticMarkup(createElement(ReadoutRow, { value: '1', label: 'X', ...p })).match(/^<div class="([^"]+)"/)?.[1]
    expect(cls({})).toBe('ro-row ro-22')
    expect(cls({ size: 26, tone: 'stale' })).toBe('ro-row ro-26 is-stale')
    expect(cls({ size: 17, tone: 'official' })).toBe('ro-row ro-17 is-official')
  })

  it('value, unit, then "— LABEL" (the label is upper-cased by CSS, the text keeps its case)', () => {
    const h = renderToStaticMarkup(createElement(ReadoutRow, { value: '7,359', unit: 'ac', label: 'Burned' }))
    expect(h).toContain('<div class="ro-row ro-22">')
    expect(h).toContain('<span class="ro-value">7,359<span class="ro-unit">ac</span></span><span class="ro-label">— Burned</span>')
    expect(h).not.toContain('ro-copy')
    expect(h).not.toContain('ro-sub')
  })

  it('a copy button named after the label, and a sub line', () => {
    const h = renderToStaticMarkup(createElement(ReadoutRow, { value: '2026-willow-548a8d', label: 'Incident ID', size: 17, copy: '2026-willow-548a8d', sub: 'NIFC WFIGS' }))
    expect(h).toContain('aria-label="Copy incident id"')
    expect(h).toContain('<div class="ro-sub">NIFC WFIGS</div>')
    expect(text(h)).toContain('2026-willow-548a8d— Incident ID')
  })
})
