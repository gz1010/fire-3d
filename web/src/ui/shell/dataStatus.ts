// Command preset "Data status" rows (owner: shell; BRIEF §2 Command, §8): the newest timestamp of every source in the
// selected incident's bundle, so operators see how current each input is. Pure (tested in dataStatus.test.ts).
// Times are absolute (America/Los_Angeles with zone, plus the year when it is not the current one); live incidents add
// the age against the wall clock and flag observations older than the timeline's stale threshold. Replays show
// archived times only (no "ago"). Live "Last observation" can be a confirmed satellite pass that saw no new fire
// (time_range.now_ms, SPEC 8.3): when the newest detection or mapped perimeter is more than an hour older, the row says
// so and the detection row keeps the time the burned area is known up to.
import type { DetectionsFile, ForecastManifest, IncidentManifest, IncidentSummary, PerimetersFile, WeatherFile } from '../../api/types'
import { fmtAcres, satelliteName } from '../../lib/format'
import { fmtDateTimeTz, fmtDateTimeYearTz, fmtRelative, laParts } from '../../lib/time'
import { STALE_AFTER_MS } from '../timeline/model'

/** Gap between the newest detection / perimeter and the latest observation above which the latter is a quiet pass. */
export const QUIET_PASS_MIN_MS = 3_600_000

export type StatusKey = 'observations' | 'perimeter' | 'detection' | 'forecast' | 'weather' | 'record' | 'bundle'

export interface StatusRow {
  key: StatusKey
  label: string
  /** Absolute time with zone, or a plain statement when the source is missing. */
  value: string
  tMs: number | null
  /** Source / details (agency, instrument, run). */
  detail: string | null
  /** Live only: "12 min ago". */
  age: string | null
  stale: boolean
  /** Longer explanation for the tooltip (else the detail). */
  tip?: string | null
}

export interface DataStatusInput {
  summary: Pick<IncidentSummary, 'mode' | 'updated_ms'> | null
  manifest: (Pick<IncidentManifest, 'mode' | 'time_range' | 'built_ms'> & { data_sources?: IncidentManifest['data_sources'] }) | null
  perimeters: PerimetersFile | null
  detections: DetectionsFile | null
  forecast: Pick<ForecastManifest, 'run_id' | 'issued_ms' | 'start_ms' | 'horizon_h' | 'weather'> | null
  weather: Pick<WeatherFile, 'source' | 't_ms' | 'forecast_from_ms'> | null
}

function latest<T extends { t_ms: number }>(rows: readonly T[] | undefined): T | null {
  let best: T | null = null
  for (const r of rows ?? []) if (Number.isFinite(r.t_ms) && (!best || r.t_ms > best.t_ms)) best = r
  return best
}

/** "open-meteo:historical-forecast:gfs_hrrr" -> "Open-Meteo historical forecast (gfs_hrrr)". */
export function weatherSourceLabel(source: string): string {
  const parts = source.split(':').filter(Boolean)
  if (parts[0] === 'open-meteo') {
    const model = parts.at(-1)
    const kind = parts.length > 2 ? parts.slice(1, -1).join(' ').replace(/-/g, ' ') : null
    return `Open-Meteo${kind ? ` ${kind}` : ''}${model && parts.length > 1 ? ` (${model})` : ''}`
  }
  return source
}

/** Absolute time with zone; the year is added when it differs from the year of `nowMs`. */
export function fmtStatusTime(tMs: number, nowMs: number): string {
  return laParts(tMs).year === laParts(nowMs).year ? fmtDateTimeTz(tMs) : fmtDateTimeYearTz(tMs)
}

export function buildDataStatus(inp: DataStatusInput, nowMs: number): StatusRow[] {
  const live = (inp.manifest?.mode ?? inp.summary?.mode) === 'live'
  const row = (key: StatusKey, label: string, tMs: number | null, detail: string | null, missing: string, staleAfterMs?: number): StatusRow => {
    const ok = tMs != null && Number.isFinite(tMs)
    const age = live && ok ? nowMs - tMs : null
    return {
      key,
      label,
      value: ok ? fmtStatusTime(tMs, nowMs) : missing,
      tMs: ok ? tMs : null,
      detail,
      age: age != null ? fmtRelative(tMs as number, nowMs) : null,
      stale: staleAfterMs != null && age != null && age > staleAfterMs,
    }
  }
  const out: StatusRow[] = []
  const m = inp.manifest
  const tr = m?.time_range
  // the latest observation is a satellite pass that saw no new fire when the newest detection / perimeter is > 1 h older
  const lastFire = live && tr?.last_detection_ms != null && Number.isFinite(tr.last_detection_ms) ? tr.last_detection_ms : null
  const quietPass = lastFire != null && tr != null && tr.now_ms - lastFire > QUIET_PASS_MIN_MS
  const obs = row('observations', live ? 'Last observation' : 'Observations to', tr ? tr.now_ms : null, null, 'Not loaded', STALE_AFTER_MS)
  if (quietPass) {
    obs.detail = 'Latest satellite pass: no new fire seen'
    obs.tip = m?.data_sources?.find((x) => /satellite passes/i.test(x.name))?.detail ?? 'A confirmed satellite pass over the fire after the last detection saw no new fire.'
  }
  out.push(obs)
  const p = latest(inp.perimeters?.perimeters)
  out.push(row('perimeter', 'Perimeter', p?.t_ms ?? null, p ? `${p.source} · ${fmtAcres(p.acres)}` : null, 'None in this bundle'))
  const d = latest(inp.detections?.detections)
  if (d || !quietPass) out.push(row('detection', 'Last detection', d?.t_ms ?? null, d ? `${d.instrument} · ${satelliteName(d.satellite)}` : null, 'None in this bundle'))
  // the detections file may lag the manifest: the time the burned area is known up to still gets its row
  else out.push(row('detection', 'Last detection', lastFire, 'Newest detection or mapped perimeter', 'None in this bundle'))
  const f = inp.forecast
  out.push(
    row(
      'forecast',
      'Forecast issued',
      f?.issued_ms ?? null,
      f ? `${f.horizon_h} h from ${fmtStatusTime(f.start_ms, nowMs)} · ${f.weather.members} member${f.weather.members === 1 ? '' : 's'} · ${f.run_id}` : null,
      'No forecast run',
    ),
  )
  const w = inp.weather
  const wLast = w && w.t_ms.length ? w.t_ms[w.t_ms.length - 1] : null
  out.push(row('weather', 'Weather to', wLast, w ? `${weatherSourceLabel(w.source)}${w.forecast_from_ms != null ? ` · forecast from ${fmtStatusTime(w.forecast_from_ms, nowMs)}` : ''}` : null, 'Not loaded'))
  if (inp.summary?.updated_ms != null) out.push(row('record', 'CAL FIRE record', inp.summary.updated_ms, null, ''))
  out.push(row('bundle', 'Bundle built', m ? m.built_ms : null, null, 'Not built'))
  return out
}
