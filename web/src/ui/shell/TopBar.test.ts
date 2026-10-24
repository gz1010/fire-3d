// The floating top bar family (brief 4, CONTRACT §15.2): slots, the view pill's checked view, LIVE / year, icon pills
// (label = accessible name and tooltip, on state), the status line's stale part, the place line.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorkspace } from '../../state/workspace'
import { restoreSsrState, ssrState } from '../ssr.testutil'
import { BackButton, IconPill, LiveDot, TopBar, TopBarPlace, TopBarStatus, ViewPill } from './TopBar'
import { placeLine, statusSegments } from './topBarText'

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')

afterEach(() => restoreSsrState())

describe('TopBar', () => {
  it('renders a header with left / centre / right slots and passes extra props to its root', () => {
    const h = html(createElement(TopBar, { left: 'L', centre: 'C', right: 'R', className: 'mw-header', 'data-chrome': 'header' } as Parameters<typeof TopBar>[0]))
    expect(h).toMatch(/^<header class="tb tb-inset-map mw-header" data-chrome="header">/)
    expect(h).toContain('<div class="tb-side tb-left">L</div><div class="tb-centre">C</div><div class="tb-side tb-right">R</div>')
  })

  it('omits the centre slot when there is none; Forensic inset', () => {
    const h = html(createElement(TopBar, { left: 'L', inset: 'forensic' }))
    expect(h).toContain('class="tb tb-inset-forensic"')
    expect(h).not.toContain('tb-centre')
  })
})

describe('ViewPill', () => {
  it('checks the current view: Command preset in the map workspace', () => {
    ssrState(useWorkspace, { workspace: 'map', preset: 'command' })
    const h = html(createElement(ViewPill))
    expect(h).toContain('role="radiogroup"')
    expect(text(h)).toBe('PublicCommandForensic')
    expect(h).toMatch(/aria-checked="true" class="tb-view-btn"[^>]*>Command</)
    expect(h.match(/aria-checked="true"/g)).toHaveLength(1)
  })

  it('Forensic is checked in the Forensic workspace whatever the preset; small size', () => {
    ssrState(useWorkspace, { workspace: 'forensic', preset: 'public' })
    const h = html(createElement(ViewPill, { size: 'sm' }))
    expect(h).toContain('tb-view tb-view-sm')
    expect(h).toMatch(/aria-checked="true" class="tb-view-btn"[^>]*>Forensic</)
  })
})

describe('LiveDot', () => {
  it('LIVE for a live fire, the year otherwise, nothing without either', () => {
    expect(text(html(createElement(LiveDot, { live: true, year: 2026 })))).toBe('LIVE')
    expect(html(createElement(LiveDot, { live: false, year: 2025 }))).toBe('<span class="tb-year">2025</span>')
    expect(html(createElement(LiveDot, { live: false, year: null }))).toBe('')
  })
})

describe('IconPill and BackButton', () => {
  it('the label is the accessible name (hidden text) and the tooltip; expanded marks it on', () => {
    const h = html(createElement(IconPill, { icon: null, label: 'Layers', tip: 'Layers, basemap', expanded: true, onClick: () => undefined, 'data-panel-toggle': 'layers' } as Parameters<typeof IconPill>[0]))
    expect(h).toContain('class="tb-icon is-on"')
    expect(h).toContain('aria-expanded="true"')
    expect(h).toContain('data-tip="Layers, basemap"')
    expect(h).toContain('data-panel-toggle="layers"')
    expect(h).toContain('<span class="tb-label">Layers</span>')
    expect(h).not.toContain('aria-pressed')
  })

  it('off when neither pressed nor expanded; the tooltip defaults to the label', () => {
    const h = html(createElement(IconPill, { icon: null, label: 'Analysis', pressed: false, onClick: () => undefined }))
    expect(h).toContain('class="tb-icon"')
    expect(h).toContain('aria-pressed="false"')
    expect(h).toContain('data-tip="Analysis"')
  })

  it('back button: round, labelled "Back to all fires" by default', () => {
    const h = html(createElement(BackButton, { onClick: () => undefined }))
    expect(h).toContain('class="tb-icon tb-back"')
    expect(h).toContain('aria-label="Back to all fires"')
  })
})

describe('status line', () => {
  it('marks the parts from staleFrom on as stale and drops empty parts', () => {
    expect(statusSegments(['VIIRS NOAA', '375 M', '6.2 H AGO'], 2)).toEqual([
      { text: 'VIIRS NOAA', stale: false },
      { text: '375 M', stale: false },
      { text: '6.2 H AGO', stale: true },
    ])
    expect(statusSegments(['A', ' ', 'B'])).toEqual([
      { text: 'A', stale: false },
      { text: 'B', stale: false },
    ])
  })

  it('renders the parts with grey separators; a button when clickable; nothing when empty', () => {
    const h = html(createElement(TopBarStatus, { parts: ['VIIRS NOAA', '6.2 H AGO'], staleFrom: 1 }))
    expect(text(h)).toBe('VIIRS NOAA · 6.2 H AGO')
    expect(h).toContain('<span class="is-stale">6.2 H AGO</span>')
    expect(html(createElement(TopBarStatus, { parts: ['X'], onClick: () => undefined }))).toMatch(/^<button type="button" class="tb-status is-button"/)
    expect(html(createElement(TopBarStatus, { parts: [] }))).toBe('')
  })
})

describe('place', () => {
  it("the record's location, else '<County> County, <State>', else the state", () => {
    expect(placeLine({ location: 'Leadville', county: 'Lake', state: 'CO' })).toBe('Leadville')
    expect(placeLine({ location: null, county: 'Chelan', state: 'WA' })).toBe('Chelan County, Washington')
    expect(placeLine({ location: '  ', county: null, state: 'OR' })).toBe('Oregon')
    expect(placeLine({ location: null, county: null, state: null })).toBeNull()
    expect(placeLine(null)).toBeNull()
  })

  it('renders the place and an optional date', () => {
    expect(text(html(createElement(TopBarPlace, { place: 'Lake County', date: 'Jun 28, 2026 – present' })))).toBe('Lake County · Jun 28, 2026 – present')
    expect(html(createElement(TopBarPlace, { place: null }))).toBe('')
  })
})
