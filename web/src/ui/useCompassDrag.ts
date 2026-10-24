// Drag a compass to turn the view (brief 4 decision f; CONTRACT §15.3). Shared by the map controls
// (map/MapControls.tsx) and the Forensic compass (H5). Press on the compass and move around its centre: the needle
// follows the pointer (pointer capture, so the drag keeps working outside the button), and the heading is set at most
// once per frame. A press released without moving (a click, Enter or Space) still turns the view north up, so "reset
// north" stays. Keyboard: ← / → turn 15°, Escape during a drag puts the heading back. The angle maths is pure
// (lib/compass.ts).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { angleDelta, dragHeading, pointerBearing } from '../lib/compass'
import { ROTATE_STEP_DEG } from '../state/rotation'

export interface CompassDragOptions {
  /** The current heading (compass degrees). */
  bearing: () => number
  /** Set the heading (called at most once per frame while dragging). */
  setBearing: (deg: number) => void
  /** A click without a drag. */
  northUp: () => void
  /** ← / → on the compass turn the view (default: setBearing(bearing() ± 15)). */
  rotateBy?: (deg: number) => void
  disabled?: boolean
}

/** A press moving less than this (CSS px) is a click, not a drag. */
export const COMPASS_DRAG_PX = 4
/** Pointer angles this close to the compass centre are too unstable to use. */
const DEAD_PX = 3

interface Drag {
  id: number
  cx: number
  cy: number
  x0: number
  y0: number
  last: number | null
  turned: number
  start: number
  moved: boolean
}

export interface CompassDragProps {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
  onClick: (e: MouseEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

export function useCompassDrag(options: CompassDragOptions): { props: CompassDragProps; dragging: boolean } {
  const opt = useRef(options)
  useLayoutEffect(() => {
    opt.current = options
  })
  const drag = useRef<Drag | null>(null)
  const pending = useRef<number | null>(null)
  const raf = useRef(0)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const flush = () => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    const h = pending.current
    pending.current = null
    if (h != null) opt.current.setBearing(h)
  }
  const schedule = (h: number) => {
    pending.current = h
    if (!raf.current) raf.current = requestAnimationFrame(flush)
  }

  const finish = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d.moved) return
    flush()
    setDragging(false)
    // the click that follows the release ends the drag, it is not a "north up" click
    suppressClick.current = true
    window.setTimeout(() => {
      suppressClick.current = false
    }, 0)
  }

  const props: CompassDragProps = {
    onPointerDown: (e) => {
      suppressClick.current = false
      if (opt.current.disabled || e.button !== 0 || !e.isPrimary) return
      const r = e.currentTarget.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      drag.current = { id: e.pointerId, cx, cy, x0: e.clientX, y0: e.clientY, last: pointerBearing(cx, cy, e.clientX, e.clientY, DEAD_PX), turned: 0, start: opt.current.bearing(), moved: false }
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    onPointerMove: (e) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < COMPASS_DRAG_PX) return
        d.moved = true
        setDragging(true)
      }
      const a = pointerBearing(d.cx, d.cy, e.clientX, e.clientY, DEAD_PX)
      if (a == null) return
      if (d.last != null) d.turned += angleDelta(d.last, a)
      d.last = a
      schedule(dragHeading(d.start, d.turned))
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onClick: (e) => {
      if (suppressClick.current) {
        suppressClick.current = false
        e.preventDefault()
        return
      }
      if (!opt.current.disabled) opt.current.northUp()
    },
    onKeyDown: (e) => {
      const o = opt.current
      if (e.key === 'Escape' && drag.current?.moved) {
        // put the heading back where the drag started
        const d = drag.current
        drag.current = null
        pending.current = d.start
        flush()
        setDragging(false)
        // the release that follows is not a "north up" click
        suppressClick.current = true
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (o.disabled || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * ROTATE_STEP_DEG
      if (o.rotateBy) o.rotateBy(step)
      else o.setBearing(o.bearing() + step)
      e.preventDefault()
    },
  }
  return { props, dragging }
}
