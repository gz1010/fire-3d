// Timeline (SPEC 9.4): play / pause / step 1 h, speed 0.5–24 h/s, scrubber with a time bubble, Pacific-time day and
// 6-hour ticks, event markers, an hourly fire-activity strip, the "Now" marker with a hatched forecast region after
// it, and window presets All / 7 d / 72 h (+ forecast). Playback itself runs in state/runtime.ts (rAF).
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ForecastManifest, IncidentManifest, TimeseriesFile } from '../api/types'
import { HOUR_MS, fmtDateTime, fmtDay, fmtTPlus, laWallTicks, tickStepHours, tzLabel } from '../lib/time'
import { useIncidentAnnotations } from '../state/annotations'
import { SPEEDS_HOURS_PER_SEC, getTimeBounds, nowMarkerMs, useStore, type TimeWindow, type WindowPreset } from '../state/store'
import { IconButton, Segmented, SelectMenu } from './controls'
import { EVENT_STYLE } from './eventMeta'
import { useElementSize } from './hooks'
import { goToItem, mergeEvents, useTimelineWindow, type TimelineItem } from './timelineModel'

const PAD = 12
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function Timeline() {
  const { manifest, forecast, preset, playing, speed, events, timeseries, incidentId } = useStore(
    useShallow((s) => ({
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      forecast: s.forecast,
      preset: s.windowPreset,
      playing: s.playing,
      speed: s.speedHoursPerSec,
      events: s.events,
      timeseries: s.timeseries,
      incidentId: s.incidentId,
    })),
  )
  const notes = useIncidentAnnotations(incidentId)
  const items = useMemo(() => mergeEvents(events?.events, notes), [events, notes])
  const win = useTimelineWindow()
  const st = useStore.getState
  const disabled = !manifest || !win
  return (
    <div className={`tl ${disabled ? 'is-disabled' : ''}`}>
      <div className="tl-top">
        <span className="dock-title">Timeline</span>
        <div className="tl-ctrl">
          <IconButton icon={<ChevronLeft size={15} />} label="Back 1 h (←)" disabled={disabled} onClick={() => (st().setPlaying(false), st().stepTime(-HOUR_MS))} />
          <button type="button" className={`tl-play ${playing ? 'is-playing' : ''}`} disabled={disabled} aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} data-tip={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => st().togglePlaying()}>
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <IconButton icon={<ChevronRight size={15} />} label="Forward 1 h (→)" disabled={disabled} onClick={() => (st().setPlaying(false), st().stepTime(HOUR_MS))} />
          <SelectMenu<number>
            value={speed}
            label="Playback speed (hours per second)"
            tip="Playback speed"
            className="tl-speed"
            display={
              <span className="mono">
                {speed} <span className="muted">h/s</span>
              </span>
            }
            options={SPEEDS_HOURS_PER_SEC.map((v) => ({ value: v, label: <span className="mono">{v} h/s</span>, hint: v === 1 ? '1 h per second' : undefined }))}
            onChange={(v) => st().setSpeedHoursPerSec(v)}
            width={150}
          />
        </div>
        <TimeReadout manifest={manifest} forecast={forecast} />
        <span className="flex-1" />
        <Segmented<WindowPreset>
          size="sm"
          value={preset}
          onChange={(p) => st().setWindowPreset(p)}
          ariaLabel="Timeline window"
          options={[
            { value: 'all', label: 'All', tip: 'Whole record, plus the selected forecast' },
            { value: '7d', label: '7 d', tip: 'Last 7 days before Now, plus the forecast' },
            { value: '72h', label: '72 h', tip: 'Last 72 hours before Now, plus the forecast' },
          ]}
        />
        {win && (
          <span className="tl-range mono" data-tip={`Window shown · times in ${tzLabel(win.startMs)}`}>
            {fmtDateTime(win.startMs)} – {fmtDateTime(win.endMs)}
          </span>
        )}
      </div>
      {manifest && win ? (
        <Track manifest={manifest} forecast={forecast} win={win} items={items} timeseries={timeseries} />
      ) : (
        <div className="tl-empty muted">No timeline yet: the incident bundle is not loaded.</div>
      )}
    </div>
  )
}

