// Charts row (SPEC 9.4): Fire Area (observed + forecast P10–P90 band + P50), Rate of Spread (observed + forecast P50,
// optional GOES FRP intensity strip) and the Elevation Profile along store.profilePath (burned portion shaded from
// observed_arrival, forecast reach hatched, fire-front marker). Every chart has a cheap time cursor synced to the
// timeline (a tiny component subscribed to timeMs), a hover crosshair with a readout of every series, and
// click/drag to scrub. One y-axis per chart; FRP is an intensity strip (not a second scale).
import { area, curveMonotoneX, line } from 'd3-shape'
import { scaleLinear, type ScaleLinear } from 'd3-scale'
import { Download, Pencil, RotateCcw } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ForecastManifest, IncidentManifest } from '../api/types'
import { fmtAxis, fmtNumber } from '../lib/format'
import { sampleBilinear, sampleNearest } from '../lib/geo'
import { loadForecastLayer, loadLayer } from '../lib/raster'
import { HOUR_MS, fmtAt, localWallTicks, tickStepHours, zoneAbbr } from '../lib/time'
import { interpAt, lastIndexAtOrBefore } from '../state/selectors'
import { useStore, type TimeWindow } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { useWorkspace } from '../state/workspace'
import { MenuItem, Popover } from './controls'
import { useElementSize } from './hooks'
import { useTimelineWindow } from './timelineModel'
import { OpenMeteoCredit } from './DataCredits'
import { isOpenMeteo } from '../lib/dataCredits'

type Lin = ScaleLinear<number, number>
const M = { l: 38, r: 10, t: 8, b: 17 }

/** How the charts name the model. Forensic and Command name the run ("Forecast <run id>", P50, P10–P90); Public's
 *  Analysis drawer (map workspace) uses plain words without run ids (brief 2 C-R8), and a past fire's run is a model
 *  re-run on past weather, never called a forecast or a hindcast. */
function useModelNames(fc: ForecastManifest | null, mode: IncidentManifest['mode'] | undefined) {
  const plain = useWorkspace((s) => s.workspace === 'map' && s.preset === 'public')
  if (!fc) return null
  if (!plain)
    return {
      band: `Forecast ${fc.run_id}`,
      bandTip: `Forecast ${fc.run_id}: P50 line with the P10–P90 band; click to toggle`,
      p50: 'forecast P50',
      range: 'P10–P90',
      ros: 'P50',
      rosTip: `Forecast ${fc.run_id} median ROS`,
    }
  const name = mode === 'historical' ? 'Model re-run on past weather' : 'Model forecast'
  return {
    band: mode === 'historical' ? 'Model re-run' : 'Model forecast',
    bandTip: `${name} (experimental): the middle run as a line and the range of 80 % of the runs as a band; click to toggle`,
    p50: 'model, middle run',
    range: '80 % of runs',
    ros: 'Model',
    rosTip: `${name} (experimental): the middle run`,
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ------------------------------------------------------------------------------------------------ shared pieces

function ChartCard({
  title,
  sub,
  legend,
  menu,
  children,
  className,
  weatherCredit,
}: {
  title: string
  sub?: string
  legend?: ReactNode
  menu?: ReactNode
  children: ReactNode
  className?: string
  /** The chart shows Open-Meteo weather or a forecast driven by it: the linked credit goes under it (CC BY 4.0). */
  weatherCredit?: boolean
}) {
  return (
    <section className={`chart ${className ?? ''}`}>
      <header className="chart-head">
        <h3 className="chart-title">
          {title}
          {sub && <span className="chart-sub">{sub}</span>}
        </h3>
        {legend && <div className="chart-legend">{legend}</div>}
        {menu}
      </header>
      {children}
      {weatherCredit && <OpenMeteoCredit className="chart-credit" />}
    </section>
  )
}

function LegendKey({
  kind,
  color,
  label,
  short,
  off,
  onClick,
  tip,
}: {
  kind: 'line' | 'dash' | 'band' | 'strip' | 'dot' | 'hatch'
  color: string
  label: string
  /** label used when the chart is narrow */
  short?: string
  off?: boolean
  onClick?: () => void
  tip?: string
}) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag type={onClick ? 'button' : undefined} className={`lk ${off ? 'is-off' : ''} ${onClick ? 'is-btn' : ''}`} onClick={onClick} data-tip={tip ?? label} aria-pressed={onClick ? !off : undefined}>
      <i className={`lk-${kind}`} style={{ ['--c' as string]: color }} />
      {short ? (
        <>
          <span className="lk-long">{label}</span>
          <span className="lk-short">{short}</span>
        </>
      ) : (
        label
      )}
    </Tag>
  )
}

