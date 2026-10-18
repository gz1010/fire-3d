// Small hooks for the Public/Command shell: media queries (narrow layout), drawer focus handling and overflow checks.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

/** Phone layout: drawers become bottom sheets (keep in sync with the 760px media queries in styles/map-layout.css). */
export const NARROW_QUERY = '(max-width: 760px)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Visible toggle button of a workspace panel (header buttons carry data-panel-toggle). */
function panelToggle(key: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[data-panel-toggle="${key}"]`))) if (el.getClientRects().length > 0) return el
  return null
}

/** Non-modal drawer focus: when `open` turns true, remember the element that had focus (usually the toggle) and move
 *  focus to `target` (a heading with tabIndex -1, inside the drawer's [data-drawer] root); when it turns false while
 *  focus was inside the drawer, give focus back to that element, or to the panel's visible toggle (`panelKey`) when
 *  the opener is gone. A drawer that is open when it mounts (e.g. after a workspace switch) or that closes on its own
 *  (layout changes) leaves focus alone. */
export function useDrawerFocus(open: boolean, target: RefObject<HTMLElement | null>, panelKey?: string): void {
  const opener = useRef<HTMLElement | null>(null)
  const inside = useRef(false)
  // act on changes only (also safe under StrictMode's double effect run)
  const prev = useRef(open)
  useLayoutEffect(() => {
    if (prev.current === open) return
    prev.current = open
    if (open) {
      const a = document.activeElement
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null
      target.current?.focus({ preventScroll: true })
      // the focusin listener below attaches after this, so record the move here
      inside.current = target.current != null && document.activeElement === target.current
      return
    }
    const back = opener.current?.isConnected ? opener.current : panelKey ? panelToggle(panelKey) : null
    const had = inside.current
    opener.current = null
    inside.current = false
    const a = document.activeElement
    if (had && back && (!a || a === document.body)) back.focus({ preventScroll: true })
  }, [open, target, panelKey])
  // where focus is while open (a removed element fires no focusout, so the last value survives the close)
  useEffect(() => {
    if (!open) return
    const onFocusIn = (e: FocusEvent) => {
      const root = target.current?.closest('[data-drawer]') ?? target.current
      inside.current = root != null && e.target instanceof Node && root.contains(e.target)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open, target])
}

/** True while the element's content is taller than its box (re-checked when it or its children resize). `active`
 *  re-attaches the observers when the element mounts later. */
export function useOverflowing<T extends HTMLElement>(active = true): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const check = () => setOver(el.scrollHeight - el.clientHeight > 4)
    const observe = () => {
      ro.disconnect()
      ro.observe(el)
      for (const c of Array.from(el.children)) ro.observe(c)
    }
    const ro = new ResizeObserver(check)
    observe()
    check()
    const mo = new MutationObserver(() => {
      observe()
      check()
    })
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [active])
  return [ref, over]
}
