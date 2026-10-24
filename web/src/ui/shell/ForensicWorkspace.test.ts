// Forensic with no fire focused ("Zoom in on a fire or pick one"): like every view it keeps the fixed copy (BRIEF-4
// standing rules, CONTRACT §15.4), "Research prototype — not for operational use" and "Not an all-clear. Follow
// local officials.", outside the fire list (review H5-M1 / H5-DF-2: it used to show only the list's own footer).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { restoreSsrState, ssrState } from '../ssr.testutil'
import ForensicWorkspace from './ForensicWorkspace'
import { NOT_ALL_CLEAR, PROTOTYPE_LINE } from './fixedCopy'

const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const text = (h: string) => decode(h.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ')

afterEach(() => restoreSsrState())

describe('Forensic, no fire open', () => {
  it('shows the prototype line and "Not an all-clear" in a footer of its own, after the list', () => {
    ssrState(useStore, { incidentId: null, summary: null })
    ssrState(useWorkspace, { fireCardId: null, workspace: 'forensic' })
    const html = renderToStaticMarkup(createElement(ForensicWorkspace))
    expect(text(html)).toContain('Zoom in on a fire or pick one')
    const foot = html.slice(html.indexOf('<footer class="fx-empty-foot"'))
    expect(foot.length).toBeLessThan(html.length)
    expect(text(foot)).toContain(`${PROTOTYPE_LINE} · ${NOT_ALL_CLEAR}`)
    // the footer comes after the list's panel, not inside it
    expect(html.indexOf('<footer class="fx-empty-foot"')).toBeGreaterThan(html.indexOf('</main>'))
  })
})
