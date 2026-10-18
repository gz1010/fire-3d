// App-level runtime hooks: rAF playback, live polling (manifest 60 s, aircraft 10 s, catalog 5 min, live status),
// URL state (?incident=&t=&mode=) and keyboard shortcuts. Mounted once by App so they keep running while the
// panels are collapsed.
import { useEffect } from 'react'
import type { IncidentSummary, Mode } from '../api/types'
import { defaultTimeFor, getTimeBounds, useStore } from './store'

const HOUR = 3_600_000

/** Advance store.timeMs with requestAnimationFrame while `playing` (speed in hours per second). Stops at the end of
 *  the visible window; pressing play at the end restarts from the window start. */
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
    if (s0.timeMs >= w0.endMs - 60_000 || s0.timeMs < w0.startMs) s0.setTimeMs(w0.startMs)
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
 *  store.aircraft, the live catalog every 5 min and /live/status every 60 s. Paused while the tab is hidden. */
export function useLivePolling(): void {
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
    if (mode !== 'live' || !id || !ready) return
    const poll = () => visible() && void useStore.getState().refreshAircraft()
    poll()
    const t = window.setInterval(poll, 10_000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [mode, id, ready, aircraftAll])

  useEffect(() => {
    if (mode !== 'live') return
    const st = useStore.getState()
    void st.refreshLiveStatus()
    const t1 = window.setInterval(() => visible() && void useStore.getState().refreshLiveStatus(), 60_000)
    const t2 = window.setInterval(() => visible() && void useStore.getState().loadCatalog({ modes: ['live'] }), 5 * 60_000)
    return () => {
      window.clearInterval(t1)
      window.clearInterval(t2)
    }
  }, [mode])
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

/** Shortcuts: H panels, Space play/pause, ←/→ step 1 h (Shift 6 h), Esc stops path drawing. Ignored while typing;
 *  Space/arrows only act when focus is not on another control. */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      const s = useStore.getState()
      const onControl = (e.target as HTMLElement | null)?.closest?.('button, [role="slider"], a, [tabindex]') != null
      if (e.key === 'h' || e.key === 'H') {
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

/** Default incident (SPEC 9.4). */
export function pickDefault(live: IncidentSummary[], historical: IncidentSummary[], mode: Mode | null): string | null {
  const liveReady = live.filter((i) => i.bundle_status === 'ready').sort((a, b) => (b.acres ?? 0) - (a.acres ?? 0))[0]
  if (mode !== 'historical' && liveReady) return liveReady.id
  const eaton = historical.find((i) => i.year === 2025 && /\beaton\b/i.test(i.name))
  if (mode === 'live' && live[0]) return live[0].id
  return eaton?.id ?? historical[0]?.id ?? live[0]?.id ?? null
}
