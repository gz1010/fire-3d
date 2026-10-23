// Compact floating timeline (owner: official-web since brief 2, earlier timeline-feed; CONTRACT §7, BRIEF §7) for Public/Command: play/pause, a scrubber
// over past observations (solid line) and the selected forecast (dashed), the Past / NOW / +24h / +48h / +72h stops
// (disabled with a reason when the forecast does not cover them), key-event markers, the valid time with the forecast
// issue time, and live freshness: the latest observation and the actual current time, with a stale flag.
// Keyboard: the track is a slider (←/→ 1 h, Shift 6 h, PgUp/PgDn 24 h, Home/End, Space play/pause); stops and the
// forecast details are buttons. Playback runs in state/runtime.ts (usePlayback); the time lives in the main store.
// Public uses plain words ("model re-run on past weather", no run id); Command keeps "hindcast" and the run id.
import { Info, Pause, Play, TriangleAlert } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ForecastManifest } from '../../api/types'
import { forecastDescription, modeledArea } from '../../lib/plainLanguage'
import { HOUR_MS, fmtAt, fmtClock, fmtDayDate, fmtRelative, localDayTicks, zoneLine, type TimeFmt } from '../../lib/time'
import { useIncidentAnnotations } from '../../state/annotations'
import { useStore } from '../../state/store'
import { useTimeFormat, useZoneSource } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { Popover } from '../controls'
import { EVENT_STYLE, type EventKind } from '../eventMeta'
import { buildFeedItems, selectFeedItem, selectionId } from '../feed/feedModel'
import type { FeedItem } from '../feed/types'
import { useElementSize, useNow } from '../hooks'
import {
  STALE_AFTER_MS,
  activeStop,
  buildCompactTimeline,
  clampToData,
  describeTime,
  forecastWord,
  labelsCoverPoints,
  spreadLabels,
  trackScale,
  type CompactTimelineModel,
  type TimelineStop,
  type TrackScale,
} from './model'
import './compactTimeline.css'

/** Horizontal inset of the track inside its row (px): keeps the thumb and end labels inside the panel. */
const PAD = 10
const LANE_Y = 15
const TRACK_H = 26

