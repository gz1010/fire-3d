// Fixed copy every view keeps (brief 4, CONTRACT §15.4): exact strings and the variants' follow-up text.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LIST_ABSENCE } from '../../state/overview'
import { FixedCopy } from './FixedCopy'
import { defaultExtra, fixedCopyText, NOT_ALL_CLEAR, PROTOTYPE_LINE } from './fixedCopyText'

const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")

describe('fixed copy', () => {
  it('keeps the exact strings', () => {
    expect(PROTOTYPE_LINE).toBe('Research prototype — not for operational use')
    expect(NOT_ALL_CLEAR).toBe('Not an all-clear. Follow local officials.')
  })

  it('variant defaults: Main adds the list-absence sentence, Command and Forensic "not an all-clear", the fire bar nothing', () => {
    expect(defaultExtra('line')).toBe(LIST_ABSENCE)
    expect(defaultExtra('corner')).toBe(NOT_ALL_CLEAR)
    expect(defaultExtra('pill')).toBe(NOT_ALL_CLEAR)
    expect(defaultExtra('bar')).toBeNull()
  })

  it('plain text per variant; null drops the follow-up, a string replaces it', () => {
    expect(fixedCopyText('line')).toBe(`Research prototype · Not for operational use. ${LIST_ABSENCE}`)
    expect(fixedCopyText('corner')).toBe(`${PROTOTYPE_LINE} · ${NOT_ALL_CLEAR}`)
    expect(fixedCopyText('pill', null)).toBe(PROTOTYPE_LINE)
    expect(fixedCopyText('bar')).toBe(PROTOTYPE_LINE)
    expect(fixedCopyText('bar', NOT_ALL_CLEAR)).toBe(`${PROTOTYPE_LINE} · ${NOT_ALL_CLEAR}`)
  })

  it('renders what fixedCopyText says, with the variant class', () => {
    for (const v of ['line', 'corner', 'bar', 'pill'] as const) {
      const h = renderToStaticMarkup(createElement(FixedCopy, { variant: v }))
      expect(h).toContain(`class="fxc fxc-${v}"`)
      expect(text(h)).toBe(fixedCopyText(v))
    }
    expect(text(renderToStaticMarkup(createElement(FixedCopy, { variant: 'pill', extra: null })))).toBe(PROTOTYPE_LINE)
  })
})
