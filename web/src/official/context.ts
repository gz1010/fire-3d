// Shared context of the official hooks and producers (owner: official-web): the open fire, whether the timeline
// stands for a past time, the reference time of "in effect", where the fire is (distances) and the areas Fire-3d
// checks. Time is quantised to the minute, so playback re-renders readers at most once a minute.
import { useMemo } from 'react'
import type { Mode } from '../api/types'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MARGIN_KM, incidentAreaBbox, isPastForCurrentSources } from '../extras/client'
import { nowMarkerMs, useStore } from '../state/store'
import { isDemoBundle, useWorkspace } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { fireReference, type FireReference } from './fire'
import type { BBox } from './geo'

export interface OfficialContext {
  incidentId: string | null
  hasIncident: boolean
  demo: boolean
  live: boolean
  /** The timeline stands for a past time (historical replay, or a live time before the NOW marker − 6 h). */
  past: boolean
  /** What "in effect" refers to: now (live present) or the timeline time (past). */
  refMs: number
  fire: FireReference | null
  /** The area the fire's evacuation and fire weather queries cover (its analysis area, or the reported point ± 10 km,
   *  + 15 km: the same box as the backend's area_bbox). */
  evacBbox: BBox | null
  layerOn: boolean
}

/**
 * Whether a (minute-quantised) timeline time is in the past for current-only sources. The NOW marker (the latest
 * observation, e.g. 00:42:41) is quantised the same way, so a live fire shown at its NOW marker is the present, never
 * "past" (the time floored to 00:42:00 would otherwise fall before the marker).
 */
export function officialPast(mode: Mode, minuteTimeMs: number, nowMs: number, markerMs: number | null): boolean {
  const marker = markerMs != null && Number.isFinite(markerMs) ? Math.floor(markerMs / 60_000) * 60_000 : markerMs
  return isPastForCurrentSources(mode, minuteTimeMs, nowMs, marker)
}

export function useOfficialContext(): OfficialContext {
  const now = useNow(30_000)
  const s = useStore(
    useShallow((st) => {
      const manifest = st.manifest?.status === 'ready' && st.manifest.id === st.incidentId ? st.manifest : null
      const summary = st.summary && st.summary.id === st.incidentId ? st.summary : null
      return {
        incidentId: st.incidentId,
        manifest,
        summary,
        mode: manifest?.mode ?? summary?.mode ?? st.mode,
        minute: Math.floor(st.timeMs / 60_000),
        marker: nowMarkerMs(manifest, st.forecast),
        perimeters: st.perimeters,
        detections: st.detections,
      }
    }),
  )
  const layerOn = useWorkspace((w) => w.mapLayers.evacuation)
  return useMemo(() => {
    const hasIncident = s.incidentId != null
    const timeMs = s.minute * 60_000
    const past = hasIncident && officialPast(s.mode, timeMs, now, s.marker)
    const refMs = past ? timeMs : now
    const fireMs = past ? timeMs : (s.manifest?.time_range.now_ms ?? now)
    const fire = hasIncident ? fireReference(s.summary, s.manifest, s.perimeters?.perimeters, fireMs, s.detections?.detections) : null
    return {
      incidentId: s.incidentId,
      hasIncident,
      demo: isDemoBundle(s.incidentId, s.manifest),
      live: s.mode === 'live',
      past,
      refMs,
      fire,
      evacBbox: incidentAreaBbox(s.summary, s.manifest, DEFAULT_MARGIN_KM.evacuations),
      layerOn,
    }
  }, [s, now, layerOn])
}
