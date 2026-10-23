// Opening and leaving fires from the shell (brief 2, I1/I3; CONTRACT §13 shell). Every path selects through
// useStore.selectIncident, so state/history.ts records it as a history entry; a build starts only for "Prepare
// analysis (1-3 min)", never because a fire was opened.
import { isHistoryEntry } from '../../state/history'
import { analysisState, findFire, fireFlyTo } from '../../state/overview'
import { getTimeBounds, useStore, type AppState } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { switchWorkspace } from './handoff'

/** What a fire card button asks for. */
export type FireAction = 'open' | 'play' | 'check' | '3d' | 'prepare'

const jobRunning = (s: Pick<AppState, 'job'>) => s.job != null && (s.job.status === 'queued' || s.job.status === 'running')

/** The open fire has no usable analysis yet and nothing is preparing it. */
export function needsBuild(s: Pick<AppState, 'manifest' | 'summary' | 'job'>): boolean {
  if (jobRunning(s)) return false
  if (s.manifest?.status === 'ready' || s.manifest?.status === 'building' || s.summary?.bundle_status === 'building') return false
  return true
}

/** The open fire's last preparation failed (a new one must rebuild from scratch). */
export function buildFailed(s: Pick<AppState, 'manifest' | 'summary' | 'job'>): boolean {
  return !jobRunning(s) && (s.manifest?.status === 'error' || s.summary?.bundle_status === 'error' || (s.job?.kind === 'build' && s.job.status === 'error'))
}

/** Focus the address search box ("Check a location"). */
export function focusSearch(): void {
  document.querySelector<HTMLInputElement>('#mw-search input')?.focus()
}

/** Open fire `id` (or act on it when it is already open). 'play' starts the replay from the beginning, 'check' focuses
 *  the address search, '3d' opens Forensic, 'prepare' builds the analysis (1-3 min, public downloads). */
export async function openFire(id: string, action: FireAction = 'open'): Promise<void> {
  useWorkspace.getState().setFireCard(null)
  const st = useStore.getState()
  if (action === '3d') {
    // the camera hand-off only means something for the fire already shown; another fire is framed by Forensic itself
    if (st.incidentId === id) switchWorkspace('forensic')
    else {
      st.setFlyTo(null)
      useWorkspace.getState().setWorkspace('forensic')
    }
  }
  if (st.incidentId !== id) {
    await st.selectIncident(id, { autoBuild: action === 'prepare', source: 'card' })
    // selectIncident never rebuilds a failed bundle by itself: "Prepare analysis again" does, on this click
    const s = useStore.getState()
    if (action === 'prepare' && s.incidentId === id && buildFailed(s)) await s.startBuild(true)
  } else if (action === 'prepare' && needsBuild(st)) {
    await st.startBuild(buildFailed(st))
  }
  const s = useStore.getState()
  if (s.incidentId !== id) return
  if (action === 'play' && s.manifest?.status === 'ready') {
    const w = s.timeWindow ?? getTimeBounds(s)
    if (w) s.setTimeMs(w.startMs)
    s.setPlaying(true)
  }
  if (action === 'check') {
    if (useWorkspace.getState().workspace !== 'map') switchWorkspace('map')
    requestAnimationFrame(focusSearch)
  }
}

/** Back to the national overview. When this fire was opened from the overview, go back in history (no extra entry);
 *  otherwise close it, which pushes an overview entry. */
export function goToOverview(): void {
  useWorkspace.getState().setFireCard(null)
  const st = useStore.getState()
  if (st.incidentId == null) return
  const h: unknown = window.history.state
  if (isHistoryEntry(h) && h.fromOverview && h.incident === st.incidentId) {
    window.history.back()
    return
  }
  st.closeIncident()
}

/** A fire picked from a list: open its card and fly the map to it (the camera stays when the map is not shown). */
export function showFireCard(id: string): void {
  const st = useStore.getState()
  const ws = useWorkspace.getState()
  ws.setFireCard(id)
  const fire = findFire(id, st.summary, st.catalog)
  const fly = fire ? fireFlyTo(fire) : null
  // an unprepared fire's card holds the map's zoom focus (map/focus.ts FocusHold): a prepared fire whose area the view
  // covers must not open instead of the fire the user picked; a prepared fire is opened by the zoom as before
  if (fly && ws.workspace === 'map') ws.requestMapFlyTo(fire && analysisState(fire) !== 'ready' ? { ...fly, source: 'fire-card' } : fly)
}
