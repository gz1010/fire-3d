// What a fire chrome's top bar shows next to the fire's name (brief 4 H2a): LIVE or the year, the place, the demo badge.
// Shared by the map chromes (not listed in any step of PLAN-4: change it only through the orchestrator).
import { useStore } from '../../state/store'
import { isDemoBundle } from '../../state/workspace'
import { placeLine } from './topBarText'

/** What a fire chrome's top bar shows next to the name: LIVE or the year, the place, the demo badge. */
export interface FireBarInfo {
  live: boolean
  year: number | null
  place: string | null
  demo: boolean
}

export function useFireBarInfo(): FireBarInfo {
  const live = useStore((s) => (s.summary?.mode ?? s.mode) === 'live')
  const year = useStore((s) => s.summary?.year ?? null)
  const place = useStore((s) => (s.summary && s.summary.id === s.incidentId ? placeLine(s.summary) : null))
  const demo = useStore((s) => isDemoBundle(s.incidentId, s.manifest))
  return { live, year, place, demo }
}