function TimeReadout({ manifest, forecast }: { manifest: IncidentManifest | null; forecast: ForecastManifest | null }) {
  const minute = useStore((s) => Math.floor(s.timeMs / 60_000))
  if (!manifest) return <span className="tl-now mono muted">—</span>
  const t = minute * 60_000
  const ign = manifest.ignition?.t_ms ?? manifest.time_range.start_ms
  const nowM = nowMarkerMs(manifest, forecast)
  const fcEnd = forecast ? forecast.start_ms + forecast.horizon_h * HOUR_MS : null
  const inForecast = nowM != null && forecast != null && fcEnd != null && t > nowM + 60_000 && t <= fcEnd
  const live = manifest.mode === 'live'
  return (
    <span className="tl-now">
      <span className="mono gold-strong">
        {fmtDateTime(t)} <span className="tl-tz">{tzLabel(t)}</span>
      </span>
      <span className="mono muted" data-tip="Time since ignition">
        {fmtTPlus((t - ign) / HOUR_MS)}
      </span>
      {inForecast && (
        <span className={`chip ${live ? 'chip-live' : 'chip-gold'} tl-fc-chip`} data-tip={live ? 'After the latest observation: forecast only' : 'Inside the selected hindcast window: forecast vs. observed'}>
          {live ? 'forecast' : 'hindcast'}
        </span>
      )}
    </span>
  )
}

interface TrackProps {
  manifest: IncidentManifest
  forecast: ForecastManifest | null
  win: TimeWindow
  items: TimelineItem[]
  timeseries: TimeseriesFile | null
}

function Track({ manifest, forecast, win, items, timeseries }: TrackProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const dragging = useRef(false)
  const wasPlaying = useRef(false)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const w = size.width
  const span = Math.max(1, win.endMs - win.startMs)
  const inner = Math.max(1, w - 2 * PAD)
  const xOf = useCallback((t: number) => PAD + ((t - win.startMs) / span) * inner, [win.startMs, span, inner])
  const tOf = (x: number) => win.startMs + ((x - PAD) / inner) * span
  const bounds = getTimeBounds({ manifest, forecast })!
  const nowM = nowMarkerMs(manifest, forecast)
  const fcEnd = forecast ? forecast.start_ms + forecast.horizon_h * HOUR_MS : null

  const setFromX = (clientX: number, snap: boolean) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let t = tOf(clientX - r.left)
    if (snap && nowM != null && Math.abs(xOf(nowM) - (clientX - r.left)) < 6) t = nowM
    useStore.getState().setTimeMs(clamp(t, Math.max(win.startMs, bounds.startMs), Math.min(win.endMs, bounds.endMs)))
  }
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.tl-marker')) return
    const s = useStore.getState()
    wasPlaying.current = s.playing
    s.setPlaying(false)
    dragging.current = true
    setIsDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
    setFromX(e.clientX, !e.altKey)
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHoverX(clamp(e.clientX - r.left, PAD, w - PAD))
    if (dragging.current) setFromX(e.clientX, !e.altKey)
  }
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    setIsDragging(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (wasPlaying.current) useStore.getState().setPlaying(true)
  }
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const s = useStore.getState()
    const step = e.shiftKey ? 6 * HOUR_MS : HOUR_MS
    let handled = true
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') s.stepTime(step)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') s.stepTime(-step)
    else if (e.key === 'PageUp') s.stepTime(24 * HOUR_MS)
    else if (e.key === 'PageDown') s.stepTime(-24 * HOUR_MS)
    else if (e.key === 'Home') s.setTimeMs(win.startMs)
    else if (e.key === 'End') s.setTimeMs(win.endMs)
    else if (e.key === ' ') s.togglePlaying()
    else handled = false
    if (handled) {
      if (e.key !== ' ') s.setPlaying(false)
      e.preventDefault()
    }
  }
  const ready = w > 40
  return (
    <div
      ref={ref}
      className="tl-track"
      role="slider"
      tabIndex={0}
      aria-label="Timeline time"
      aria-valuemin={win.startMs}
      aria-valuemax={win.endMs}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHoverX(null)}
      onKeyDown={onKey}
    >
      {ready && (
        <>
          <TrackSvg w={w} winStart={win.startMs} winEnd={win.endMs} xOf={xOf} nowM={nowM} fcEnd={fcEnd} timeseries={timeseries} live={manifest.mode === 'live'} b0={bounds.startMs} b1={bounds.endMs} />
          <Markers items={items} xOf={xOf} win={win} />
          {hoverX != null && !isDragging && <HoverGhost x={hoverX} t={tOf(hoverX)} w={w} />}
          <Handle xOf={xOf} win={win} trackRef={ref} w={w} />
        </>
      )}
    </div>
  )
}

