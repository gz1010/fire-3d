// Shared runtime of the official sources (owner: official-web; CONTRACT §13 I5 / I6). `useOfficialSync()` runs once in
// the map workspace (from extras/ExtrasSync.tsx, which is always mounted there) and publishes the incident's agency
// record (CAL FIRE's or NIFC WFIGS's, CONTRACT §14.5) and NWS fire weather alerts here, whatever the map layers show. The hooks (hooks.ts), the "Official now"
// block, the feed producers and the official map layer read this store, so each source is fetched once.
// Evacuation zones stay in useExtrasRuntime().evac (fetched for the incident whatever the layer toggle says).
import { useLayoutEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { nowMarkerMs, useStore } from '../state/store'
import { isDemoBundle } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { IDLE_QUERY, sameQueryState } from '../extras/hooks'
import { fireWeatherAtMs, fireWeatherStatewideUrl, fireWeatherUrl, localAlertsUrl, OFFICIAL_REFRESH_MS, recordUrl, secondaryRecordUrl } from './client'
import { alertEndMs, EXPIRED_KEEP_MS, isFireWeatherAlert, vtecKey } from './fireWeather'
import { forIncident } from './guard'
import { useJsonQuery, type QueryState } from './query'
import type { CalFireResponse, FireWeatherResponse, IncidentRecordResponse, LocalAlertsResponse, NwsAlert, OfficialHighlight } from './types'

export interface OfficialRuntimeState {
  /** CAL FIRE's record (fires whose `record_source` is 'calfire'). */
  calfire: QueryState<CalFireResponse>
  /** NIFC WFIGS (IRWIN) record (brief 3, CONTRACT §14.5): a WFIGS fire's own record, or a California fire's matched
   *  record when the agencies disagree on whether it is active. Never fetched for a CAL FIRE complex row. */
  record: QueryState<IncidentRecordResponse>
  /** Local officials' messages for the open fire's area (CONTRACT §14.7), at the same time as its fire weather. */
  local: QueryState<LocalAlertsResponse>
  fireWeather: QueryState<FireWeatherResponse>
  /** Every current NWS fire weather alert the overview answer covers (`states_checked`; all of the lower 48 once the
   *  national request is live), fetched only on the overview (no fire open). */
  statewide: QueryState<FireWeatherResponse>
  /** Live NWS alerts seen earlier in this session for `incidentId`: kept so an alert that has left the live feed
   *  stays listed as "Expired <time>" for 48 h (NWS's active feed drops it at once). */
  seen: { incidentId: string | null; alerts: NwsAlert[] }
  /** The official area the map highlights (CONTRACT §13): set by selecting an official row, cleared when another
   *  update is selected, when the selection is closed or when the incident changes. */
  highlight: OfficialHighlight | null
  setHighlight: (h: OfficialHighlight | null) => void
}

export const useOfficialRuntime = create<OfficialRuntimeState>()((set) => ({
  calfire: IDLE_QUERY,
  record: IDLE_QUERY,
  local: IDLE_QUERY,
  fireWeather: IDLE_QUERY,
  statewide: IDLE_QUERY,
  seen: { incidentId: null, alerts: [] },
  highlight: null,
  setHighlight: (highlight) => set({ highlight }),
}))

/** Merge live alerts into the session memory: newest message per VTEC event; drops alerts ended > 48 h before now. */
export function rememberAlerts(prev: readonly NwsAlert[], next: readonly NwsAlert[], nowMs: number): NwsAlert[] {
  const m = new Map<string, NwsAlert>()
  for (const a of [...prev, ...next]) {
    if (!a || a.archived || !isFireWeatherAlert(a)) continue
    const k = vtecKey(a)
    const p = m.get(k)
    if (!p || (a.sent_ms ?? 0) >= (p.sent_ms ?? 0)) m.set(k, a)
  }
  return [...m.values()].filter((a) => {
    const end = alertEndMs(a)
    return end == null || end > nowMs - EXPIRED_KEEP_MS
  })
}

/**
 * The fire weather answer with remembered live alerts that are no longer in it (ended, expired or dropped early).
 * An alert that left the live feed before its end time is shown as ended at the time it was last seen.
 */
export function withRememberedAlerts(d: FireWeatherResponse | null, seen: readonly NwsAlert[]): FireWeatherResponse | null {
  if (!d || d.status !== 'available' || d.requested_at_ms != null || seen.length === 0) return d
  const live = new Set(d.alerts.map(vtecKey))
  const gone = seen.filter((a) => !live.has(vtecKey(a)))
  if (!gone.length) return d
  const lastSeen = d.retrieved_ms ?? d.now_ms
  const ended = gone.map((a) => {
    const end = alertEndMs(a)
    return end != null && end <= lastSeen ? a : { ...a, dropped_ms: lastSeen }
  })
  return { ...d, alerts: [...d.alerts, ...ended] }
}

/** A live answer, or one whose archive channel is still being fetched (both are asked again on the cadence). */
const isCurrentLocal = (d: LocalAlertsResponse) => d.requested_at_ms == null || (d.channels ?? []).some((c) => c.status === 'pending')

const isCurrentFw = (d: FireWeatherResponse) => d.status === 'available' && d.requested_at_ms == null && !d.alerts.some((a) => a.archived)

/**
 * Whether the timeline time belongs to the open fire: 'timeline' once its bundle's manifest is loaded; 'present' when
 * it has no ready bundle (no timeline: its sources are asked for the present); null while waiting. Right after a fire
 * switch the store still holds the previous fire's time; time-dependent queries wait (no needless archive requests,
 * no flicker of a "past date" answer).
 */
export function officialTimeReady(s: { incidentId: string | null; manifest: { id: string; status: string } | null; summary: { id: string; bundle_status: string } | null }): 'timeline' | 'present' | null {
  if (!s.incidentId) return null
  if (s.manifest?.id === s.incidentId && s.manifest.status === 'ready') return 'timeline'
  return s.summary?.id === s.incidentId && s.summary.bundle_status !== 'ready' ? 'present' : null
}

/** Runs the official queries for the open incident and publishes them (call once, from ExtrasSync). */
export function useOfficialSync(): void {
  const now = useNow(60_000)
  const { incidentId, demo, live, playing, timeReady } = useStore(
    useShallow((s) => {
      const m = s.manifest?.status === 'ready' && s.manifest.id === s.incidentId ? s.manifest : null
      return { incidentId: s.incidentId, demo: isDemoBundle(s.incidentId, m), live: (m?.mode ?? s.summary?.mode ?? s.mode) === 'live', playing: s.playing, timeReady: officialTimeReady(s) }
    }),
  )
  const at = useStore((s) => {
    const m = s.manifest?.status === 'ready' ? s.manifest : null
    return fireWeatherAtMs(m?.mode ?? s.summary?.mode ?? s.mode, s.timeMs, now, nowMarkerMs(m, s.forecast))
  })
  // hold the query time while the timeline plays (no fetches during playback; it catches up on pause)
  const [held, setHeld] = useState(at)
  if (!playing && held !== at) setHeld(at)
  const atMs = playing ? held : at

  // the fire's own record decides which endpoint answers (CONTRACT §14.5); wait for the summary
  const rec = useStore(
    useShallow((s) => {
      const sum = s.summary && s.summary.id === s.incidentId ? s.summary : null
      return sum ? { primary: recordUrl(sum), secondary: secondaryRecordUrl(sum), wfigs: (sum.record_source ?? 'calfire') === 'wfigs' } : null
    }),
  )
  const calfire = useJsonQuery<CalFireResponse>(incidentId && !demo && rec && !rec.wfigs ? rec.primary : null, { refreshMs: live ? OFFICIAL_REFRESH_MS.calfire : 0 })
  const record = useJsonQuery<IncidentRecordResponse>(incidentId && !demo && rec ? (rec.wfigs ? rec.primary : rec.secondary) : null, { refreshMs: live ? OFFICIAL_REFRESH_MS.calfire : 0 })
  const fireWeather = useJsonQuery<FireWeatherResponse>(incidentId && !demo && timeReady ? fireWeatherUrl(incidentId, timeReady === 'present' ? null : atMs) : null, {
    refreshMs: OFFICIAL_REFRESH_MS.fireWeather,
    timeoutMs: 45_000,
    isCurrent: isCurrentFw,
  })
  // local officials' messages: live (refreshed like NWS), or the archive at a past time (refetched while pending)
  const local = useJsonQuery<LocalAlertsResponse>(incidentId && !demo && timeReady ? localAlertsUrl(incidentId, timeReady === 'present' ? null : atMs) : null, {
    refreshMs: OFFICIAL_REFRESH_MS.local,
    timeoutMs: 45_000,
    isCurrent: isCurrentLocal,
  })
  // the overview: the national answer (outlines and "Official now · lower 48 states"; the scope follows states_checked)
  const statewide = useJsonQuery<FireWeatherResponse>(incidentId == null ? fireWeatherStatewideUrl() : null, {
    refreshMs: OFFICIAL_REFRESH_MS.fireWeather,
    timeoutMs: 45_000,
    isCurrent: isCurrentFw,
  })

  useLayoutEffect(() => {
    const cur = useOfficialRuntime.getState()
    const patch: Partial<OfficialRuntimeState> = {}
    if (!sameQueryState(cur.calfire, calfire)) patch.calfire = calfire
    if (!sameQueryState(cur.record, record)) patch.record = record
    if (!sameQueryState(cur.local, local)) patch.local = local
    if (!sameQueryState(cur.fireWeather, fireWeather)) patch.fireWeather = fireWeather
    if (!sameQueryState(cur.statewide, statewide)) patch.statewide = statewide
    const d = fireWeather.data
    if (cur.seen.incidentId !== incidentId) patch.seen = { incidentId, alerts: [] }
    if (d && isCurrentFw(d) && incidentId) {
      const base = patch.seen ?? cur.seen
      const alerts = rememberAlerts(base.alerts, d.alerts, d.now_ms)
      if (alerts.length !== base.alerts.length || alerts.some((a, i) => a !== base.alerts[i])) patch.seen = { incidentId, alerts }
    }
    if (Object.keys(patch).length) useOfficialRuntime.setState(patch)
  })
}

/** The fire weather answer to show: the published one plus remembered live alerts (see withRememberedAlerts). */
export function useFireWeatherData(): FireWeatherResponse | null {
  const { data, seen, incidentId, statewide } = useOfficialRuntime(
    useShallow((s) => ({ data: s.fireWeather.data, seen: s.seen.alerts, incidentId: s.seen.incidentId, statewide: s.statewide.data })),
  )
  const current = useStore((s) => s.incidentId)
  return useMemo(() => fireWeatherFor(current, data, incidentId, seen, statewide), [current, data, incidentId, seen, statewide])
}

/** Non-React read of the same (map layer). */
export function fireWeatherDataNow(): FireWeatherResponse | null {
  const s = useOfficialRuntime.getState()
  return fireWeatherFor(useStore.getState().incidentId, s.fireWeather.data, s.seen.incidentId, s.seen.alerts, s.statewide.data)
}

/** The open fire's answer (never another fire's), with the alerts remembered for it this session; on the overview
 *  (no fire open) California's current alerts. */
export function fireWeatherFor(
  current: string | null,
  data: FireWeatherResponse | null,
  seenFor: string | null,
  seen: readonly NwsAlert[],
  statewide: FireWeatherResponse | null = null,
): FireWeatherResponse | null {
  if (current == null) return statewide && (statewide.incident_id ?? null) == null ? statewide : null
  const d = forIncident(data, current)
  return d && seenFor === current ? withRememberedAlerts(d, seen) : d
}

// Clear the highlight when another update is selected, the selection is closed, or the incident changes.
useStore.subscribe((s, p) => {
  const h = useOfficialRuntime.getState().highlight
  if (!h) return
  if (s.incidentId !== p.incidentId || (s.selectedEventId !== p.selectedEventId && s.selectedEventId !== h.id)) useOfficialRuntime.getState().setHighlight(null)
})

declare global {
  interface Window {
    /** Dev/test handle: window.__officialRuntime.getState() for screenshot and check scripts. */
    __officialRuntime?: typeof useOfficialRuntime
  }
}

if (typeof window !== 'undefined') window.__officialRuntime = useOfficialRuntime