export function CompactTimeline() {
  const st = useStore(
    useShallow((s) => ({
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      forecast: s.forecast,
      forecastRunId: s.forecastRunId,
      playing: s.playing,
      events: s.events,
      incidentId: s.incidentId,
      loading: s.incidentLoading,
    })),
  )
  const command = useWorkspace((s) => s.preset === 'command')
  const tf = useTimeFormat()
  const wall = useNow(30_000)
  const notes = useIncidentAnnotations(st.incidentId)
  const model = useMemo(
    () => (st.manifest ? buildCompactTimeline(st.manifest, st.forecast, st.manifest.time_range.now_ms, wall, { forecastRunId: st.forecastRunId }) : null),
    [st.manifest, st.forecast, st.forecastRunId, wall],
  )
  const markers = useMemo(() => (st.manifest ? buildFeedItems({ manifest: st.manifest, events: st.events?.events ?? [], annotations: notes, tf }) : []), [st.manifest, st.events, notes, tf])

  if (!model)
    return (
      <section className="ctl is-empty" aria-label="Timeline">
        <span className="ctl-empty">{st.loading ? 'Loading the timeline…' : 'The timeline appears once the incident data is ready.'}</span>
      </section>
    )
  return (
    <section className={`ctl mode-${model.mode} ${command ? 'is-command' : ''}`} aria-label="Timeline">
      <button
        type="button"
        className={`ctl-play ${st.playing ? 'is-playing' : ''}`}
        aria-label={st.playing ? 'Pause playback' : 'Play through the timeline'}
        data-tip={st.playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => useStore.getState().togglePlaying()}
      >
        {st.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <TimelineBody model={model} markers={markers} command={command} forecast={st.forecast} />
    </section>
  )
}

function TimelineBody({ model, markers, command, forecast }: { model: CompactTimelineModel; markers: FeedItem[]; command: boolean; forecast: ForecastManifest | null }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const scale = useMemo(() => trackScale(model), [model])
  const w = size.width
  return (
    <div className="ctl-body" ref={ref}>
      <span id="ctl-track-help" className="ctl-sr">
        Arrow keys move one hour (Shift: six hours), Page Up and Page Down move a day, Home and End jump to the ends, Space plays or pauses.
      </span>
      {w > 60 && (
        <>
          {command && <ZoneLabels model={model} scale={scale} w={w} />}
          <Track model={model} scale={scale} w={w} markers={markers} command={command} />
          <Stops model={model} scale={scale} w={w} />
        </>
      )}
      <Status model={model} forecast={forecast} command={command} />
    </div>
  )
}

const xAt = (scale: TrackScale, w: number, t: number) => PAD + scale.toFrac(t) * Math.max(1, w - 2 * PAD)

// ------------------------------------------------------------------------------------------------- zone labels
function ZoneLabels({ model, scale, w }: { model: CompactTimelineModel; scale: TrackScale; w: number }) {
  const live = model.mode === 'live'
  const fc = model.forecast
  const labels: { x: number; text: string; cls: string }[] = [{ x: PAD, text: 'Observations', cls: 'is-obs' }]
  if (fc) labels.push({ x: xAt(scale, w, Math.max(fc.startMs, live ? model.latestObservationMs : fc.startMs)), text: `${live ? 'Forecast' : 'Hindcast'} · ${fc.horizonH} h`, cls: 'is-fc' })
  if (model.unavailable) labels.push({ x: xAt(scale, w, model.unavailable.startMs), text: fc ? 'Not covered' : 'No forecast', cls: 'is-off' })
  // drop a label that would collide with the one before it
  const kept = labels.filter((l, i) => i === 0 || l.x - labels[i - 1].x > 70)
  return (
    <div className="ctl-zones" aria-hidden="true">
      {kept.map((l) => (
        <span key={l.cls} className={`ctl-zone ${l.cls}`} style={{ left: l.x + 2 }}>
          {l.text}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------- track
interface TrackProps {
  model: CompactTimelineModel
  scale: TrackScale
  w: number
  markers: FeedItem[]
  command: boolean
}

function valueText(model: CompactTimelineModel, t: number, command: boolean, tf: TimeFmt): string {
  const d = describeTime(model, t)
  const when = fmtAt(t, tf, { zone: true })
  const fcWord = forecastWord(model.mode, command)
  if (d.currentKind === 'forecast') return `${when}, ${fcWord} +${Math.round(d.leadH ?? 0)} h`
  if (d.currentKind === 'observation') return `${when}, observed${d.inForecastPeriod ? `, ${fcWord} +${Math.round(d.leadH ?? 0)} h` : ''}`
  return `${when}, no data`
}

function Track({ model, scale, w, markers, command }: TrackProps) {
  const tf = useTimeFormat()
  const ref = useRef<HTMLDivElement | null>(null)
  const dragging = useRef<{ wasPlaying: boolean } | null>(null)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const inner = Math.max(1, w - 2 * PAD)
  const xOf = (t: number) => PAD + scale.toFrac(t) * inner
  const tOf = (x: number) => scale.toTime((x - PAD) / inner)

  const setFromClientX = (clientX: number, snap: boolean) => {
    const el = ref.current
    if (!el) return
    const x = clientX - el.getBoundingClientRect().left
    let t = tOf(x)
    if (snap)
      for (const s of model.stops)
        if (s.available && s.tMs != null && Math.abs(xOf(s.tMs) - x) < 6) {
          t = s.tMs
          break
        }
    useStore.getState().setTimeMs(clampToData(model, t))
  }
  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ctl-marker')) return
    const s = useStore.getState()
    dragging.current = { wasPlaying: s.playing }
    s.setPlaying(false)
    e.currentTarget.setPointerCapture(e.pointerId)
    setFromClientX(e.clientX, !e.altKey)
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHoverX(Math.min(w - PAD, Math.max(PAD, e.clientX - r.left)))
    if (dragging.current) setFromClientX(e.clientX, !e.altKey)
  }
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragging.current
    if (!d) return
    dragging.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (d.wasPlaying) useStore.getState().setPlaying(true)
  }
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const s = useStore.getState()
    const step = e.shiftKey ? 6 * HOUR_MS : HOUR_MS
    let t: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = s.timeMs + step
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = s.timeMs - step
    else if (e.key === 'PageUp') t = s.timeMs + 24 * HOUR_MS
    else if (e.key === 'PageDown') t = s.timeMs - 24 * HOUR_MS
    else if (e.key === 'Home') t = model.startMs
    else if (e.key === 'End') t = model.endMs
    else if (e.key === ' ') {
      s.togglePlaying()
      e.preventDefault()
      return
    } else return
    e.preventDefault()
    s.setPlaying(false)
    s.setTimeMs(clampToData(model, t))
  }
  const hoverT = hoverX != null ? clampToData(model, tOf(hoverX)) : null
  return (
    <div
      ref={ref}
      className="ctl-track"
      role="slider"
      tabIndex={0}
      aria-label="Timeline time"
      aria-valuemin={model.startMs}
      aria-valuemax={model.endMs}
      aria-describedby="ctl-track-help"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHoverX(null)}
      onKeyDown={onKey}
    >
      <div className="ctl-lanes is-dim">
        <Lanes model={model} scale={scale} w={w} />
      </div>
      <Played model={model} scale={scale} w={w} trackRef={ref} command={command} />
      <Decor model={model} scale={scale} w={w} />
      <Markers markers={markers} scale={scale} w={w} model={model} />
      <Thumb model={model} scale={scale} w={w} />
      {hoverX != null && hoverT != null && (
        <span className={`ctl-ghost ${hoverX < 50 ? 'is-left' : hoverX > w - 50 ? 'is-right' : ''}`} style={{ left: hoverX }} aria-hidden="true">
          {fmtAt(hoverT, tf)}
        </span>
      )}
    </div>
  )
}

/** Observed (solid) and forecast (dashed) lanes; unavailable hours dotted. A hindcast that overlaps the record is
 *  drawn as a second, lower dashed lane so both stay visible. Drawn twice: dimmed, and bright up to the time. */
const Lanes = memo(function Lanes({ model, scale, w }: { model: CompactTimelineModel; scale: TrackScale; w: number }) {
  const x = (t: number) => xAt(scale, w, t)
  const latest = model.latestObservationMs
  const fc = model.forecast
  const overlap = fc != null && fc.startMs < latest - HOUR_MS
  return (
    <svg width={w} height={TRACK_H} aria-hidden="true" focusable="false">
      <line className="ctl-lane-obs" x1={x(model.startMs)} x2={x(latest)} y1={LANE_Y} y2={LANE_Y} />
      {fc && fc.endMs > latest && <line className="ctl-lane-fc" x1={x(Math.max(latest, fc.startMs))} x2={x(fc.endMs)} y1={LANE_Y} y2={LANE_Y} />}
      {fc && overlap && <line className="ctl-lane-fc is-overlap" x1={x(fc.startMs)} x2={x(Math.min(latest, fc.endMs))} y1={LANE_Y + 6} y2={LANE_Y + 6} />}
      {model.unavailable && <line className="ctl-lane-off" x1={x(model.unavailable.startMs)} x2={x(model.unavailable.endMs)} y1={LANE_Y} y2={LANE_Y} />}
    </svg>
  )
})

/** Bright copy of the lanes up to the timeline time (a clipped box; the lanes themselves are memoised). */
function Played({ model, scale, w, trackRef, command }: { model: CompactTimelineModel; scale: TrackScale; w: number; trackRef: RefObject<HTMLDivElement | null>; command: boolean }) {
  const t = useStore((s) => s.timeMs)
  const tf = useTimeFormat()
  const x = xAt(scale, w, t)
  // keep the slider's ARIA value current without re-rendering the track
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    el.setAttribute('aria-valuenow', String(Math.round(t)))
    el.setAttribute('aria-valuetext', valueText(model, t, command, tf))
  }, [t, model, trackRef, command, tf])
  return (
    <div className="ctl-lanes is-played" style={{ width: Math.max(0, x) }}>
      <Lanes model={model} scale={scale} w={w} />
    </div>
  )
}