const TrackSvg = memo(function TrackSvg({
  w,
  winStart,
  winEnd,
  xOf,
  nowM,
  fcEnd,
  timeseries,
  live,
  b0,
  b1,
}: {
  w: number
  winStart: number
  winEnd: number
  xOf: (t: number) => number
  nowM: number | null
  fcEnd: number | null
  timeseries: TimeseriesFile | null
  live: boolean
  b0: number
  b1: number
}) {
  const win = { startMs: winStart, endMs: winEnd }
  const bounds = { startMs: b0, endMs: b1 }
  const BAR_Y = 24
  const BAR_H = 6
  const ticks = useMemo(() => {
    const step = tickStepHours(win.endMs - win.startMs, w - 2 * PAD, 46)
    return { step, list: laWallTicks(win.startMs, win.endMs, step) }
  }, [win.startMs, win.endMs, w])
  // hourly activity strip: growth (acres/h) normalised by the window max, sqrt-compressed
  const strip = useMemo(() => {
    if (!timeseries) return null
    const t = timeseries.t_ms
    const g = timeseries.growth_acres_per_h
    let max = 0
    for (let i = 0; i < t.length; i++) if (t[i] >= win.startMs && t[i] <= win.endMs && g[i] > max) max = g[i]
    if (max <= 0) return null
    const pxPerHour = (w - 2 * PAD) / ((win.endMs - win.startMs) / HOUR_MS)
    const out: { x: number; wd: number; a: number }[] = []
    for (let i = 0; i < t.length; i++) {
      if (t[i] < win.startMs - HOUR_MS || t[i] > win.endMs || !(g[i] > 0)) continue
      out.push({ x: xOf(t[i] - HOUR_MS), wd: Math.max(1, pxPerHour), a: Math.sqrt(g[i] / max) })
    }
    return out
  }, [timeseries, win.startMs, win.endMs, w, xOf])
  const x0 = xOf(Math.max(win.startMs, bounds.startMs))
  const x1 = xOf(Math.min(win.endMs, bounds.endMs))
  const nx = nowM != null && nowM >= win.startMs && nowM <= win.endMs ? xOf(nowM) : null
  const fx0 = nowM != null && fcEnd != null ? xOf(Math.max(nowM, win.startMs)) : null
  const fx1 = fcEnd != null ? xOf(Math.min(fcEnd, win.endMs)) : null
  return (
    <svg className="tl-svg" width={w} height="100%" aria-hidden>
      <defs>
        <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="rgba(255,106,43,0.07)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,138,76,0.55)" strokeWidth="1.6" />
        </pattern>
      </defs>
      <rect className="tl-bar" x={x0} y={BAR_Y} width={Math.max(0, x1 - x0)} height={BAR_H} rx={BAR_H / 2} />
      {strip?.map((s, i) => <rect key={i} x={s.x} y={BAR_Y} width={s.wd} height={BAR_H} fill="var(--fire)" opacity={0.12 + 0.68 * s.a} />)}
      {fx0 != null && fx1 != null && fx1 > fx0 && (
        <g className="tl-fc">
          <rect x={fx0} y={BAR_Y - 9} width={fx1 - fx0} height={BAR_H + 18} fill="url(#tl-hatch)" rx="2" />
          <line x1={fx0} x2={fx1} y1={BAR_Y - 9} y2={BAR_Y - 9} stroke="rgba(255,106,43,0.45)" />
          {fx1 - fx0 > 90 && (
            <text x={fx1 - 5} y={BAR_Y - 2} textAnchor="end" className="tl-fc-label">
              {live ? 'FORECAST' : 'HINDCAST'}
            </text>
          )}
        </g>
      )}
      {ticks.list.map((tk, i) => {
        const x = xOf(tk.t)
        const major = tk.day
        // dates on the first line (day boundaries, plus the first tick for context), times on the second
        const date = major || i === 0 ? fmtDay(tk.t) : ''
        return (
          <g key={tk.t} className={major ? 'tl-tick is-day' : 'tl-tick'}>
            <line x1={x} x2={x} y1={BAR_Y + BAR_H + 2} y2={BAR_Y + BAR_H + (major ? 8 : 5)} />
            {date && (
              <text x={x} y={BAR_Y + BAR_H + 18} className="tl-day">
                {date}
              </text>
            )}
            {ticks.step < 24 && (
              <text x={x} y={BAR_Y + BAR_H + 30} className="tl-hour">
                {tk.timeLabel}
              </text>
            )}
          </g>
        )
      })}
      {nx != null && (
        <g className="tl-nowm">
          <line x1={nx} x2={nx} y1={BAR_Y - 12} y2={BAR_Y + BAR_H + 9} />
          <text x={nx + 4} y={BAR_Y - 4}>
            {live ? 'NOW' : 'T₀'}
          </text>
        </g>
      )}
    </svg>
  )
})

