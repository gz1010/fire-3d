// App-level runtime hooks: rAF playback, live polling (manifest 60 s, aircraft 10 s, catalog 5 min, live status),
// URL state (?incident=&t=&mode=) and keyboard shortcuts. Mounted once by App so they keep running while the
// panels are collapsed. Brief 2: there is no default incident (no link = the California overview); history entries
// for opening and leaving fires are written by state/history.ts.
import { useEffect } from 'react'
import type { Mode } from '../api/types'
import { popoverOpen, rotationKey, runRotationKey } from './rotation'
import { defaultTimeFor, getTimeBounds, useStore } from './store'

const HOUR = 3_600_000

/** Play starts from the window start: at its end, before it, or still at the latest observation a zoom focus showed
 *  (decision 10: Play animates the whole spread). */
export function playStartsOver(timeMs: number, w: { startMs: number; endMs: number }, focusTimeMs: number | null): boolean {
  return timeMs >= w.endMs - 60_000 || timeMs < w.startMs || (focusTimeMs != null && Math.abs(timeMs - focusTimeMs) < 1000)
}

/** Advance store.timeMs with requestAnimationFrame while `playing` (speed in hours per second). Stops at the end of
 *  the visible window; pressing play at the end (or at a zoom focus's latest observation) restarts from the window
 *  start. */
export function usePlayback(): void {
  const playing = useStore((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    const s0 = useStore.getState()
    const w0 = s0.timeWindow ?? getTimeBounds(s0)
    if (!w0) {
      s0.setPlaying(false)
      return
    }
    if (playStartsOver(s0.timeMs, w0, s0.focusTimeMs)) s0.setTimeMs(w0.startMs)
    if (s0.focusTimeMs != null) useStore.setState({ focusTimeMs: null })
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const s = useStore.getState()
      if (!s.playing) return
      const w = s.timeWindow ?? getTimeBounds(s)
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)) // no jump after a background tab
      last = now
      const next = s.timeMs + dt * s.speedHoursPerSec * HOUR
      if (!w || next >= w.endMs) {
        if (w) s.setTimeMs(w.endMs)
        s.setPlaying(false)
        return
      }
      s.setTimeMs(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
}

const visible = () => typeof document === 'undefined' || !document.hidden

/** Live mode polling: manifest every 60 s (bundle files reload when built_ms changes), aircraft every 10 s into
 *  store.aircraft, the live catalog every 5 min (also on the overview) and /live/status every 60 s. Paused while the
 *  tab is hidden. `aircraft: false` skips the aircraft poll (the map workspace shows no aircraft, so it does not ask
 *  the ADS-B providers every 10 s; adsb.fi, the fallback, is for light non-commercial use). */
export function useLivePolling({ aircraft = true }: { aircraft?: boolean } = {}): void {
  const mode = useStore((s) => s.mode)
  const id = useStore((s) => s.incidentId)
  const ready = useStore((s) => s.manifest?.status === 'ready')
  const aircraftAll = useStore((s) => s.aircraftAll)

  useEffect(() => {
    if (mode !== 'live' || !id) return
    const t = window.setInterval(() => visible() && void useStore.getState().refreshManifest(), 60_000)
    return () => window.clearInterval(t)
  }, [mode, id])

  useEffect(() => {
    if (mode !== 'live' || !id || !ready || !aircraft) return
    const poll = () => visible() && void useStore.getState().refreshAircraft()
    poll()
    const t = window.setInterval(poll, 10_000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [mode, id, ready, aircraftAll, aircraft])

  useEffect(() => {
    if (mode !== 'live') return
    const st = useStore.getState()
    void st.refreshLiveStatus()
    const t1 = window.setInterval(() => visible() && void useStore.getState().refreshLiveStatus(), 60_000)
    return () => window.clearInterval(t1)
  }, [mode])

  // the active-fire list: inside a live fire and on the overview (CAL FIRE's list is cached 5-10 min server-side)
  const overview = id == null
  useEffect(() => {
    if (mode !== 'live' && !overview) return
    const t = window.setInterval(() => visible() && void useStore.getState().loadCatalog({ lists: ['live'] }), 5 * 60_000)
    return () => window.clearInterval(t)
  }, [mode, overview])
}

export interface UrlParams {
  incident: string | null
  t: number | null
  mode: Mode | null
}

export function readUrlParams(): UrlParams {
  const q = new URLSearchParams(window.location.search)
  const t = Number(q.get('t'))
  const mode = q.get('mode')
  return {
    incident: q.get('incident') || null,
    t: Number.isFinite(t) && t > 0 ? t : null,
    mode: mode === 'live' || mode === 'historical' ? mode : null,
  }
}

/** Absolute link to the current view: ?incident=&t=&mode= (Share button). */
export function shareUrl(): string {
  const s = useStore.getState()
  const u = new URL(window.location.href)
  if (s.incidentId) u.searchParams.set('incident', s.incidentId)
  if (s.manifest) u.searchParams.set('t', String(Math.round(s.timeMs / 60_000) * 60_000))
  u.searchParams.set('mode', s.mode)
  return u.toString()
}

/** Keep the address bar in sync with the selection (replaceState, throttled). `t` is written only when the time
 *  differs from the incident's default time, so plain links keep following "now" in live mode. */
export function useUrlSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const write = () => {
      timer = undefined
      const s = useStore.getState()
      if (!s.incidentId) return
      const u = new URL(window.location.href)
      u.searchParams.set('incident', s.incidentId)
      u.searchParams.set('mode', s.mode)
      const m = s.manifest
      if (m && m.status === 'ready' && Math.abs(s.timeMs - defaultTimeFor(m)) > 60_000) u.searchParams.set('t', String(Math.round(s.timeMs / 60_000) * 60_000))
      else if (m && m.status === 'ready') u.searchParams.delete('t')
      const next = `${u.pathname}${u.search}${u.hash}`
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', next)
    }
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(write, 700)
    }
    const unsub = useStore.subscribe((s, p) => {
      if (s.incidentId !== p.incidentId || s.mode !== p.mode || s.timeMs !== p.timeMs || s.manifest !== p.manifest) schedule()
    })
    schedule()
    return () => {
      unsub()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [enabled])
}

function isTypingTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  if (!e || !e.tagName) return false
  return e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable
}

/** Shortcuts: H panels, Space play/pause, ←/→ step 1 h (Shift 6 h), Esc stops path drawing, Q / E turn the visible
 *  view 15° left / right and N puts north up (brief 4; state/rotation.ts routes them to the map or the Forensic camera;
 *  not while a popover is open). Ignored while typing; Space/arrows only act when focus is not on another control. */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      const s = useStore.getState()
      const onControl = (e.target as HTMLElement | null)?.closest?.('button, [role="slider"], a, [tabindex]') != null
      const turn = rotationKey(e)
      if (turn) {
        // a held key repeats the turn; an open menu or list keeps its letters (type-ahead)
        if (!popoverOpen(document, e.target) && runRotationKey(turn)) e.preventDefault()
      } else if (e.key === 'h' || e.key === 'H') {
        s.togglePanelsCollapsed()
        e.preventDefault()
      } else if (e.key === ' ' && !onControl) {
        if (s.manifest) s.togglePlaying()
        e.preventDefault()
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !onControl && s.manifest) {
        s.setPlaying(false)
        s.stepTime((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 6 : 1) * HOUR)
        e.preventDefault()
      } else if (e.key === 'Escape' && s.drawingPath) {
        s.setDrawingPath(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
