// List windowing for long lists (brief 3 W11): above LIST_WINDOW_MIN rows only the rows near the visible part of the
// scroller are rendered, the others kept as padding on the list, so 1,300 national rows stay fast. The arithmetic is
// state/overview.ts (listWindow, scrollToRow); this hook follows the scroller's position and size and the rendered
// row pitch. Used by the overview list (ui/shell/OverviewPanel.tsx) and the incident picker (ui/IncidentPicker.tsx).
import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { LIST_WINDOW_MIN, listWindow, scrollToRow } from '../state/overview'

/** Row pitch before the first measure. */
const ROW_GUESS_PX = 50

interface View {
  /** Scroll position inside the list (px from its first row). */
  scrollTop: number
  /** Visible height of the scroller. */
  viewH: number
  rowH: number
}

export interface ListWindowOptions {
  /** The list element's own top and bottom padding (px), kept around the rendered rows. */
  padPx: number
  /** Selects the rendered rows inside the list (their pitch is measured from the first two). */
  rowSelector: string
  /** Called with the next window before it renders (e.g. to move focus off a row that is about to leave it). */
  onWindow?: (start: number, end: number) => void
}

export interface ListWindowState {
  windowed: boolean
  /** Rows [start, end) to render (every row when not windowed). */
  start: number
  end: number
  /** Room kept for the rows not rendered above and below the window (px). */
  before: number
  after: number
  /** The same room as padding for a list element inside its scroller. A list that is itself the scroller uses spacer
   *  elements of `before` / `after` px instead: a scroller in a flex column cannot shrink below its own padding. */
  style: CSSProperties | undefined
  /** Scroll row `i` into view; true when it is rendered now (else it renders after the scroll). */
  reveal: (i: number) => boolean
}

/** `scroller` scrolls `list` (they may be the same element); `n` is the row count. */
export function useListWindow(n: number, scroller: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, opts: ListWindowOptions): ListWindowState {
  const [view, setView] = useState<View>({ scrollTop: 0, viewH: 640, rowH: ROW_GUESS_PX })
  const windowed = n > LIST_WINDOW_MIN
  const { start, end } = listWindow(n, view.scrollTop, view.viewH, view.rowH)
  const { padPx, rowSelector, onWindow } = opts

  useEffect(() => {
    const box = scroller.current
    const el = list.current
    if (!box || !el || !windowed) return
    const measure = () => {
      const listTop = (el === box ? 0 : el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) + padPx
      const rows = el.querySelectorAll<HTMLElement>(rowSelector)
      // layout offsets, not screen boxes (a transform such as a sheet sliding in does not change the pitch), averaged
      // over the rendered rows (offsets are whole pixels; a 47.8 px row read as 47 would drift 1,000 px over the list)
      let pitch = 0
      if (rows.length >= 2) pitch = (rows[rows.length - 1].offsetTop - rows[0].offsetTop) / (rows.length - 1)
      else if (rows.length === 1) pitch = rows[0].offsetHeight
      // never more than the window's height: a scroller still growing to its content (a popover being placed) would
      // otherwise ask for every row
      const next: View = { scrollTop: Math.max(0, box.scrollTop - listTop), viewH: Math.min(box.clientHeight, window.innerHeight), rowH: pitch > 0 ? pitch : ROW_GUESS_PX }
      if (onWindow) {
        const w = listWindow(Number(el.dataset.size ?? 0), next.scrollTop, next.viewH, next.rowH)
        onWindow(w.start, w.end)
      }
      setView((v) => (Math.abs(v.scrollTop - next.scrollTop) < 0.5 && v.viewH === next.viewH && Math.abs(v.rowH - next.rowH) < 0.5 ? v : next))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    if (el !== box) ro.observe(el)
    box.addEventListener('scroll', measure, { passive: true })
    return () => {
      ro.disconnect()
      box.removeEventListener('scroll', measure)
    }
  }, [windowed, scroller, list, padPx, rowSelector, onWindow])

  const reveal = (i: number): boolean => {
    if (!windowed) return true
    const box = scroller.current
    const top = scrollToRow(i, view.rowH, view.scrollTop, view.viewH)
    if (box && top !== view.scrollTop) {
      box.scrollBy(0, top - view.scrollTop)
      setView((v) => ({ ...v, scrollTop: top }))
    }
    return i >= start && i < end
  }

  const before = windowed ? start * view.rowH : 0
  const after = windowed ? (n - end) * view.rowH : 0
  return {
    windowed,
    start: windowed ? start : 0,
    end: windowed ? end : n,
    before,
    after,
    style: windowed ? { paddingTop: padPx + before, paddingBottom: padPx + after } : undefined,
    reveal,
  }
}