/** Day ticks, stop ticks, the NOW / forecast-start marker and the actual current time. */
const Decor = memo(function Decor({ model, scale, w }: { model: CompactTimelineModel; scale: TrackScale; w: number }) {
  const tf = useTimeFormat()
  const x = (t: number) => xAt(scale, w, t)
  const days = localDayTicks(model.startMs, model.trackEndMs, tf.tz, 1).filter((t) => t > model.startMs && t < model.trackEndMs)
  const wall = model.wallClockMs
  const showWall = model.mode === 'live' && wall >= model.startMs && wall <= model.trackEndMs && Math.abs(x(wall) - x(model.latestObservationMs)) > 3
  return (
    <svg className="ctl-decor" width={w} height={TRACK_H} aria-hidden="true" focusable="false">
      {days.map((t) => (
        <line key={t} className="ctl-day" x1={x(t)} x2={x(t)} y1={LANE_Y + 4} y2={LANE_Y + 8} />
      ))}
      {model.stops.map((s) =>
        s.kind === 'forecast' && s.posMs != null ? <line key={s.id} className={`ctl-stop-tick ${s.available ? '' : 'is-off'}`} x1={x(s.posMs)} x2={x(s.posMs)} y1={LANE_Y - 4} y2={LANE_Y + 4} /> : null,
      )}
      {model.nowMarkerMs != null && <line className="ctl-now" x1={x(model.nowMarkerMs)} x2={x(model.nowMarkerMs)} y1={LANE_Y - 7} y2={LANE_Y + 7} />}
      {showWall && (
        <g className="ctl-wall">
          <line x1={x(wall)} x2={x(wall)} y1={LANE_Y - 5} y2={LANE_Y + 9} />
          <circle cx={x(wall)} cy={LANE_Y + 10} r={2} />
        </g>
      )}
    </svg>
  )
})

