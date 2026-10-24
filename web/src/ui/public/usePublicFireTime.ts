// The Public fire view's time (brief 4 H4, PLAN-4 decision a): there is no timeline in Public, so the view is at the
// fire's latest observation (live: now; a past fire: the end of its record), and the facts, the location card and the
// map agree. A time that was asked for (a ?t= link, or the time Command showed when the user switched) is held and
// given back when the user switches to Command in the same fire; the store's opening default is not held. Playback
// stops (Public has no play button).
import { useEffect } from 'react'
import { defaultTimeFor, latestObservationMs, useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'

/** The time Command (or a link) asked for while Public shows the latest observation; module state, one fire. */
let held: { id: string; ms: number } | null = null

/** Pure: the time Public shows and the time it holds for Command (tests). */
export function publicFireTime(
  s: { id: string; timeMs: number; latestMs: number; defaultMs: number },
  current: { id: string; ms: number } | null,
): { timeMs: number; held: { id: string; ms: number } | null } {
  const keep = current && current.id === s.id ? current : null
  if (s.timeMs === s.latestMs) return { timeMs: s.latestMs, held: keep }
  // an asked-for time is held (the first one; Public never moves it again); the opening default is not
  const asked = s.timeMs !== s.defaultMs
  return { timeMs: s.latestMs, held: keep ?? (asked ? { id: s.id, ms: s.timeMs } : null) }
}

export function usePublicFireTime(): void {
  useEffect(() => {
    const apply = () => {
      const s = useStore.getState()
      const m = s.manifest
      if (!s.incidentId || !m || m.status !== 'ready' || m.id !== s.incidentId) return
      if (s.playing) s.setPlaying(false)
      const r = publicFireTime({ id: s.incidentId, timeMs: s.timeMs, latestMs: latestObservationMs(m), defaultMs: defaultTimeFor(m) }, held)
      held = r.held
      if (r.timeMs !== s.timeMs) s.setTimeMs(r.timeMs)
    }
    apply()
    const unsub = useStore.subscribe((s, p) => {
      if (s.manifest !== p.manifest || s.timeMs !== p.timeMs || s.incidentId !== p.incidentId || s.playing !== p.playing) apply()
    })
    return () => {
      unsub()
      // leaving for Command in the same fire: the time it had (or the link's) comes back
      // (kept otherwise: React's development double mount runs this cleanup once; a hold for another fire is ignored)
      const s = useStore.getState()
      if (held && held.id === s.incidentId && useWorkspace.getState().preset === 'command') {
        s.setTimeMs(held.ms)
        held = null
      }
    }
  }, [])
}
