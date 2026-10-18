// Slot of the persistent coordinate strip (owner: shell; the strip itself, <CoordinateStrip/>, belongs to location).
// On phones the Command strip (both points with DMS / UTM lines, incident id, record and selected times) would cover a
// large part of the small map, so there it starts clamped to the first block, the incident's reported location with
// its copy buttons, and a toggle reveals the rest. Focus moving into the hidden part (keyboard) opens it. Public
// strips (one or two coordinate lines) and wider screens are never clamped.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { useWorkspace } from '../../state/workspace'
import { NARROW_QUERY, useMediaQuery } from './hooks'

/** Fallback clamp (px) when the strip's first coordinate block cannot be measured. */
const CLAMP_FALLBACK = 72

export function CoordsSlot({ children }: { children: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const command = useWorkspace((s) => s.preset === 'command')
  const clampable = narrow && command
  const [open, setOpen] = useState(false)
  const [clampPx, setClampPx] = useState<number | null>(null)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // clamp height = bottom of the first coordinate block (+ the strip's bottom padding); re-measured on resize.
  // Outside phones + Command the stale measurements are ignored (everything below is gated by `clampable`).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !clampable) return
    const measure = () => {
      const strip = el.firstElementChild as HTMLElement | null
      const first = el.querySelector<HTMLElement>('.loc-coord')
      // content coordinates: a focused element may have scrolled the clamped box
      const top = el.getBoundingClientRect().top - el.scrollTop
      const px = first ? Math.ceil(first.getBoundingClientRect().bottom - top + 7) : CLAMP_FALLBACK
      setClampPx(px > 24 ? px : CLAMP_FALLBACK)
      setOverflows((strip?.getBoundingClientRect().height ?? el.scrollHeight) > px + 4)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    const mo = new MutationObserver(() => {
      ro.disconnect()
      ro.observe(el)
      if (el.firstElementChild) ro.observe(el.firstElementChild)
      measure()
    })
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [clampable])

  const clamped = clampable && overflows && !open && clampPx != null
  // a clamped box always shows its top (focus inside may have scrolled it)
  useLayoutEffect(() => {
    if (clamped && ref.current) ref.current.scrollTop = 0
  }, [clamped])
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!clamped || !el || clampPx == null) return
    const t = e.target as HTMLElement
    if (t.closest('.mw-coords-more')) return
    // the browser scrolls the clamped box to the focused element before this runs: compare in content coordinates
    if (t.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop > clampPx + 1) setOpen(true)
  }
  return (
    <div
      ref={ref}
      id="mw-coords"
      className={`mw-coords${clamped ? ' is-clamped' : ''}${clampable && overflows ? ' has-more' : ''}`}
      data-chrome="coords"
      style={clamped ? { maxHeight: `${clampPx}px` } : undefined}
      onFocus={onFocus}
    >
      {children}
      {clampable && (overflows || open) && (
        <button
          type="button"
          className="mw-icon-btn mw-coords-more"
          aria-controls="mw-coords"
          aria-expanded={!clamped}
          aria-label={clamped ? 'Show all coordinates, identifiers and times' : 'Show fewer coordinate details'}
          onClick={() => setOpen((o) => !o)}
        >
          {clamped ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      )}
    </div>
  )
}
