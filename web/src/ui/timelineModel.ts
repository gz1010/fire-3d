// Timeline data helpers shared by the timeline, Key Events and charts: merged events + annotations, jumping to an
// event, and the visible timeline window.
import { useShallow } from 'zustand/react/shallow'
import type { FireEvent } from '../api/types'
import type { Annotation } from '../state/annotations'
import { getTimeBounds, useStore, type TimeWindow } from '../state/store'
import type { EventKind } from './eventMeta'

export interface TimelineItem {
  id: string
  kind: EventKind
  t: number
  title: string
  x?: number
  z?: number
  detail?: string
}

/** Events + annotations as one sorted list (used by the timeline markers and Key Events). */
export function mergeEvents(events: FireEvent[] | undefined, notes: Annotation[]): TimelineItem[] {
  const out: TimelineItem[] = (events ?? []).map((e) => ({ id: e.id, kind: e.type, t: e.t_ms, title: e.title, x: e.x, z: e.z, detail: e.detail }))
  for (const a of notes) out.push({ id: a.id, kind: 'annotation', t: a.t_ms, title: a.title, x: a.x, z: a.z, detail: a.detail })
  return out.sort((a, b) => a.t - b.t)
}

/** Jump to an event: pause, set the time, select it and fly the camera to its location. */
export function goToItem(it: TimelineItem): void {
  const s = useStore.getState()
  s.setPlaying(false)
  s.setTimeMs(it.t)
  s.setSelectedEventId(it.id)
  if (it.x != null && it.z != null) s.requestFlyTo(it.x, it.z)
}

export function useTimelineWindow(): TimeWindow | null {
  return useStore(
    useShallow((s) => {
      if (s.manifest?.status !== 'ready') return null
      const w = s.timeWindow ?? getTimeBounds(s)
      return w ? { startMs: w.startMs, endMs: w.endMs } : null
    }),
  )
}
