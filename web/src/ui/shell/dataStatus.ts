// Command preset "Data status" rows (owner: shell; BRIEF §2 Command, §8): the newest timestamp of every source in the
// selected incident's bundle, so operators see how current each input is. Pure (tested in dataStatus.test.ts).
// Times are absolute (America/Los_Angeles with zone, plus the year when it is not the current one); live incidents add
// the age against the wall clock and flag observations older than the timeline's stale threshold. Replays show
// archived times only (no "ago"). Live "Last observation" can be a confirmed satellite pass that saw no new fire
// (time_range.now_ms, SPEC 8.3): when the newest detection or mapped perimeter is more than an hour older, the row says
// so and the detection row keeps the time the burned area is known up to.
// Brief 2 (U-R9): one freshness pattern. Official sources get their own rows (Cal OES evacuation zones, NWS fire
// weather, CAL FIRE's record) with the issuer's update time and Fire-3d's check time; a past fire's CAL FIRE row always
// carries the year and says it is the record's last edit. Public gets one line (freshnessLine) with the same rows as
// details.
import type { DetectionsFile, ForecastManifest, IncidentManifest, IncidentSummary, PerimetersFile, WeatherFile } from '../../api/types'
import { fmtAcres, satelliteName } from '../../lib/format'
import { evacuationWho, type EvacuationOfficial } from '../../official/model'
import { fmtAt, fmtDate, fmtDateTimeTz, fmtDateTimeYearTz, fmtRelative, laParts, type TimeFmt } from '../../lib/time'
import { STALE_AFTER_MS } from '../timeline/model'

/** Gap between the newest detection / perimeter and the latest observation above which the latter is a quiet pass. */
export const QUIET_PASS_MIN_MS = 3_600_000

export type StatusKey = 'observations' | 'perimeter' | 'detection' | 'forecast' | 'weather' | 'record' | 'evacuation' | 'fire-weather' | 'bundle'

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

/** The official sources for the current fire, as official-web's useOfficialNow() gives them (I5; structural, so the
 *  rows build without the hook). Missing = not loaded. */
export interface OfficialStatusInput {
  evacuation?: (Pick<EvacuationOfficial, 'state'> & Partial<Pick<EvacuationOfficial, 'checkedMs' | 'sourceUpdatedMs' | 'reason' | 'sources' | 'checkedBy'>> & { zones?: readonly unknown[] }) | null
  fireWeather?: { state: string; checkedMs?: number | null; alerts?: readonly { archived?: boolean }[] } | null
  calfire?: { state: string; updatedMs?: number | null; acres?: number | null; percentContained?: number | null; isActive?: boolean | null } | null
}

