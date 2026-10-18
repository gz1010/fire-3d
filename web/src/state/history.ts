// Browser history for the California overview (brief 2, O-R1; CONTRACT §13 shell). Opening a fire is a navigation:
// every explicit change of useStore.incidentId (fire card, search, picker, "All fires") pushes an entry
// (?incident=<id>, or none for the overview), so Back returns to the overview or to the previous fire. A zoom focus or
// zoom-out (decision 10, incidentSource 'zoom') and the not-found fallback replace the entry instead: Back steps through
// explicit opens only and never leads to a dead link. Back / Forward apply the entry: its incident (an explicit open,
// source 'history', without a build; or closeIncident), its ?t= once the bundle is ready, and its ?ws=. Every other URL
// change stays replaceState (state/runtime.ts useUrlSync, state/workspace.ts useWorkspaceUrlSync). Pure helpers:
// history.test.ts.
import { useEffect } from 'react'
import { readUrlParams } from './runtime'
import { useStore } from './store'
import { parseWorkspaceParams, useWorkspace } from './workspace'

/** history.state of the entries Fire-3d writes. `fromOverview`: pushed when a fire was opened from the overview, so
 *  "All fires" can go back instead of stacking another overview entry. */
export interface HistoryEntryState {
  fire3d: 1
  incident: string | null
  fromOverview: boolean
}

export function isHistoryEntry(v: unknown): v is HistoryEntryState {
  return typeof v === 'object' && v != null && (v as { fire3d?: unknown }).fire3d === 1
}

/** The ?incident= of a query string (empty = none). */
export function incidentParam(search: string): string | null {
  return new URLSearchParams(search).get('incident') || null
}

export type HistoryWrite = 'push' | 'replace' | 'none'

/** How an incident change is recorded: nothing when the address bar already says it (deep link, Back / Forward), a
 *  replacement for the not-found fallback and for zoom focus changes, else a new entry. */
export function historyWrite(urlIncident: string | null, nextIncident: string | null, notFound: boolean, zoom = false): HistoryWrite {
  if (urlIncident === nextIncident) return 'none'
  return notFound || zoom ? 'replace' : 'push'
}

/** The address of a navigation to `incident` (null = the overview): ?t= and ?mode= belong to the previous fire and the
 *  one-shot ?view= / ?sel= are dropped; workspace parameters stay. Returns path + query + hash. */
export function navigationUrl(href: string, incident: string | null): string {
  const u = new URL(href)
  const p = u.searchParams
  if (incident) p.set('incident', incident)
  else p.delete('incident')
  for (const k of ['t', 'mode', 'view', 'sel']) p.delete(k)
  return `${u.pathname}${u.search}${u.hash}`
}

/** Apply ?t= once `id`'s bundle is ready (it may still be loading or building). Returns an unsubscribe. */
export function applyTimeWhenReady(id: string, t: number): () => void {
  const apply = () => {
    const s = useStore.getState()
    if (s.incidentId !== id) return true
    if (s.manifest?.status !== 'ready' || s.manifest.id !== id) return false
    s.setTimeMs(t)
    return true
  }
  if (apply()) return () => undefined
  const unsub = useStore.subscribe(() => {
    if (apply()) unsub()
  })
  return unsub
}

let pendingTime: (() => void) | null = null

/** Back / Forward: make the stores match the address bar's entry. */
export function applyLocation(): void {
  pendingTime?.()
  pendingTime = null
  const q = readUrlParams()
  const ws = parseWorkspaceParams(window.location.search).workspace
  if (ws && ws !== useWorkspace.getState().workspace) useWorkspace.getState().setWorkspace(ws)
  const st = useStore.getState()
  if (!q.incident) {
    if (st.incidentId != null) st.closeIncident()
    return
  }
  const id = q.incident
  const t = q.t
  if (id !== st.incidentId) {
    void st.selectIncident(id, { source: 'history' }).then(() => {
      if (t != null && useStore.getState().incidentId === id) pendingTime = applyTimeWhenReady(id, t)
    })
  } else if (t != null) pendingTime = applyTimeWhenReady(id, t)
}

/** Record incident changes as history entries and follow Back / Forward. Mounted once (App); active from the start, so
 *  a dead start-up link is replaced too. */
export function useHistorySync(): void {
  useEffect(() => {
    const unsub = useStore.subscribe((s, p) => {
      if (s.incidentId === p.incidentId) return
      const notFound = s.incidentId == null && p.incidentId != null && s.missingIncidentId === p.incidentId
      const write = historyWrite(incidentParam(window.location.search), s.incidentId, notFound, s.incidentSource === 'zoom')
      if (write === 'none') return
      const url = navigationUrl(window.location.href, s.incidentId)
      const state: HistoryEntryState = { fire3d: 1, incident: s.incidentId, fromOverview: write === 'push' && p.incidentId == null && s.incidentId != null }
      if (write === 'push') window.history.pushState(state, '', url)
      else window.history.replaceState(state, '', url)
    })
    const onPop = () => applyLocation()
    window.addEventListener('popstate', onPop)
    return () => {
      unsub()
      window.removeEventListener('popstate', onPop)
      pendingTime?.()
      pendingTime = null
    }
  }, [])
}
