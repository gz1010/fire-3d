// Slot of the persistent coordinate strip (owner: shell; the strip itself, <CoordinateStrip/>, belongs to location).
// The strip is always visible (brief 2 decision 7). The slot picks its form (coordsVariant.ts): Command shows the full
// strip, Public a compact decimal one, and phones a single line in both presets, with a toggle that shows the preset's
// full form. The form reaches the strip through CoordsVariantContext and as .mw-coords[data-variant]. A strip that is
// still taller than one line on a phone is clamped to its first coordinate block until the toggle opens it; focus
// moving into the hidden part (keyboard) opens it too.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { useWorkspace } from '../../state/workspace'
import { coordsVariant, CoordsVariantContext } from './coordsVariant'
import { NARROW_QUERY, useMediaQuery } from './hooks'

/** Fallback clamp (px) when the strip's first coordinate block cannot be measured. */
const CLAMP_FALLBACK = 40

export function CoordsSlot({ children }: { children: ReactNode }) {
  const narrow = useMediaQuery(NARROW_QUERY)
  const preset = useWorkspace((s) => s.preset)
  const [open, setOpen] = useState(false)
  const [clampPx, setClampPx] = useState<number | null>(null)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const variant = coordsVariant(preset, narrow, open)
  const clampable = narrow

  // clamp height = bottom of the first coordinate block (+ the strip's bottom padding); re-measured on resize.
  // Wider screens ignore the stale measurements (everything below is gated by `clampable`).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !clampable) return
    const measure = () => {
      const strip = el.firstElementChild as HTMLElement | null
      const first = el.querySelector<HTMLElement>('.loc-coord')
      // content coordinates: a focused element may have scrolled the clamped box
      const top = el.getBoundingClientRect().top - el.scrollTop
      const px = first ? Math.ceil(first.getBoundingClientRect().bottom - top + 5) : CLAMP_FALLBACK
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
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [clampable, variant])

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
  // phones: the toggle opens the preset's full form (Command) or the compact two-point form (Public)
  const canExpand = clampable
  return (
    <div
      ref={ref}
      id="mw-coords"
      className={`mw-coords${clamped ? ' is-clamped' : ''}${canExpand ? ' has-more' : ''}`}
      data-chrome="coords"
      data-variant={variant}
      style={clamped ? { maxHeight: `${clampPx}px` } : undefined}
      onFocus={onFocus}
    >
      <CoordsVariantContext.Provider value={variant}>{children}</CoordsVariantContext.Provider>
      {canExpand && (
        <button
          type="button"
          className="mw-icon-btn mw-coords-more"
          aria-controls="mw-coords"
          aria-expanded={open}
          aria-label={open ? 'Show the one-line coordinates' : preset === 'command' ? 'Show all coordinates, identifiers and times' : 'Show both coordinate points'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      )}
    </div>
  )
}