function Thumb({ model, scale, w }: { model: CompactTimelineModel; scale: TrackScale; w: number }) {
  const t = useStore((s) => s.timeMs)
  const kind = describeTime(model, t).currentKind
  const inside = t >= model.startMs && t <= model.trackEndMs
  return <span className={`ctl-thumb is-${kind} ${inside ? '' : 'is-out'}`} style={{ left: xAt(scale, w, t), top: LANE_Y }} aria-hidden="true" />
}

/** Greedy de-overlap of marker x positions (min spacing), re-centred per cluster. */
function spreadPositions(xs: number[], minGap: number): number[] {
  const out = xs.slice()
  let i = 0
  while (i < out.length) {
    let j = i
    while (j + 1 < out.length && xs[j + 1] - xs[j] < minGap) j++
    if (j > i) {
      const mean = xs.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1)
      for (let k = i; k <= j; k++) out[k] = mean - ((j - i) * minGap) / 2 + (k - i) * minGap
    }
    i = j + 1
  }
  return out
}

function Markers({ markers, scale, w, model }: { markers: FeedItem[]; scale: TrackScale; w: number; model: CompactTimelineModel }) {
  const selected = useStore((s) => s.selectedEventId)
  const tf = useTimeFormat()
  const visible = markers.filter((m) => m.tMs >= model.startMs && m.tMs <= model.trackEndMs)
  const xs = spreadPositions(
    visible.map((m) => xAt(scale, w, m.tMs)),
    9,
  )
  return (
    <div className="ctl-markers">
      {visible.map((m, i) => {
        const style = EVENT_STYLE[m.topic as EventKind]
        const sel = selected != null && selected === selectionId(m)
        return (
          <button
            key={m.id}
            type="button"
            tabIndex={-1}
            className={`ctl-marker ${sel ? 'is-selected' : ''}`}
            style={{ left: xs[i], color: style?.color ?? 'var(--m-event)' }}
            aria-label={`${m.title}, ${fmtAt(m.tMs, tf)}`}
            data-tip={`${m.title} · ${fmtAt(m.tMs, tf, { zone: true })}`}
            onClick={() => selectFeedItem(m)}
          />
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------- stops
const SHORT: Partial<Record<string, string>> = { 'Forecast start': 'Start', 'Latest data': 'Latest' }
const labelWidth = (s: string) => s.length * 6.4 + 14

function stopTip(s: TimelineStop, tf: TimeFmt): string {
  if (!s.available || s.tMs == null) return `${s.label}: not available. ${s.reason ?? ''}`.trim()
  return `${s.description}: ${fmtAt(s.tMs, tf, { zone: true })}`
}

/** Stop labels spread under the track: the full labels while each still covers its point, else the short ones. */
function layoutStops(model: CompactTimelineModel, scale: TrackScale, w: number) {
  const placed = model.stops.filter((s) => s.posMs != null)
  const grouped = model.stops.filter((s) => s.posMs == null)
  const points = placed.map((s) => xAt(scale, w, s.posMs as number))
  const attempt = (short: boolean) => {
    const label = (s: TimelineStop) => (short ? (SHORT[s.label] ?? s.label) : s.label)
    const widths = placed.map((s) => labelWidth(label(s)))
    const groupW = grouped.reduce((a, s) => a + labelWidth(label(s)) + 2, 0)
    const centers = spreadLabels(points, widths, 0, w - (grouped.length ? groupW + 8 : 0), 3)
    return { label, centers, fits: labelsCoverPoints(points, centers, widths) }
  }
  const full = attempt(false)
  return { placed, grouped, ...(full.fits ? full : attempt(true)) }
}

function Stops({ model, scale, w }: { model: CompactTimelineModel; scale: TrackScale; w: number }) {
  const activeId = useStore((s) => activeStop(model, s.timeMs)?.id ?? null)
  const tf = useTimeFormat()
  const { placed, grouped, label, centers } = useMemo(() => layoutStops(model, scale, w), [model, scale, w])
  const jump = (s: TimelineStop) => {
    if (!s.available || s.tMs == null) return
    const st = useStore.getState()
    st.setPlaying(false)
    st.setTimeMs(clampToData(model, s.tMs))
  }
  const button = (s: TimelineStop, style?: { left: number }) => (
    <button
      key={s.id}
      type="button"
      className={`ctl-stop is-${s.kind} ${s.available ? '' : 'is-off'} ${activeId === s.id ? 'is-active' : ''}`}
      style={style}
      aria-disabled={!s.available}
      aria-current={activeId === s.id ? 'time' : undefined}
      aria-label={s.available && s.tMs != null ? `${s.label}: ${s.description}, ${fmtAt(s.tMs, tf, { zone: true })}` : `${s.label}: not available, ${s.reason ?? ''}`}
      data-tip={stopTip(s, tf)}
      onClick={() => jump(s)}
    >
      {label(s)}
    </button>
  )
  return (
    <div className="ctl-stops">
      {placed.map((s, i) => button(s, { left: centers[i] }))}
      {grouped.length > 0 && (
        <span className="ctl-stop-group" title={grouped[grouped.length - 1].reason ?? undefined}>
          {grouped.map((s) => button(s))}
        </span>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------- status
function KindGlyph({ kind }: { kind: 'observation' | 'forecast' | 'beyond' }) {
  return (
    <svg className={`ctl-glyph is-${kind}`} width="16" height="6" aria-hidden="true" focusable="false">
      <line x1="1" x2="15" y1="3" y2="3" />
    </svg>
  )
}

const FORECAST_STATE: Record<string, string> = {
  loading: 'Forecast loading…',
  running: 'Forecast run in progress',
  failed: 'Forecast run failed',
  unselected: 'No forecast selected',
  none: 'No forecast yet',
}

function Status({ model, forecast, command }: { model: CompactTimelineModel; forecast: ForecastManifest | null; command: boolean }) {
  const minute = useStore((s) => Math.floor(s.timeMs / 60_000))
  const tf = useTimeFormat()
  const zoneSource = useZoneSource()
  const t = minute * 60_000
  const d = describeTime(model, t)
  const live = model.mode === 'live'
  const word = forecastWord(model.mode, command)
  const fcWord = word[0].toUpperCase() + word.slice(1)
  const lead = d.leadH != null ? `+${Math.round(d.leadH)} h` : ''
  let kindText: string
  if (d.currentKind === 'forecast') kindText = `${fcWord} ${lead}${live ? '' : ' (after the record)'}`
  else if (d.currentKind === 'observation') kindText = d.inForecastPeriod && !live ? `Observed · ${word} ${lead}` : 'Observed'
  else kindText = 'No data for this time'
  const fc = model.forecast
  return (
    <div className="ctl-status">
      <span className="ctl-valid">
        <time
          className="ctl-time"
          dateTime={new Date(t).toISOString()}
          data-tip={`Time shown on the map${fc && d.inForecastPeriod ? ' (the forecast valid time)' : ''}. ${zoneLine(tf, t, zoneSource)}${command ? ` · ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`}
        >
          {fmtAt(t, tf, { zone: true })}
        </time>
        <span className={`ctl-kind is-${d.currentKind}`}>
          <KindGlyph kind={d.currentKind} />
          {kindText}
        </span>
      </span>
      {fc && forecast ? (
        <ForecastInfo model={model} forecast={forecast} t={t} command={command} />
      ) : (
        <span className="ctl-fcinfo is-missing">{model.forecastStatus === 'none' && !live ? (command ? 'No hindcast run for this fire' : 'No model re-run for this fire') : (FORECAST_STATE[model.forecastStatus] ?? '')}</span>
      )}
      {live ? <Freshness model={model} /> : <span className="ctl-replay">Historical replay · {fmtDayDate(model.startMs, tf.tz, { year: 'always' })} – {fmtDayDate(model.latestObservationMs, tf.tz, { year: 'always' })}</span>}
    </div>
  )
}

function ForecastInfo({ model, forecast, t, command }: { model: CompactTimelineModel; forecast: ForecastManifest; t: number; command: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const units = useWorkspace((s) => s.units)
  const tf = useTimeFormat()
  const live = model.mode === 'live'
  const fc = model.forecast
  if (!fc) return null
  const issued = live ? `Issued ${fmtAt(fc.issuedMs, tf, { zone: true })}` : command ? `Hindcast run ${fmtDayDate(fc.issuedMs, tf.tz, { year: 'always' })}` : `Model re-run on past weather · ${fmtDayDate(fc.issuedMs, tf.tz, { year: 'always' })}`
  const desc = forecastDescription(forecast, model.mode, { plain: !command, tf })
  const title = desc.title
  const areaNow = modeledArea(forecast, t, units)
  const warn = model.forecastNotes.length > 0
  // the valid time: the timeline time the map shows, placed relative to the forecast period
  const lead = describeTime(model, t).leadH
  const validWhere = lead != null ? `${forecastWord(model.mode, command)} +${Math.round(lead)} h` : t < fc.startMs ? 'before the forecast period' : 'after the forecast period'
  return (
    <span className="ctl-fcinfo">
      <button
        ref={anchor}
        type="button"
        className={`ctl-fcbtn ${warn ? 'is-warn' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        data-tip={`About this forecast: period, chances and uncertainty${command ? ` · run ${fc.runId}` : ''}`}
      >
        {warn ? <TriangleAlert size={12} /> : <Info size={12} />}
        {issued}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" width={340} label="About this forecast" className="ctl-pop">
        <div className="ctl-pop-body">
          <h3>{title}</h3>
          <dl>
            <dt>Map shows</dt>
            <dd>
              {fmtAt(t, tf, { zone: true })} ({validWhere})
            </dd>
            <dt>Period</dt>
            <dd>{desc.period}</dd>
            <dt>{live ? 'Issued' : 'Run'}</dt>
            <dd>{live ? `${fmtAt(fc.issuedMs, tf, { zone: true })}` : `${fmtAt(fc.issuedMs, tf, { year: 'always', zone: true })}, after the fire`}</dd>
            <dt>Model runs</dt>
            <dd>{desc.runs}</dd>
            {command && (
              <>
                <dt>Run ID</dt>
                <dd className="ctl-run">{fc.runId}</dd>
              </>
            )}
            <dt>Weather</dt>
            <dd>{desc.weather}</dd>
            {areaNow && (
              <>
                <dt>Modeled area</dt>
                <dd>
                  {areaNow.text} by {fmtAt(areaNow.tMs, tf, { zone: true })}
                </dd>
              </>
            )}
          </dl>
          <p>{desc.probability}</p>
          <p>{desc.uncertainty}</p>
          {model.forecastNotes.map((n) => (
            <p key={n} className="ctl-pop-warn">
              {n}
            </p>
          ))}
          {forecast.warnings.length > 0 && (
            <details className="ctl-pop-notes">
              <summary>Model settings and notes ({forecast.warnings.length})</summary>
              <ul>
                {forecast.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="ctl-pop-caveat">{desc.caveat}</p>
        </div>
      </Popover>
    </span>
  )
}

function Freshness({ model }: { model: CompactTimelineModel }) {
  const latest = model.latestObservationMs
  const wall = model.wallClockMs
  const stale = model.stale.isStale
  const tf = useTimeFormat()
  // the date only when it is not the current day (in the fire's zone)
  const fmt = (ms: number) => (fmtDayDate(ms, tf.tz) !== fmtDayDate(wall, tf.tz) ? fmtAt(ms, tf, { zone: true }) : fmtClock(ms, tf, { zone: true }))
  const tip = `Latest observation = the newest satellite detection, mapped perimeter or confirmed satellite pass over the fire that saw no new fire. Fire-3d flags live data as stale when that is more than ${STALE_AFTER_MS / HOUR_MS} h older than the current time. Satellites pass over only a few times a day, so gaps can be normal; it means "check the time", not "the fire is out". Data last refreshed ${fmtRelative(model.checkedMs, wall)}.`
  return (
    <span className="ctl-fresh">
      <span className={`ctl-latest ${stale ? 'is-stale' : ''}`} data-tip={tip}>
        {stale ? (
          <TriangleAlert size={12} aria-hidden="true" />
        ) : (
          <svg className="ctl-latest-glyph" width="4" height="12" aria-hidden="true" focusable="false">
            <line x1="2" x2="2" y1="1" y2="11" />
          </svg>
        )}
        Latest observation <time dateTime={new Date(latest).toISOString()}>{fmt(latest)}</time> ({fmtRelative(latest, wall)})
        {stale && <span className="ctl-stale">Stale</span>}
      </span>
      <span className="ctl-clock" data-tip="The actual current time; the blue dotted mark on the track shows where it falls">
        <svg className="ctl-clock-glyph" width="6" height="12" aria-hidden="true" focusable="false">
          <line x1="3" x2="3" y1="0" y2="9" />
          <circle cx="3" cy="10" r="2" />
        </svg>
        Current time <time dateTime={new Date(wall).toISOString()}>{fmt(wall)}</time>
      </span>
    </span>
  )
}