function ChartMenu({ items }: { items: { label: string; icon?: ReactNode; onSelect: () => void; checked?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <button ref={anchor} type="button" className="chart-menu-btn" aria-label="Chart options" data-tip={open ? undefined : 'Options'} onClick={() => setOpen((o) => !o)}>
        <span />
        <span />
        <span />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-end" width={220} label="Chart options" className="menu-pop">
        {items.map((it) => (
          <MenuItem
            key={it.label}
            icon={it.icon}
            label={it.label}
            checked={it.checked}
            disabled={it.disabled}
            onSelect={() => {
              setOpen(false)
              it.onSelect()
            }}
          />
        ))}
      </Popover>
    </>
  )
}

/** Download rows as CSV (header + rows); values are written verbatim. */
function downloadCsv(name: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => (v == null ? '' : typeof v === 'number' ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const isoUtc = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

/** Compact axis numbers: 950 -> "950", 5000 -> "5k", 12500 -> "12.5k", 2.5e6 -> "2.5M". */
function fmtCompact(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${fmtNumber(v / 1e6, Number.isInteger(v / 1e6) ? 0 : 1)}M`
  if (a >= 1e3) return `${fmtNumber(v / 1e3, Number.isInteger(v / 1e3) ? 0 : 1)}k`
  return fmtAxis(v)
}

function YGrid({ y, ticks, w, fmt = fmtCompact }: { y: Lin; ticks: number[]; w: number; fmt?: (v: number) => string }) {
  return (
    <g className="ax ax-y">
      {ticks.map((v) => (
        <g key={v} transform={`translate(0,${y(v)})`}>
          <line x1={M.l} x2={w - M.r} className="grid" />
          <text x={M.l - 6} dy="0.32em" textAnchor="end">
            {fmt(v)}
          </text>
        </g>
      ))}
    </g>
  )
}

function TimeAxis({ x, win, w, h }: { x: Lin; win: TimeWindow; w: number; h: number }) {
  const tf = useTimeFormat()
  const ticks = useMemo(() => {
    const step = tickStepHours(win.endMs - win.startMs, w - M.l - M.r, 54)
    const list = localWallTicks(win.startMs, win.endMs, step, tf)
    return list.map((t) => ({ t: t.t, label: step >= 24 || t.day ? t.dayLabel : t.timeLabel, day: t.day }))
  }, [win.startMs, win.endMs, w, tf])
  return (
    <g className="ax ax-x">
      <line x1={M.l} x2={w - M.r} y1={h - M.b} y2={h - M.b} className="base" />
      {ticks.map((t) => (
        <g key={t.t} transform={`translate(${x(t.t)},${h - M.b})`}>
          <line y2={t.day ? 4 : 3} className="tick" />
          <text y={13} textAnchor="middle" className={t.day ? 'is-day' : ''}>
            {t.label}
          </text>
        </g>
      ))}
    </g>
  )
}

interface ReadoutRow {
  key: ReactNode
  label: string
  value: string
}

/** Pointer layer: hover crosshair + readout and click/drag scrubbing of the timeline (time charts). */
function TimeHover({
  x,
  w,
  h,
  win,
  rows,
}: {
  x: Lin
  w: number
  h: number
  win: TimeWindow
  rows: (t: number) => ReadoutRow[]
}) {
  const tf = useTimeFormat()
  const [hx, setHx] = useState<number | null>(null)
  const drag = useRef(false)
  const toT = (px: number) => Math.round(x.invert(clamp(px, M.l, w - M.r)) / HOUR_MS) * HOUR_MS
  const setTime = (px: number) => {
    const s = useStore.getState()
    s.setTimeMs(clamp(x.invert(clamp(px, M.l, w - M.r)), win.startMs, win.endMs))
  }
  const local = (e: RPointerEvent<HTMLDivElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left
  const t = hx != null ? toT(hx) : null
  const rs = t != null ? rows(t) : []
  const left = hx != null && hx > w - 150
  return (
    <div
      className="chart-hit"
      style={{ left: M.l, width: Math.max(0, w - M.l - M.r), top: M.t, height: Math.max(0, h - M.t - M.b) }}
      onPointerMove={(e) => {
        const px = local(e) + M.l
        setHx(px)
        if (drag.current) setTime(px)
      }}
      onPointerLeave={() => setHx(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        drag.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        useStore.getState().setPlaying(false)
        setTime(local(e) + M.l)
      }}
      onPointerUp={(e) => {
        drag.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
    >
      {t != null && hx != null && (
        <>
          <span className="xhair" style={{ left: x(t) - M.l }} />
          <div className={`readout ${left ? 'is-left' : ''}`} style={{ left: x(t) - M.l }}>
            <div className="xr-time mono">
              {fmtAt(t, tf)} <span className="muted">{zoneAbbr(t, tf.tz)}</span>
            </div>
            {rs.map((r) => (
              <div key={r.label} className="xr-row">
                {r.key}
                <span className="xr-val mono">{r.value}</span>
                <span className="xr-label">{r.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Gold timeline cursor: vertical hairline, a ringed dot on the main series and its value. Re-renders alone. */
function TimeCursor({ x, y, h, win, valueAt, fmt, w }: { x: Lin; y: Lin; h: number; w: number; win: TimeWindow; valueAt: (t: number) => number | null; fmt: (v: number) => string }) {
  const timeMs = useStore((s) => s.timeMs)
  if (timeMs < win.startMs || timeMs > win.endMs) return null
  const cx = x(timeMs)
  const v = valueAt(timeMs)
  const cy = v != null ? y(v) : null
  const flip = cx > w - 70
  return (
    <g className="cursor" pointerEvents="none">
      <line x1={cx} x2={cx} y1={M.t - 2} y2={h - M.b} />
      {cy != null && <circle cx={cx} cy={cy} r={4} />}
      {v != null && (
        <text x={cx + (flip ? -6 : 6)} y={M.t + 8} textAnchor={flip ? 'end' : 'start'} className="cursor-val">
          {fmt(v)}
        </text>
      )}
    </g>
  )
}

function NowLine({ x, h, t, label }: { x: Lin; h: number; t: number | null; label: string }) {
  if (t == null) return null
  const [a, b] = x.domain()
  if (t < a || t > b) return null
  return (
    <g className="nowline">
      <line x1={x(t)} x2={x(t)} y1={M.t} y2={h - M.b} />
      <text x={x(t) + 3} y={h - M.b - 4}>
        {label}
      </text>
    </g>
  )
}

const clipId = (name: string) => `clip-${name}`

function windowMax(t: ArrayLike<number>, v: ArrayLike<number> | undefined, win: TimeWindow): number {
  if (!v) return 0
  let m = 0
  const n = Math.min(t.length, v.length)
  for (let i = 0; i < n; i++) if (t[i] >= win.startMs - HOUR_MS && t[i] <= win.endMs + HOUR_MS && v[i] > m) m = v[i]
  return m
}

function idxPath(n: number, fx: (i: number) => number, fy: (i: number) => number, ok: (i: number) => boolean = () => true): string {
  return (
    line<number>()
      .defined(ok)
      .x(fx)
      .y(fy)
      .curve(curveMonotoneX)(Array.from({ length: n }, (_, i) => i)) ?? ''
  )
}

function idxArea(n: number, fx: (i: number) => number, fy0: (i: number) => number, fy1: (i: number) => number, ok: (i: number) => boolean = () => true): string {
  return (
    area<number>()
      .defined(ok)
      .x(fx)
      .y0(fy0)
      .y1(fy1)
      .curve(curveMonotoneX)(Array.from({ length: n }, (_, i) => i)) ?? ''
  )
}

const finiteAt = (v: ArrayLike<number> | undefined) => (i: number) => v != null && Number.isFinite(v[i])

function nowOf(m: IncidentManifest | null, f: ForecastManifest | null): number | null {
  if (!m) return null
  return m.mode === 'live' ? m.time_range.now_ms : (f?.start_ms ?? null)
}

// ------------------------------------------------------------------------------------------------ Fire Area

export function FireAreaChart() {
  const { ts, fc, manifest } = useStore(useShallow((s) => ({ ts: s.timeseries, fc: s.forecast, manifest: s.manifest })))
  const names = useModelNames(fc, manifest?.mode)
  const win = useTimelineWindow()
  const [ref, { width: w, height: h }] = useElementSize<HTMLDivElement>()
  const [showFc, setShowFc] = useState(true)
  const fcOn = showFc && fc != null
  const geo = useMemo(() => {
    if (!ts || !win || w < 80 || h < 50) return null
    const x = scaleLinear().domain([win.startMs, win.endMs]).range([M.l, w - M.r])
    let ymax = windowMax(ts.t_ms, ts.area_acres, win)
    if (fcOn && fc) ymax = Math.max(ymax, windowMax(fc.series.t_ms, fc.series.area_acres_p90, win))
    const y = scaleLinear()
      .domain([0, Math.max(10, ymax * 1.06)])
      .nice(4)
      .range([h - M.b, M.t])
    const t = ts.t_ms
    const a = ts.area_acres
    const obsArea = idxArea(t.length, (i) => x(t[i]), () => y(0), (i) => y(a[i]), finiteAt(a))
    const obsLine = idxPath(t.length, (i) => x(t[i]), (i) => y(a[i]), finiteAt(a))
    let band = ''
    let p50 = ''
    if (fcOn && fc) {
      const s = fc.series
      band = idxArea(s.t_ms.length, (i) => x(s.t_ms[i]), (i) => y(s.area_acres_p10[i]), (i) => y(s.area_acres_p90[i]), finiteAt(s.area_acres_p90))
      p50 = idxPath(s.t_ms.length, (i) => x(s.t_ms[i]), (i) => y(s.area_acres_p50[i]), finiteAt(s.area_acres_p50))
    }
    return { x, y, yTicks: y.ticks(4), obsArea, obsLine, band, p50 }
  }, [ts, fc, fcOn, win, w, h])

  const valueAt = (t: number) => {
    const o = ts ? interpAt(ts.t_ms, ts.area_acres, t) : null
    if (o != null) return o
    return fcOn && fc ? interpAt(fc.series.t_ms, fc.series.area_acres_p50, t) : null
  }
  const rows = (t: number): ReadoutRow[] => {
    const out: ReadoutRow[] = []
    const o = ts ? interpAt(ts.t_ms, ts.area_acres, t) : null
    if (o != null) out.push({ key: <i className="rk rk-line" style={{ ['--c' as string]: 'var(--chart-observed)' }} />, label: 'observed', value: `${fmtNumber(o)} ac` })
    if (fcOn && fc) {
      const s = fc.series
      const p = interpAt(s.t_ms, s.area_acres_p50, t)
      if (p != null) {
        out.push({ key: <i className="rk rk-dash" style={{ ['--c' as string]: 'var(--chart-forecast)' }} />, label: names?.p50 ?? 'forecast P50', value: `${fmtNumber(p)} ac` })
        out.push({
          key: <i className="rk rk-band" style={{ ['--c' as string]: 'var(--chart-forecast)' }} />,
          label: names?.range ?? 'P10–P90',
          value: `${fmtNumber(interpAt(s.t_ms, s.area_acres_p10, t) ?? p)}–${fmtNumber(interpAt(s.t_ms, s.area_acres_p90, t) ?? p)}`,
        })
      }
    }
    return out
  }
  const exportCsv = () => {
    if (!ts || !manifest) return
    const rowsCsv: (string | number | null)[][] = ts.t_ms.map((t, i) => [isoUtc(t), 'observed', ts.area_acres[i], null, null])
    if (fc) fc.series.t_ms.forEach((t, i) => rowsCsv.push([isoUtc(t), `forecast ${fc.run_id}`, fc.series.area_acres_p50[i], fc.series.area_acres_p10[i], fc.series.area_acres_p90[i]]))
    downloadCsv(`${manifest.id}-fire-area.csv`, ['time_utc', 'series', 'acres', 'p10_acres', 'p90_acres'], rowsCsv)
  }
  return (
    <ChartCard
      title="Fire Area"
      sub="acres"
      weatherCredit={fcOn && isOpenMeteo(fc?.weather.source)}
      legend={
        <>
          <LegendKey kind="line" color="var(--chart-observed)" label="Observed" short="Obs." />
          {fc && names && <LegendKey kind="band" color="var(--chart-forecast)" label={names.band} short="Fcst" off={!showFc} onClick={() => setShowFc(!showFc)} tip={names.bandTip} />}
        </>
      }
      menu={
        <ChartMenu
          items={[
            { label: 'Show forecast band', checked: showFc, disabled: !fc, onSelect: () => setShowFc(!showFc) },
            { label: 'Download CSV', icon: <Download size={13} />, disabled: !ts, onSelect: exportCsv },
          ]}
        />
      }
    >
      <div className="chart-body" ref={ref}>
        {!ts ? (
          <div className="chart-empty muted">No observed area series</div>
        ) : geo && win ? (
          <>
            <svg width={w} height={h} className="chart-svg">
              <defs>
                <clipPath id={clipId('area')}>
                  <rect x={M.l} y={0} width={Math.max(0, w - M.l - M.r)} height={h} />
                </clipPath>
              </defs>
              <YGrid y={geo.y} ticks={geo.yTicks} w={w} />
              <TimeAxis x={geo.x} win={win} w={w} h={h} />
              <g clipPath={`url(#${clipId('area')})`}>
                {geo.band && <path d={geo.band} className="s-band" />}
                <path d={geo.obsArea} className="s-obs-wash" />
                <path d={geo.obsLine} className="s-obs" />
                {geo.p50 && <path d={geo.p50} className="s-fc" />}
              </g>
              <NowLine x={geo.x} h={h} t={nowOf(manifest, fc)} label={manifest?.mode === 'live' ? 'now' : 'T₀'} />
              <TimeCursor x={geo.x} y={geo.y} h={h} w={w} win={win} valueAt={valueAt} fmt={(v) => `${fmtNumber(v)} ac`} />
            </svg>
            <TimeHover x={geo.x} w={w} h={h} win={win} rows={rows} />
          </>
        ) : null}
      </div>
    </ChartCard>
  )
}

// ------------------------------------------------------------------------------------------------ Rate of Spread

export function RosChart() {
  const { ts, fc, manifest, weather } = useStore(useShallow((s) => ({ ts: s.timeseries, fc: s.forecast, manifest: s.manifest, weather: s.weather })))
  const names = useModelNames(fc, manifest?.mode)
  const win = useTimelineWindow()
  const [ref, { width: w, height: h }] = useElementSize<HTMLDivElement>()
  const hasFrp = Boolean(ts?.frp_mw_per_h?.some((v) => v > 0))
  const [showFrp, setShowFrp] = useState(true)
  const [showPot, setShowPot] = useState(false)
  const hasPot = Boolean(weather?.at_fire.ros_ch_per_h_potential?.length)
  const frpOn = showFrp && hasFrp
  const potOn = showPot && hasPot
  const geo = useMemo(() => {
    if (!ts || !win || w < 80 || h < 50) return null
    const x = scaleLinear().domain([win.startMs, win.endMs]).range([M.l, w - M.r])
    let ymax = windowMax(ts.t_ms, ts.ros_ch_per_h, win)
    if (fc) ymax = Math.max(ymax, windowMax(fc.series.t_ms, fc.series.ros_ch_per_h_p50, win))
    if (potOn && weather) ymax = Math.max(ymax, windowMax(weather.t_ms, weather.at_fire.ros_ch_per_h_potential, win))
    const stripH = frpOn ? 6 : 0
    const y = scaleLinear()
      .domain([0, Math.max(1, ymax * 1.08)])
      .nice(3)
      .range([h - M.b - stripH - (frpOn ? 3 : 0), M.t])
    const t = ts.t_ms
    const r = ts.ros_ch_per_h
    const obsArea = idxArea(t.length, (i) => x(t[i]), () => y(0), (i) => y(r[i]), finiteAt(r))
    const obsLine = idxPath(t.length, (i) => x(t[i]), (i) => y(r[i]), finiteAt(r))
    const fcLine = fc ? idxPath(fc.series.t_ms.length, (i) => x(fc.series.t_ms[i]), (i) => y(fc.series.ros_ch_per_h_p50[i]), finiteAt(fc.series.ros_ch_per_h_p50)) : ''
    const pot = potOn && weather ? idxPath(weather.t_ms.length, (i) => x(weather.t_ms[i]), (i) => y(weather.at_fire.ros_ch_per_h_potential![i]), finiteAt(weather.at_fire.ros_ch_per_h_potential)) : ''
    let strip: { x: number; w: number; a: number }[] = []
    let frpMax = 0
    if (frpOn && ts.frp_mw_per_h) {
      const f = ts.frp_mw_per_h
      frpMax = windowMax(t, f, win)
      const pxH = (w - M.l - M.r) / ((win.endMs - win.startMs) / HOUR_MS)
      if (frpMax > 0)
        strip = t
          .map((tt, i) => ({ x: x(tt - HOUR_MS), w: Math.max(1, pxH), a: f[i] > 0 ? Math.sqrt(f[i] / frpMax) : 0 }))
          .filter((s) => s.a > 0 && s.x + s.w >= M.l && s.x <= w - M.r)
    }
    return { x, y, yTicks: y.ticks(3), obsArea, obsLine, fcLine, pot, strip, stripY: h - M.b - stripH - 1, stripH, frpMax }
  }, [ts, fc, win, w, h, frpOn, potOn, weather])

  const valueAt = (t: number) => (ts ? interpAt(ts.t_ms, ts.ros_ch_per_h, t) : null) ?? (fc ? interpAt(fc.series.t_ms, fc.series.ros_ch_per_h_p50, t) : null)
  const rows = (t: number): ReadoutRow[] => {
    const out: ReadoutRow[] = []
    const o = ts ? interpAt(ts.t_ms, ts.ros_ch_per_h, t) : null
    if (o != null) out.push({ key: <i className="rk rk-line" style={{ ['--c' as string]: 'var(--chart-observed)' }} />, label: 'observed', value: `${fmtNumber(o, o < 10 ? 1 : 0)} ch/h` })
    const p = fc ? interpAt(fc.series.t_ms, fc.series.ros_ch_per_h_p50, t) : null
    if (p != null) out.push({ key: <i className="rk rk-dash" style={{ ['--c' as string]: 'var(--chart-forecast)' }} />, label: names?.p50 ?? 'forecast P50', value: `${fmtNumber(p, p < 10 ? 1 : 0)} ch/h` })
    if (potOn && weather) {
      const v = interpAt(weather.t_ms, weather.at_fire.ros_ch_per_h_potential, t)
      if (v != null) out.push({ key: <i className="rk rk-line" style={{ ['--c' as string]: 'var(--text-2)' }} />, label: 'potential', value: `${fmtNumber(v, v < 10 ? 1 : 0)} ch/h` })
    }
    if (frpOn && ts?.frp_mw_per_h) {
      const i = lastIndexAtOrBefore(ts.t_ms, t)
      const f = i >= 0 ? ts.frp_mw_per_h[i] : null
      if (f != null && Number.isFinite(f)) out.push({ key: <i className="rk rk-strip" style={{ ['--c' as string]: 'var(--chart-frp)' }} />, label: 'FRP', value: `${fmtNumber(f, f < 10 ? 1 : 0)} MW` })
    }
    return out
  }
  const exportCsv = () => {
    if (!ts || !manifest) return
    downloadCsv(
      `${manifest.id}-rate-of-spread.csv`,
      ['time_utc', 'ros_ch_per_h', 'frp_mw', 'detections'],
      ts.t_ms.map((t, i) => [isoUtc(t), ts.ros_ch_per_h[i], ts.frp_mw_per_h?.[i] ?? null, ts.detections_per_h[i]]),
    )
  }
  return (
    <ChartCard
      title="Rate of Spread"
      sub="ch/hr"
      weatherCredit={(fc != null && isOpenMeteo(fc.weather.source)) || (potOn && isOpenMeteo(weather?.source))}
      legend={
        <>
          <LegendKey kind="line" color="var(--chart-observed)" label="Observed" short="Obs." />
          {fc && names && <LegendKey kind="dash" color="var(--chart-forecast)" label={names.ros} tip={names.rosTip} />}
          {hasFrp && <LegendKey kind="strip" color="var(--chart-frp)" label="FRP" off={!showFrp} onClick={() => setShowFrp(!showFrp)} tip="Fire radiative power (GOES when available), hourly; click to toggle" />}
        </>
      }
      menu={
        <ChartMenu
          items={[
            { label: 'FRP intensity strip', checked: showFrp, disabled: !hasFrp, onSelect: () => setShowFrp(!showFrp) },
            { label: 'Potential ROS (weather)', checked: showPot, disabled: !hasPot, onSelect: () => setShowPot(!showPot) },
            { label: 'Download CSV', icon: <Download size={13} />, disabled: !ts, onSelect: exportCsv },
          ]}
        />
      }
    >
      <div className="chart-body" ref={ref}>
        {!ts ? (
          <div className="chart-empty muted">No rate-of-spread series</div>
        ) : geo && win ? (
          <>
            <svg width={w} height={h} className="chart-svg">
              <defs>
                <clipPath id={clipId('ros')}>
                  <rect x={M.l} y={0} width={Math.max(0, w - M.l - M.r)} height={h} />
                </clipPath>
              </defs>
              <YGrid y={geo.y} ticks={geo.yTicks} w={w} />
              <TimeAxis x={geo.x} win={win} w={w} h={h} />
              <g clipPath={`url(#${clipId('ros')})`}>
                {geo.strip.map((s, i) => (
                  <rect key={i} x={s.x} y={geo.stripY} width={s.w} height={geo.stripH} fill="var(--chart-frp)" opacity={0.1 + 0.8 * s.a} />
                ))}
                {geo.pot && <path d={geo.pot} className="s-pot" />}
                <path d={geo.obsArea} className="s-obs-wash" />
                <path d={geo.obsLine} className="s-obs" />
                {geo.fcLine && <path d={geo.fcLine} className="s-fc" />}
              </g>
              <NowLine x={geo.x} h={h} t={nowOf(manifest, fc)} label={manifest?.mode === 'live' ? 'now' : 'T₀'} />
              <TimeCursor x={geo.x} y={geo.y} h={h} w={w} win={win} valueAt={valueAt} fmt={(v) => `${fmtNumber(v, v < 10 ? 1 : 0)} ch/h`} />
            </svg>
            <TimeHover x={geo.x} w={w} h={h} win={win} rows={rows} />
          </>
        ) : null}
      </div>
    </ChartCard>
  )
}

// ------------------------------------------------------------------------------------------------ Elevation profile

interface ProfileSamples {
  key: string
  d: Float64Array // distance along the path (m)
  xs: Float64Array
  zs: Float64Array
  elev: Float32Array
  arr: Float32Array | null // observed arrival (hours since origin), NEVER = 1e6
  fc50: Float32Array | null // forecast P50 arrival (hours since origin)
  total: number
  gain: number
}

/** Evenly spaced samples along the polyline, with elevation (render grid, bilinear) and arrival (fire grid). */
function useProfileSamples(manifest: IncidentManifest | null, fc: ForecastManifest | null, path: [number, number][]): { samples: ProfileSamples | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ samples: ProfileSamples | null; loading: boolean; error: string | null }>({ samples: null, loading: false, error: null })
  const key = manifest && manifest.status === 'ready' && path.length >= 2 ? `${manifest.id}@${manifest.built_ms}|${fc ? `${fc.run_id}-${fc.issued_ms}` : '-'}|${path.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(';')}` : null
  useEffect(() => {
    if (!key || !manifest) {
      setState({ samples: null, loading: false, error: null })
      return
    }
    let alive = true
    setState((s) => ({ samples: s.samples, loading: true, error: null }))
    const m = manifest
    Promise.all([
      loadLayer(m, 'elevation'),
      m.layers.observed_arrival ? loadLayer(m, 'observed_arrival').catch(() => null) : Promise.resolve(null),
      fc && fc.status === 'ready' ? loadForecastLayer(m, fc, 'arrival_p50').catch(() => null) : Promise.resolve(null),
    ])
      .then(([elev, arr, f50]) => {
        if (!alive) return
        const extent = m.grid.extent_m
        // cumulative length of the polyline
        const segLen: number[] = []
        let total = 0
        for (let i = 1; i < path.length; i++) {
          const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
          segLen.push(l)
          total += l
        }
        const n = clamp(Math.round(total / (extent / elev.width)), 64, 480)
        const d = new Float64Array(n)
        const xs = new Float64Array(n)
        const zs = new Float64Array(n)
        const ev = new Float32Array(n)
        const ar = arr ? new Float32Array(n) : null
        const f5 = f50 ? new Float32Array(n) : null
        let seg = 0
        let segStart = 0
        for (let k = 0; k < n; k++) {
          const dist = total > 0 ? (k / (n - 1)) * total : 0
          while (seg < segLen.length - 1 && dist > segStart + segLen[seg]) {
            segStart += segLen[seg]
            seg++
          }
          const f = segLen[seg] > 0 ? (dist - segStart) / segLen[seg] : 0
          const x = path[seg][0] + (path[seg + 1][0] - path[seg][0]) * f
          const z = path[seg][1] + (path[seg + 1][1] - path[seg][1]) * f
          d[k] = dist
          xs[k] = x
          zs[k] = z
          ev[k] = sampleBilinear(elev.data, elev.width, elev.height, x, z, extent)
          if (ar && arr) ar[k] = sampleNearest(arr.data, arr.width, arr.height, x, z, extent)
          if (f5 && f50) f5[k] = sampleNearest(f50.data, f50.width, f50.height, x, z, extent)
        }
        let gain = 0
        for (let k = 1; k < n; k++) if (ev[k] > ev[k - 1]) gain += ev[k] - ev[k - 1]
        setState({ samples: { key: key, d, xs, zs, elev: ev, arr: ar, fc50: f5, total, gain }, loading: false, error: null })
      })
      .catch((e) => alive && setState({ samples: null, loading: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

const NEVER_H = 1e5

export function ProfileChart() {
  const { manifest, fc, path, drawing, defaultPath } = useStore(
    useShallow((s) => ({
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      fc: s.forecast,
      path: s.profilePath,
      drawing: s.drawingPath,
      defaultPath: s.manifest?.default_profile_path ?? null,
    })),
  )
  const { samples, loading, error } = useProfileSamples(manifest, fc, path)
  const [ref, { width: w, height: h }] = useElementSize<HTMLDivElement>()
  const st = useStore.getState
  const isDefault = defaultPath != null && JSON.stringify(defaultPath) === JSON.stringify(path)
  const exportCsv = () => {
    if (!samples || !manifest) return
    const origin = manifest.time_origin_ms
    const rows: (string | number | null)[][] = []
    for (let k = 0; k < samples.d.length; k++) {
      const a = samples.arr?.[k]
      rows.push([Math.round(samples.d[k]), Math.round(samples.xs[k]), Math.round(samples.zs[k]), Math.round(samples.elev[k] * 10) / 10, a != null && a < NEVER_H ? isoUtc(origin + a * HOUR_MS) : null])
    }
    downloadCsv(`${manifest.id}-elevation-profile.csv`, ['distance_m', 'x_m', 'z_m', 'elevation_m', 'observed_arrival_utc'], rows)
  }
  return (
    <ChartCard
      className="chart-profile"
      title="Elevation Profile"
      sub={isDefault ? 'main run' : 'selected path'}
      legend={
        samples ? (
          <>
            <span className="lk mono muted" data-tip={`Path length · cumulative climb ${fmtNumber(samples.gain)} m`}>
              {fmtNumber(samples.total / 1000, 1)} km
            </span>
            <button type="button" className={`chart-tool ${drawing ? 'is-active' : ''}`} onClick={() => (st().setLayerVisible('profilePath', true), st().setDrawingPath(!drawing))} data-tip={drawing ? 'Drawing: click the terrain to add points; double-click or Esc to finish' : 'Draw a new path on the terrain'}>
              <Pencil size={11} /> {drawing ? 'Drawing…' : 'Draw'}
            </button>
            {!isDefault && defaultPath && defaultPath.length >= 2 && (
              <button type="button" className="chart-tool" onClick={() => st().setProfilePath(defaultPath)} data-tip="Reset to ignition → main run">
                <RotateCcw size={11} />
              </button>
            )}
          </>
        ) : null
      }
      menu={
        <ChartMenu
          items={[
            { label: drawing ? 'Stop drawing' : 'Draw a new path', icon: <Pencil size={13} />, disabled: !manifest, onSelect: () => (st().setLayerVisible('profilePath', true), st().setDrawingPath(!drawing)) },
            { label: 'Reset to default path', icon: <RotateCcw size={13} />, disabled: !defaultPath?.length, onSelect: () => st().setProfilePath(defaultPath ?? []) },
            { label: 'Download CSV', icon: <Download size={13} />, disabled: !samples, onSelect: exportCsv },
          ]}
        />
      }
    >
      <div className="chart-body" ref={ref}>
        {!manifest ? (
          <div className="chart-empty muted">No bundle loaded</div>
        ) : path.length < 2 ? (
          <div className="chart-empty muted">{drawing ? 'Click points on the terrain; double-click or Esc to finish.' : 'No path: use Draw to trace one on the terrain.'}</div>
        ) : error ? (
          <div className="chart-empty danger">Elevation unavailable: {error}</div>
        ) : !samples ? (
          <div className="chart-empty muted">{loading ? 'Sampling elevation…' : ''}</div>
        ) : (
          w > 80 && h > 50 && <ProfilePlot samples={samples} manifest={manifest} w={w} h={h} />
        )}
      </div>
    </ChartCard>
  )
}

const PM = { l: 40, r: 10, t: 8, b: 17 }

const ProfilePlot = memo(function ProfilePlot({ samples, manifest, w, h }: { samples: ProfileSamples; manifest: IncidentManifest; w: number; h: number }) {
  const geo = useMemo(() => {
    const n = samples.d.length
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < n; k++) {
      lo = Math.min(lo, samples.elev[k])
      hi = Math.max(hi, samples.elev[k])
    }
    const pad = Math.max(20, (hi - lo) * 0.12)
    const x = scaleLinear().domain([0, samples.total]).range([PM.l, w - PM.r])
    const y = scaleLinear()
      .domain([Math.max(0, lo - pad), hi + pad])
      .nice(3)
      .range([h - PM.b, PM.t])
    const base = y.range()[0]
    const terrainLine = idxPath(n, (k) => x(samples.d[k]), (k) => y(samples.elev[k]))
    const terrainArea = idxArea(n, (k) => x(samples.d[k]), () => base, (k) => y(samples.elev[k]))
    // sorted arrival times -> the burned set at t is "the k earliest samples" (monotone), so components can
    // subscribe to a count instead of re-rendering every frame
    const sortedArr = samples.arr ? Float32Array.from(samples.arr).sort() : null
    const sortedFc = samples.fc50 ? Float32Array.from(samples.fc50).sort() : null
    const kmStep = niceStep(samples.total / 1000, Math.max(2, Math.floor((w - PM.l - PM.r) / 60)))
    const xTicks: number[] = []
    for (let km = 0; km <= samples.total / 1000 + 1e-9; km += kmStep) xTicks.push(km)
    return { x, y, base, terrainLine, terrainArea, sortedArr, sortedFc, yTicks: y.ticks(3), xTicks, kmStep }
  }, [samples, w, h])
  return (
    <>
      <svg width={w} height={h} className="chart-svg">
        <defs>
          <linearGradient id="prof-terrain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--chart-terrain)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--chart-terrain)" stopOpacity="0.03" />
          </linearGradient>
          <pattern id="prof-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,138,76,0.55)" strokeWidth="1.4" />
          </pattern>
        </defs>
        <g className="ax ax-y">
          {geo.yTicks.map((v) => (
            <g key={v} transform={`translate(0,${geo.y(v)})`}>
              <line x1={PM.l} x2={w - PM.r} className="grid" />
              <text x={PM.l - 6} dy="0.32em" textAnchor="end">
                {fmtNumber(v)}
              </text>
            </g>
          ))}
        </g>
        <g className="ax ax-x">
          <line x1={PM.l} x2={w - PM.r} y1={h - PM.b} y2={h - PM.b} className="base" />
          {geo.xTicks.map((km) => (
            <g key={km} transform={`translate(${geo.x(km * 1000)},${h - PM.b})`}>
              <line y2={3} className="tick" />
              <text y={13} textAnchor="middle">
                {fmtNumber(km, Number.isInteger(km) ? 0 : geo.kmStep < 0.5 ? 2 : 1)}
              </text>
            </g>
          ))}
          <text x={w - PM.r} y={h - PM.b - 4} textAnchor="end" className="unit">
            km
          </text>
        </g>
        <path d={geo.terrainArea} fill="url(#prof-terrain)" />
        <path d={geo.terrainLine} className="s-terrain" />
        <BurnOverlay samples={samples} manifest={manifest} x={geo.x} y={geo.y} base={geo.base} sortedArr={geo.sortedArr} sortedFc={geo.sortedFc} h={h} />
      </svg>
      <ProfileHover samples={samples} manifest={manifest} x={geo.x} y={geo.y} w={w} h={h} />
    </>
  )
})

function niceStep(totalKm: number, maxTicks: number): number {
  const raw = totalKm / Math.max(1, maxTicks)
  const steps = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50]
  return steps.find((s) => s >= raw) ?? 100
}

/** Count of values <= v in a sorted array (binary search). */
function countLE(sorted: Float32Array, v: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

const RECENT_H = 6

/** Burned (observed) and forecast-reached parts of the profile at the timeline time, plus the fire marker: burned
 *  samples are split into recent (last 6 h, fire orange) and older (dim ember); the marker sits on the most
 *  recently burned point of the path (bright while recent). */
function BurnOverlay({
  samples,
  manifest,
  x,
  y,
  base,
  sortedArr,
  sortedFc,
  h,
}: {
  samples: ProfileSamples
  manifest: IncidentManifest
  x: Lin
  y: Lin
  base: number
  sortedArr: Float32Array | null
  sortedFc: Float32Array | null
  h: number
}) {
  const origin = manifest.time_origin_ms
  // re-render only when the burned / recent / forecast sample counts change (all monotone in time)
  const kObs = useStore((s) => (sortedArr ? countLE(sortedArr, (s.timeMs - origin) / HOUR_MS) : 0))
  const kOld = useStore((s) => (sortedArr ? countLE(sortedArr, (s.timeMs - origin) / HOUR_MS - RECENT_H) : 0))
  const kFc = useStore((s) => (sortedFc ? countLE(sortedFc, (s.timeMs - origin) / HOUR_MS) : 0))
  const parts = useMemo(() => {
    const n = samples.d.length
    const arr = samples.arr
    const tObs = sortedArr && kObs > 0 ? sortedArr[kObs - 1] : -Infinity
    const tOld = sortedArr && kOld > 0 ? sortedArr[kOld - 1] : -Infinity
    const tFc = sortedFc && kFc > 0 ? sortedFc[kFc - 1] : -Infinity
    const burned = (k: number) => arr != null && arr[k] <= tObs && arr[k] < NEVER_H
    const old = (k: number) => arr != null && arr[k] <= tOld && arr[k] < NEVER_H
    const recent = (k: number) => burned(k) && !old(k)
    const fcReached = (k: number) => !burned(k) && samples.fc50 != null && samples.fc50[k] <= tFc && samples.fc50[k] < NEVER_H
    const fx = (k: number) => x(samples.d[k])
    const fy = (k: number) => y(samples.elev[k])
    const any = kObs > 0
    let front = -1
    let best = -Infinity
    if (arr && any)
      for (let k = 0; k < n; k++)
        if (burned(k) && arr[k] >= best) {
          best = arr[k]
          front = k
        }
    return {
      oldArea: kOld > 0 ? idxArea(n, fx, () => base, fy, old) : '',
      oldLine: kOld > 0 ? idxPath(n, fx, fy, old) : '',
      recentArea: any ? idxArea(n, fx, () => base, fy, recent) : '',
      recentLine: any ? idxPath(n, fx, fy, recent) : '',
      fcArea: kFc > 0 ? idxArea(n, fx, () => base, fy, fcReached) : '',
      front,
      frontRecent: front >= 0 && recent(front),
    }
  }, [samples, kObs, kOld, kFc, sortedArr, sortedFc, x, y, base])
  const f = parts.front
  return (
    <g pointerEvents="none">
      {parts.fcArea && <path d={parts.fcArea} fill="url(#prof-hatch)" className="s-prof-fc" />}
      {parts.oldArea && <path d={parts.oldArea} className="s-burn-old" />}
      {parts.recentArea && <path d={parts.recentArea} className="s-burn" />}
      {parts.oldLine && <path d={parts.oldLine} className="s-burn-old-line" />}
      {parts.recentLine && <path d={parts.recentLine} className="s-burn-line" />}
      {f >= 0 && (
        <g className={`front-mark ${parts.frontRecent ? '' : 'is-old'}`} transform={`translate(${x(samples.d[f])},0)`}>
          <line y1={PM.t} y2={h - PM.b} />
          <circle cy={y(samples.elev[f])} r={4.5} />
        </g>
      )}
    </g>
  )
}

function ProfileHover({ samples, manifest, x, y, w, h }: { samples: ProfileSamples; manifest: IncidentManifest; x: Lin; y: Lin; w: number; h: number }) {
  const tf = useTimeFormat()
  const [k, setK] = useState<number | null>(null)
  const n = samples.d.length
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left + PM.l
    const d = x.invert(clamp(px, PM.l, w - PM.r))
    setK(clamp(Math.round((d / Math.max(1, samples.total)) * (n - 1)), 0, n - 1))
  }
  const kk = k
  let slope: number | null = null
  if (kk != null) {
    const a = Math.max(0, kk - 2)
    const b = Math.min(n - 1, kk + 2)
    const dd = samples.d[b] - samples.d[a]
    slope = dd > 0 ? ((samples.elev[b] - samples.elev[a]) / dd) * 100 : null
  }
  const arr = kk != null && samples.arr ? samples.arr[kk] : null
  const px = kk != null ? x(samples.d[kk]) : 0
  return (
    <div
      className="chart-hit"
      style={{ left: PM.l, width: Math.max(0, w - PM.l - PM.r), top: PM.t, height: Math.max(0, h - PM.t - PM.b) }}
      onPointerMove={onMove}
      onPointerLeave={() => setK(null)}
      onClick={() => {
        if (kk == null) return
        useStore.getState().requestFlyTo(samples.xs[kk], samples.zs[kk])
      }}
    >
      {kk != null && (
        <>
          <span className="xhair" style={{ left: px - PM.l }} />
          <span className="xdot" style={{ left: px - PM.l, top: y(samples.elev[kk]) - PM.t }} />
          <div className={`readout ${px > w - 150 ? 'is-left' : ''}`} style={{ left: px - PM.l }}>
            <div className="xr-time mono">
              {fmtNumber(samples.d[kk] / 1000, 2)} km <span className="muted">along path</span>
            </div>
            <div className="xr-row">
              <i className="rk rk-line" style={{ ['--c' as string]: 'var(--chart-terrain)' }} />
              <span className="xr-val mono">{fmtNumber(samples.elev[kk])} m</span>
              <span className="xr-label">elevation</span>
            </div>
            {slope != null && (
              <div className="xr-row">
                <i className="rk" />
                <span className="xr-val mono">{`${slope >= 0 ? '+' : '−'}${fmtNumber(Math.abs(slope))}%`}</span>
                <span className="xr-label">grade</span>
              </div>
            )}
            {samples.arr && (
              <div className="xr-row">
                <i className="rk rk-band" style={{ ['--c' as string]: 'var(--fire)' }} />
                <span className="xr-val mono">{arr != null && arr < NEVER_H ? fmtAt(manifest.time_origin_ms + arr * HOUR_MS, tf) : 'unburned'}</span>
                <span className="xr-label">{arr != null && arr < NEVER_H ? 'fire arrival' : ''}</span>
              </div>
            )}
            <div className="xr-hint muted">click to fly there</div>
          </div>
        </>
      )}
    </div>
  )
}
