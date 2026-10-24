// Room for the fire view's facts (brief 4 H3+H4 review fix DF-H34-4). The left column is the hazard circle, then the
// official facts (FireView.dc.html). An extra row (a local officials' alert, an alert's longer source line) can make
// the facts taller than the column at 1440 × 1000; then the column goes "snug", then "tight", then "tighter", one step
// at a time while they still overflow (styles/view-public.css .pfv-left.is-snug / .is-tight / .is-tighter: less gap
// and row padding, then a smaller circle) so every row and the foot stay in view. When even that does not fit (a short window), the facts scroll under their sticky foot and
// `more` says rows are hidden below (FireFacts shows "More below").
//
// No flip-flop: the decision is taken in the normal layout and kept for the same window size and the same facts text;
// a new size or new text starts again from the normal layout (measured before paint, in a layout effect).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface FactsFit {
  /** 0 the screen's layout; 1 snug (less gap and row padding); 2 tight (+ a smaller circle); 3 tighter (smaller still). */
  level: 0 | 1 | 2 | 3
  tight: boolean
  /** Rows are hidden below the visible part of the facts (they scroll). */
  more: boolean
  /** Scroll the facts down by most of their visible height. */
  scrollMore: () => void
}

/** What the decision depends on: the window's size and the facts' words (never their laid-out height, which the tight
 *  layout itself changes). */
export function fitKey(w: number, h: number, rows: number, textLength: number): string {
  return `${w}x${h}|${rows}|${Math.round(textLength / 24)}`
}

/** Whether a scroller hides content below what it shows (a pixel of rounding is not "more"). */
export function hiddenBelow(scrollHeight: number, clientHeight: number, scrollTop: number): boolean {
  return scrollHeight - clientHeight - scrollTop > 4
}

/** The words that decide the facts' height: the rows and the map-data note (not the "More below" cue, which comes and
 *  goes with the decision, nor the "checked … ago" source line). */
const wordsOf = (el: HTMLElement) => [...el.querySelectorAll('.pfv-facts-rows, .pfv-prep')].reduce((n, e) => n + (e.textContent ?? '').length, 0)
const keyOf = (el: HTMLElement) => fitKey(window.innerWidth, window.innerHeight, el.querySelectorAll('.ro-row').length, wordsOf(el))
const overflows = (el: HTMLElement) => el.scrollHeight - el.clientHeight > 1
const moreOf = (el: HTMLElement) => hiddenBelow(el.scrollHeight, el.clientHeight, el.scrollTop)

export function useFactsFit(slot: RefObject<HTMLElement | null>, enabled: boolean): FactsFit {
  const [state, setState] = useState<{ key: string; level: FactsFit['level'] }>({ key: '', level: 0 })
  const [more, setMore] = useState(false)
  const current = useRef(state)

  // after each decision (and on mount), before paint: go one level tighter while the facts overflow (kept for this
  // size and text); then say whether rows are hidden below
  useLayoutEffect(() => {
    current.current = state
    const el = slot.current
    if (!enabled || !el) return
    const decide = () => {
      const key = keyOf(el)
      if (state.level < 3 && overflows(el)) setState({ key, level: (state.level + 1) as FactsFit['level'] })
      else if (state.level === 0 && key !== state.key) setState({ key, level: 0 })
      setMore(moreOf(el))
    }
    decide()
  }, [slot, enabled, state])

  // a new window size or new facts text: start again from the normal layout (the effect above measures it)
  useEffect(() => {
    const el = slot.current
    if (!enabled || !el) return
    let raf = 0
    const check = () => {
      raf = 0
      const key = keyOf(el)
      if (key !== current.current.key) setState({ key, level: 0 })
      else setMore(moreOf(el))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    const onScroll = () => setMore(moreOf(el))
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [slot, enabled])

  const scrollMore = () => {
    const el = slot.current
    if (!el) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    el.scrollBy({ top: Math.max(40, el.clientHeight * 0.7), behavior: reduce ? 'auto' : 'smooth' })
  }
  const level = enabled ? state.level : 0
  return { level, tight: level > 0, more: enabled && more, scrollMore }
}
