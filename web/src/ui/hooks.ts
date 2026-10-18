// Small shared React hooks for the UI (element size, outside clicks, intervals, a ticking wall clock).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Content-box size of an element, updated with ResizeObserver (0×0 until measured). */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (w: number, h: number) =>
      setSize((s) => (Math.abs(s.width - w) < 0.5 && Math.abs(s.height - h) < 0.5 ? s : { width: w, height: h }))
    const r = el.getBoundingClientRect()
    update(r.width, r.height)
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) update(cr.width, cr.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

/** Calls `onOutside` for pointer-downs outside every given element, and on Escape. Active only when `active`. */
export function useDismiss(active: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void): void {
  const cb = useRef(onOutside)
  useLayoutEffect(() => {
    cb.current = onOutside
  })
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && refs.some((r) => r.current?.contains(t))) return
      cb.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
    // refs are stable RefObjects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
}

/** setInterval with the latest callback; `ms` null pauses it. */
export function useInterval(fn: () => void, ms: number | null): void {
  const cb = useRef(fn)
  useLayoutEffect(() => {
    cb.current = fn
  })
  useEffect(() => {
    if (ms == null) return
    const id = setInterval(() => cb.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

/** Wall-clock ms, re-rendering every `everyMs` (for "3 min ago" labels). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useInterval(() => setNow(Date.now()), everyMs)
  return now
}

/** True when the user asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}
