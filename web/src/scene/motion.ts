// prefers-reduced-motion (SPEC 9.0 "Honour prefers-reduced-motion"): scene-core skips the scan sweep, slows the
// shader clock (flicker, glints) and makes camera moves near-instant.
import { useSyncExternalStore } from 'react'

const query =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null

export const reducedMotion = (): boolean => query?.matches ?? false

function subscribe(cb: () => void): () => void {
  query?.addEventListener('change', cb)
  return () => query?.removeEventListener('change', cb)
}

export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribe, reducedMotion, () => false)
}
