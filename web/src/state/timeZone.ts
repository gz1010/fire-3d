// Which zone and which clock the UI's times use (CONTRACT §14.9.4).
//
// - Clock: 12-hour in the map workspace's Public preset ("3:40 PM MDT"); 24-hour in Command and in Forensic
//   ("15:40 MDT") (BRIEF-3 round 2 item 8).
// - Zone: the open fire's `summary.time_zone`; with no fire open, the zone of the place the location card shows
//   (from /api/geo/lookup, set with `setPlaceZone`); else the viewer's own zone, labelled as such. Never Pacific by
//   default. Overview rows and hovers use each row's own zone (`useTimeFormatFor(row.time_zone)`).
// Components use the hooks; pure helpers take the TimeFmt as an argument; imperative code (the map controller) reads
// `getTimeFormat()`.
import { create } from 'zustand'
import { isValidZone, timeFmt, type Clock, type TimeFmt } from '../lib/time'
import { useStore } from './store'
import { useWorkspace, type Preset, type Workspace } from './workspace'

export type ZoneSource = 'fire' | 'place' | 'viewer'

/** '12h' in the map workspace's Public preset, else '24h'. */
export function clockFor(workspace: Workspace, preset: Preset): Clock {
  return workspace === 'map' && preset === 'public' ? '12h' : '24h'
}

interface PlaceZoneState {
  /** IANA zone of the selected place without a fire (from /api/geo/lookup); null = none known. */
  placeZone: string | null
  setPlaceZone: (tz: string | null) => void
}

/** The zone of the place the location card shows when no fire is open (written by the location card). */
export const usePlaceZone = create<PlaceZoneState>()((set) => ({
  placeZone: null,
  setPlaceZone: (tz) => set({ placeZone: tz && isValidZone(tz) ? tz : null }),
}))

/** A summary's own zone when it is a valid IANA zone, else null. */
export function zoneOf(summary: { time_zone?: string | null } | null | undefined): string | null {
  const tz = summary?.time_zone
  return tz && isValidZone(tz) ? tz : null
}

/** The open fire's zone (null when no fire is open or its summary has no valid zone). */
function fireZone(s: { incidentId: string | null; summary: { id: string; time_zone?: string | null } | null }): string | null {
  if (!s.incidentId || !s.summary || s.summary.id !== s.incidentId) return null
  return zoneOf(s.summary)
}

/** Where the current zone comes from: the open fire, the selected place, or the viewer's device. */
export function zoneSourceOf(fire: string | null, place: string | null): ZoneSource {
  return fire ? 'fire' : place ? 'place' : 'viewer'
}

/** The clock of the current workspace and preset. */
export function useClock(): Clock {
  return useWorkspace((s) => clockFor(s.workspace, s.preset))
}

/** The open fire's zone (else the selected place's, else the viewer's) with the current clock. Stable identity. */
export function useTimeFormat(): TimeFmt {
  const clock = useClock()
  const fire = useStore(fireZone)
  const place = usePlaceZone((s) => s.placeZone)
  return timeFmt(fire ?? place, clock)
}

/** The current clock in another zone (an overview row's own `time_zone`, a point's lookup zone). */
export function useTimeFormatFor(tz: string | null | undefined): TimeFmt {
  return timeFmt(tz, useClock())
}

/** Same words as zoneLine's `whose`: 'fire', 'place' or 'viewer'. */
export function useZoneSource(): ZoneSource {
  const fire = useStore(fireZone)
  const place = usePlaceZone((s) => s.placeZone)
  return zoneSourceOf(fire, place)
}

/** Non-hook read of `useTimeFormat()` for imperative code (the map controller, event handlers). */
export function getTimeFormat(): TimeFmt {
  const ws = useWorkspace.getState()
  return timeFmt(fireZone(useStore.getState()) ?? usePlaceZone.getState().placeZone, clockFor(ws.workspace, ws.preset))
}

/** Non-hook read of `useZoneSource()`. */
export function getZoneSource(): ZoneSource {
  return zoneSourceOf(fireZone(useStore.getState()), usePlaceZone.getState().placeZone)
}
