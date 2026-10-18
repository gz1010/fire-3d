// Narrow-screen media query for the location components (owner: location). Same breakpoint as the shell's bottom
// sheets (styles/map-layout.css, 760 px).
import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 760px)'

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
  const m = window.matchMedia(QUERY)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY).matches : false),
    () => false,
  )
}