export interface DataStatusInput {
  summary: Pick<IncidentSummary, 'mode' | 'updated_ms'> | null
  manifest: (Pick<IncidentManifest, 'mode' | 'time_range' | 'built_ms'> & { data_sources?: IncidentManifest['data_sources'] }) | null
  perimeters: PerimetersFile | null
  detections: DetectionsFile | null
  forecast: Pick<ForecastManifest, 'run_id' | 'issued_ms' | 'start_ms' | 'horizon_h' | 'weather'> | null
  weather: Pick<WeatherFile, 'source' | 't_ms' | 'forecast_from_ms'> | null
  official?: OfficialStatusInput | null
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

/** Absolute time with zone; the year is added when it differs from the year of `nowMs`.
 *  @deprecated Pacific-bound: use `fmtStatusTimeAt(tMs, nowMs, tf)` (CONTRACT §14.9.6). */
export function fmtStatusTime(tMs: number, nowMs: number): string {
  return laParts(tMs).year === laParts(nowMs).year ? fmtDateTimeTz(tMs) : fmtDateTimeYearTz(tMs)
}

/** Absolute time in `tf`'s zone and clock with the zone abbreviation; the year is added when the local year differs
 *  from `nowMs`'s ("Oct 22, 15:40 MDT", "Jan 8, 2025 4:00 AM PST"). */
export function fmtStatusTimeAt(tMs: number, nowMs: number, tf: TimeFmt): string {
  return fmtAt(tMs, tf, { zone: true, year: 'auto', refMs: nowMs })
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
  out.push(...officialRows(inp, nowMs, live))
  out.push(row('bundle', 'Bundle built', m ? m.built_ms : null, null, 'Not built'))
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Cal OES, NWS and CAL FIRE rows: the issuer's time where it gives one, Fire-3d's check time as the age. */
export function officialRows(inp: Pick<DataStatusInput, 'summary' | 'official'>, nowMs: number, live: boolean): StatusRow[] {
  const o = inp.official ?? null
  const out: StatusRow[] = []
  const ago = (t: number | null | undefined) => (t != null && Number.isFinite(t) ? `checked ${fmtRelative(t, nowMs)}` : null)

  const ev = o?.evacuation
  if (ev) {
    const who = evacuationWho(ev)
    const answered = (ev.sources ?? []).filter((s) => s.answered)
    const updated = answered.length > 1 ? null : (ev.sourceUpdatedMs ?? null)
    const n = ev.zones?.length ?? 0
    const detail =
      ev.state === 'listed'
        ? `${plural(n, 'zone', 'zones')} listed near this fire (local officials via ${who ?? 'the state source'})`
        : ev.state === 'none-listed'
          ? 'No orders or warnings listed near this fire. That is not an all-clear.'
          : ev.state === 'past-date'
            ? 'Official status is shown only for the current time'
            : ev.state === 'not-available'
              ? `${ev.reason ?? 'Not available in this state'}; follow local officials`
              : ev.state === 'unavailable'
                ? `${who ?? 'The evacuation source'} did not answer; follow local officials`
                : ev.state === 'loading'
                  ? 'Checking…'
                  : 'Not checked for this place'
    // several sources (a border fire): each with its own time, never one time for both
    const value =
      answered.length > 1
        ? answered.map((s) => `${s.aggregator} ${s.updatedMs != null ? fmtStatusTime(s.updatedMs, nowMs) : 'no time'}`).join('; ')
        : updated != null
          ? `${who ?? 'Source'} ${fmtStatusTime(updated, nowMs)}`
          : ev.state === 'loading'
            ? 'Checking'
            : ev.state === 'not-available'
              ? 'Not available in this state'
              : 'No issuer time'
    const tips: Record<string, string> = {
      caloes_evacuations: 'Cal OES rebuilds its statewide evacuation layer every 5 minutes; the time is its last change.',
      or_oem_evacuations: 'Oregon OEM recalculates its statewide evacuation layer every 15 minutes; the time is its last change, not an order time.',
    }
    const srcTips = (ev.sources ?? []).map((s) => tips[s.id]).filter(Boolean)
    out.push({
      key: 'evacuation',
      label: 'Evacuation zones',
      value,
      tMs: updated,
      detail,
      age: ago(ev.checkedMs),
      stale: false,
      tip:
        ev.state === 'not-available'
          ? 'Fire-3d found no free, official, public, machine-readable state evacuation feed for this state (checked Oct 22, 2026). Follow local officials.'
          : `${srcTips.length ? srcTips.join(' ') : tips.caloes_evacuations} Fire-3d checks every 2 minutes while live.`,
    })
  }

  const fw = o?.fireWeather
  if (fw) {
    const n = fw.alerts?.length ?? 0
    const archived = fw.alerts?.some((a) => a.archived) ?? false
    const detail =
      fw.state === 'active'
        ? `${plural(n, 'Red Flag Warning or Fire Weather Watch', 'Red Flag Warnings or Fire Weather Watches')}${archived ? ' (archived copy: Iowa Environmental Mesonet)' : ''}`
        : fw.state === 'none'
          ? 'No Red Flag Warning or Fire Weather Watch listed here. That is not an all-clear.'
          : fw.state === 'past-date'
            ? 'Past alerts are not available for this time'
            : fw.state === 'unavailable'
              ? 'The National Weather Service did not answer'
              : 'Checking…'
    out.push({
      key: 'fire-weather',
      label: 'Fire weather',
      value: fw.checkedMs != null ? `NWS, checked ${fmtStatusTime(fw.checkedMs, nowMs)}` : fw.state === 'loading' ? 'Checking' : 'Not checked',
      tMs: fw.checkedMs ?? null,
      detail,
      age: live ? ago(fw.checkedMs) : null,
      stale: false,
      tip: 'National Weather Service fire weather alerts (Red Flag Warnings, Fire Weather Watches) covering the fire area.',
    })
  }

  const cf = o?.calfire
  const recordMs = cf?.updatedMs ?? inp.summary?.updated_ms ?? null
  if (recordMs != null && Number.isFinite(recordMs)) {
    const facts = cf && cf.state === 'available' ? [cf.acres != null ? fmtAcres(cf.acres) : null, cf.percentContained != null ? `${cf.percentContained}% contained` : null].filter(Boolean).join(' · ') : ''
    out.push({
      key: 'record',
      label: 'CAL FIRE record',
      // a past fire's record is often edited long after the fire: always show the year and say what the time is
      value: live ? fmtStatusTime(recordMs, nowMs) : fmtDateTimeYearTz(recordMs),
      tMs: recordMs,
      detail: live ? facts || 'CAL FIRE’s latest update of the incident' : `Last edit of CAL FIRE’s record${facts ? ` · ${facts}` : ''}`,
      age: live ? fmtRelative(recordMs, nowMs) : null,
      stale: false,
      tip: live
        ? 'CAL FIRE updates its incident records by hand, usually a few times a day.'
        : 'CAL FIRE keeps one final record per past fire; its last edit (final acreage, containment date) can come months after the fire. Its update-by-update history is not available.',
    })
  }
  return out
}

export interface FreshnessLine {
  /** One line for Public: "Sources checked 2 min ago · satellite data 16 h old". */
  text: string
  /** The latest observation is older than the timeline's stale threshold (live). */
  stale: boolean
}

/** Public's one freshness line from the data-status rows (live: ages; replays: the archived record's end). */
export function freshnessLine(rows: readonly StatusRow[], live: boolean, nowMs: number, checkedMs: number | null): FreshnessLine {
  const obs = rows.find((r) => r.key === 'observations')
  if (!live) return { text: obs?.tMs != null ? `Archived replay to ${fmtDate(obs.tMs)}` : 'Archived replay', stale: false }
  const parts: string[] = []
  if (checkedMs != null && Number.isFinite(checkedMs)) parts.push(`Sources checked ${fmtRelative(checkedMs, nowMs)}`)
  if (obs?.tMs != null) parts.push(`satellite data ${fmtAge(nowMs - obs.tMs)} old`)
  return { text: parts.length ? parts.join(' · ') : 'Checking sources…', stale: obs?.stale ?? false }
}

/** "16 h", "40 min", "2 d" (an age, never "ago"). */
export function fmtAge(ms: number): string {
  const a = Math.max(0, ms)
  if (a < 3_600_000) return `${Math.max(1, Math.round(a / 60_000))} min`
  if (a < 36 * 3_600_000) return `${Math.round(a / 3_600_000)} h`
  return `${Math.round(a / 86_400_000)} d`
}