/** Greedy de-overlap of marker x positions (min spacing), re-centred per cluster so markers stay near their time. */
function spreadPositions(xs: number[], minGap: number): number[] {
  const out = xs.slice()
  let i = 0
  while (i < out.length) {
    let j = i
    while (j + 1 < out.length && xs[j + 1] - xs[j] < minGap) j++
    if (j > i) {
      const mean = xs.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1)
      const width = (j - i) * minGap
      for (let k = i; k <= j; k++) out[k] = mean - width / 2 + (k - i) * minGap
    }
    i = j + 1
  }
  return out
}

function Markers({ items, xOf, win }: { items: TimelineItem[]; xOf: (t: number) => number; win: TimeWindow }) {
  const selected = useStore((s) => s.selectedEventId)
  const visible = items.filter((it) => it.t >= win.startMs && it.t <= win.endMs)
  const xs = spreadPositions(
    visible.map((it) => xOf(it.t)),
    13,
  )
  return (
    <div className="tl-markers">
      {visible.map((it, i) => {
        const style = EVENT_STYLE[it.kind]
        return (
          <button
            key={it.id}
            type="button"
            className={`tl-marker glyph-${style.glyph} ${selected === it.id ? 'is-selected' : ''}`}
            style={{ left: xs[i], color: style.color }}
            data-tip={`${it.title} · ${fmtDateTime(it.t)}`}
            aria-label={`${it.title}, ${fmtDateTime(it.t)}`}
            onClick={() => goToItem(it)}
          >
            <Glyph kind={style.glyph} />
          </button>
        )
      })}
    </div>
  )
}

export function Glyph({ kind, size = 10 }: { kind: string; size?: number }) {
  const s = size
  switch (kind) {
    case 'triangle':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10">
          <path d="M5 1 L9.2 9 H0.8 Z" fill="currentColor" />
        </svg>
      )
    case 'diamond':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10">
          <path d="M5 0.6 L9.4 5 L5 9.4 L0.6 5 Z" fill="currentColor" />
        </svg>
      )
    case 'square':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor" />
        </svg>
      )
    case 'flame':
      return (
        <svg width={s} height={s + 1} viewBox="0 0 10 11">
          <path d="M5 0.5c.4 2 2.3 2.9 2.9 4.9.8 2.6-.9 5.1-2.9 5.1S1.2 8.9 1.6 6.6c.3-1.5 1.4-2 1.6-3.4.9.7 1.1 1.5 1.1 2.3C5.6 4.3 5.4 2.4 5 .5z" fill="currentColor" />
        </svg>
      )
    case 'tick':
      return (
        <svg width={s} height={s} viewBox="0 0 10 10">
          <rect x="4" y="0.5" width="2" height="9" rx="1" fill="currentColor" />
        </svg>
      )
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 10 10">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      )
  }
}

/** Keeps a label centred on x inside [0, w]: 'is-left' / 'is-right' anchor it inward near the edges. */
const edgeClass = (x: number, w: number, half = 48) => (x < half ? 'is-left' : x > w - half ? 'is-right' : '')

function HoverGhost({ x, t, w }: { x: number; t: number; w: number }) {
  return (
    <div className={`tl-ghost ${edgeClass(x, w, 44)}`} style={{ left: x }}>
      <span className="mono">{fmtDateTime(t)}</span>
    </div>
  )
}

function Handle({ xOf, win, trackRef, w }: { xOf: (t: number) => number; win: TimeWindow; trackRef: RefObject<HTMLDivElement | null>; w: number }) {
  const timeMs = useStore((s) => s.timeMs)
  const inside = timeMs >= win.startMs && timeMs <= win.endMs
  // keep the slider's ARIA value current without re-rendering the track
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    el.setAttribute('aria-valuenow', String(Math.round(timeMs)))
    el.setAttribute('aria-valuetext', `${fmtDateTime(timeMs)} ${tzLabel(timeMs)}`)
  }, [timeMs, trackRef])
  const x = xOf(clamp(timeMs, win.startMs, win.endMs))
  const x0 = xOf(win.startMs)
  return (
    <>
      <div className="tl-played" style={{ left: x0, width: Math.max(0, x - x0) }} />
      <div className={`tl-handle ${inside ? '' : 'is-out'} ${edgeClass(x, w)}`} style={{ left: x }}>
        <span className="tl-bubble mono">{fmtDateTime(timeMs)}</span>
        <span className="tl-knob" />
      </div>
    </>
  )
}
