// Time helpers (CONTRACT §14.9). Data timestamps are epoch ms UTC; raster times are hours since manifest.time_origin_ms.
//
// Every wall-clock string is made in an explicit IANA zone with an explicit clock (`TimeFmt`): a fire's own times use
// the fire's `summary.time_zone`, overview rows use each row's zone, a point without a fire uses /api/geo/lookup's
// zone, and the fallback is the viewer's own zone, labelled — never Pacific by default (brief 3). The clock is 12-hour
// in the map workspace's Public preset ("3:40 PM MDT") and 24-hour in Command and Forensic ("15:40 MDT").
// Components get their TimeFmt from `useTimeFormat()` (state/timeZone.ts); pure helpers take it as an argument.
//
// The Pacific-bound names of brief 2 (TZ, laParts, fmtDateTime, …) were deleted by the brief-3 integration once
// `node web/scripts/check-time-api.mjs web/src` reported 0 uses (CONTRACT §14.9.3); the checker still guards them.

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ------------------------------------------------------------------------------------------------- zones and clocks
export type Clock = '12h' | '24h'
/** A zone (IANA) and a clock: what every wall-clock formatter needs. Instances from `timeFmt` are frozen and shared, so
 *  they are safe as React dependencies. */
export interface TimeFmt {
  readonly tz: string
  readonly clock: Clock
}

const validCache = new Map<string, boolean>()
/** True when `tz` is an IANA zone this runtime knows. */
export function isValidZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz) return false
  let ok = validCache.get(tz)
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      ok = true
    } catch {
      ok = false
    }
    validCache.set(tz, ok)
  }
  return ok
}

/** The viewer's own zone (the device's), else 'UTC'. */
export function viewerZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz && isValidZone(tz)) return tz
  } catch {
    // fall through
  }
  return 'UTC'
}

const fmtCache = new Map<string, TimeFmt>()
/** A TimeFmt for `tz` (a null, empty or unknown zone falls back to the viewer's zone, never Pacific) and `clock`. */
export function timeFmt(tz: string | null | undefined, clock: Clock): TimeFmt {
  const zone = tz && isValidZone(tz) ? tz : viewerZone()
  const key = `${zone}|${clock}`
  let f = fmtCache.get(key)
  if (!f) {
    f = Object.freeze({ tz: zone, clock })
    fmtCache.set(key, f)
  }
  return f
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${tz}|${key}`
  let f = dtfCache.get(k)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', ...opts })
    dtfCache.set(k, f)
  }
  return f
}

function zonePart(ms: number, tz: string, style: 'short' | 'longGeneric' | 'long'): string | null {
  try {
    return dtf(tz, `tzn-${style}`, { timeZoneName: style }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}

/** "UTC−7", "UTC+5:30", "UTC" for an offset in minutes. */
function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC'
  const a = Math.abs(minutes)
  const h = Math.floor(a / 60)
  const m = a % 60
  return `UTC${minutes < 0 ? '−' : '+'}${h}${m ? `:${pad2(m)}` : ''}`
}

/** Short zone abbreviation at `ms`: "PDT", "MST", "CDT", "EST" (Intl short, en-US). Zones without an English
 *  abbreviation get the offset: "UTC−7". */
export function zoneAbbr(ms: number, tz: string): string {
  const zone = isValidZone(tz) ? tz : viewerZone()
  const s = zonePart(ms, zone, 'short')
  if (s && !/^GMT|^UTC/.test(s)) return s
  return offsetLabel(zoneOffsetMinutes(ms, zone))
}

const UTC_NAMES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu'])
/** The zone's generic name: "Mountain Time", "Eastern Time" (Intl longGeneric, en-US); Arizona reads "Mountain
 *  Standard Time" (no daylight saving time). */
export function zoneName(tz: string, ms: number = Date.now()): string {
  const zone = isValidZone(tz) ? tz : viewerZone()
  if (UTC_NAMES.has(zone)) return 'Coordinated Universal Time'
  return zonePart(ms, zone, 'longGeneric') ?? zone
}

/** The panel's zone line (§14.9.1): "Times: Mountain Time (MDT), the fire's local time" / "Times: Eastern Time (EDT),
 *  local time at this place" / "Times: your device's time (CDT)". */
export function zoneLine(tf: TimeFmt, ms: number, whose: 'fire' | 'place' | 'viewer'): string {
  const abbr = zoneAbbr(ms, tf.tz)
  if (whose === 'viewer') return `Times: your device's time (${abbr})`
  return `Times: ${zoneName(tf.tz, ms)} (${abbr}), ${whose === 'fire' ? "the fire's local time" : 'local time at this place'}`
}

// ------------------------------------------------------------------------------------------------- wall-clock parts
export interface WallParts {
  year: number
  month: number // 1..12
  day: number
  hour: number // 0..23
  minute: number
  weekday: number // 0 = Sunday
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of `ms` in `tz`. */
export function wallParts(ms: number, tz: string): WallParts {
  const parts = dtf(tz, 'parts', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(ms)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WD[get('weekday')] ?? 0,
  }
}

/** UTC offset of `tz` at `ms`, in minutes (-420 for PDT, -240 for EDT). */
export function zoneOffsetMinutes(ms: number, tz: string): number {
  const p = wallParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return Math.round((asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS)
}

/** Epoch ms of local midnight in `tz` on the day containing `ms` (DST-safe). */
export function startOfLocalDay(ms: number, tz: string): number {
  const p = wallParts(ms, tz)
  return wallTimeToMs(tz, p.year, p.month, p.day)
}

/** Epoch ms of a wall-clock time in `tz` (month 1..12). Two passes over the zone's offsets around the time, no fixed
 *  offsets: an ambiguous fall-back time gives the earlier instant, a nonexistent spring-forward time resolves forward
 *  (02:30 on the spring-forward day reads as 03:30 daylight time). */
export function wallTimeToMs(tz: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  // pass 1: the offsets in effect a day either side (a DST change lies between them, if any)
  const offsets = new Set([zoneOffsetMinutes(asUtc - DAY_MS, tz), zoneOffsetMinutes(asUtc + DAY_MS, tz)])
  // pass 2: the offset at the first guess (covers zones whose offset changed for other reasons)
  for (const o of [...offsets]) offsets.add(zoneOffsetMinutes(asUtc - o * MINUTE_MS, tz))
  const candidates = [...offsets].map((o) => asUtc - o * MINUTE_MS).sort((a, b) => a - b)
  const target = wallKey(y, mo, d, h % 24, mi)
  for (const c of candidates) {
    const p = wallParts(c, tz)
    if (wallKey(p.year, p.month, p.day, p.hour, p.minute) === target) return c // earliest match
  }
  return candidates[candidates.length - 1] // in a spring-forward gap: resolve forward
}
const wallKey = (y: number, mo: number, d: number, h: number, mi: number) => (((y * 13 + mo) * 32 + d) * 24 + h) * 60 + mi

/** The calendar year of `ms` in `tz` (a fire found at 8 PM EST on Dec 31 belongs to that year, not UTC's next one). */
export function localYear(ms: number, tz: string): number {
  return wallParts(ms, tz).year
}

// ------------------------------------------------------------------------------------------------- ticks
export interface TimeTick {
  t: number
  /** true at local midnight (day boundary) */
  day: boolean
  /** "Aug 15" at midnight, else "" */
  dayLabel: string
  /** "06:00" (24-hour) or "6 AM" (12-hour) */
  timeLabel: string
}

/** Local-time ticks in `tz` between start and end every `stepHours` (aligned to local midnight). */
export function localHourTicks(startMs: number, endMs: number, tz: string, stepHours = 24): number[] {
  const out: number[] = []
  let day = startOfLocalDay(startMs, tz)
  while (day <= endMs + DAY_MS) {
    for (let h = 0; h < 24; h += stepHours) {
      const t = day + h * HOUR_MS
      if (t >= startMs && t <= endMs) out.push(t)
    }
    day = startOfLocalDay(day + 26 * HOUR_MS, tz)
  }
  return out
}

/** Local-midnight ticks in `tz` every `stepDays` days between start and end (DST-safe). */
export function localDayTicks(startMs: number, endMs: number, tz: string, stepDays = 1): number[] {
  const out: number[] = []
  let day = startOfLocalDay(startMs, tz)
  let i = 0
  while (day <= endMs) {
    if (day >= startMs && i % stepDays === 0) out.push(day)
    day = startOfLocalDay(day + 26 * HOUR_MS, tz)
    i++
  }
  return out
}

const TICK_STEPS_H = [1, 3, 6, 12, 24, 48, 168, 336, 672]

/** Smallest tick step (hours) from 1 h … 4 weeks whose spacing is at least `minPx` for the given width. */
export function tickStepHours(spanMs: number, widthPx: number, minPx: number): number {
  const pxPerHour = widthPx / Math.max(1, spanMs / HOUR_MS)
  return TICK_STEPS_H.find((h) => h * pxPerHour >= minPx) ?? TICK_STEPS_H[TICK_STEPS_H.length - 1]
}

/** Hour label of a tick: "06:00" (24-hour) or "6 AM" / "12 PM" (12-hour). */
function hourLabel(h: number, clock: Clock): string {
  if (clock === '24h') return `${pad2(h)}:00`
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
}

/** Wall-clock aligned ticks in `tf.tz` every `stepHours` (multi-day steps land on local midnights). Hourly steps skip
 *  the spring-forward gap and keep both hours of a fall-back day only once each. */
export function localWallTicks(startMs: number, endMs: number, stepHours: number, tf: TimeFmt): TimeTick[] {
  const out: TimeTick[] = []
  if (!(endMs > startMs)) return out
  const tz = tf.tz
  const p0 = wallParts(startMs, tz)
  let y = p0.year
  let mo = p0.month
  let d = p0.day
  const nDays = Math.max(1, Math.round(stepHours / 24))
  for (let guard = 0; guard < 2000; guard++) {
    const midnight = wallTimeToMs(tz, y, mo, d)
    if (midnight > endMs) break
    if (stepHours >= 24) {
      // stable alignment: even days for 2-day steps, Mondays for weekly steps (day 0 = Thu Jan 1 1970)
      const dayNumber = Math.round(Date.UTC(y, mo - 1, d) / DAY_MS) + (nDays % 7 === 0 ? 3 : 0)
      if (dayNumber % nDays === 0 && midnight >= startMs)
        out.push({ t: midnight, day: true, dayLabel: fmtDayDate(midnight, tz), timeLabel: hourLabel(0, tf.clock) })
    } else {
      for (let h = 0; h < 24; h += stepHours) {
        const t = wallTimeToMs(tz, y, mo, d, h)
        if (t < startMs || t > endMs || (stepHours < 6 && wallParts(t, tz).hour !== h)) continue // skip the spring-forward gap
        out.push({ t, day: h === 0, dayLabel: h === 0 ? fmtDayDate(t, tz) : '', timeLabel: hourLabel(h, tf.clock) })
      }
    }
    // next local day: noon + 24 h is always inside the next day
    const next = wallParts(wallTimeToMs(tz, y, mo, d, 12) + DAY_MS, tz)
    y = next.year
    mo = next.month
    d = next.day
  }
  return out
}

// ------------------------------------------------------------------------------------------------- formatters
/** "15:40" / "07:05" (24-hour) or "3:40 PM" / "7:05 AM" / "12:05 AM" (12-hour); `zone: true` adds " MDT". */
export function fmtClock(ms: number, tf: TimeFmt, o: { zone?: boolean } = {}): string {
  const p = wallParts(ms, tf.tz)
  const clock =
    tf.clock === '24h' ? `${pad2(p.hour)}:${pad2(p.minute)}` : `${p.hour % 12 === 0 ? 12 : p.hour % 12}:${pad2(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`
  return o.zone ? `${clock} ${zoneAbbr(ms, tf.tz)}` : clock
}

type YearMode = 'auto' | 'always' | 'never'
function showYear(ms: number, tz: string, year: YearMode | undefined, refMs: number | undefined): boolean {
  if (year === 'always') return true
  if (year !== 'auto') return false
  return localYear(ms, tz) !== localYear(refMs ?? Date.now(), tz)
}

/** A day and a time: "Oct 22, 15:40" / "Oct 22, 3:40 PM"; `zone` adds the abbreviation ("Oct 22, 15:40 MDT"),
 *  `year` 'always' gives "Oct 22, 2026 15:40 MDT" ('auto': only when the local year differs from `refMs`'s, default
 *  now; default 'never'), `weekday` gives "Thu Oct 22, 15:40". */
export function fmtAt(
  ms: number,
  tf: TimeFmt,
  o: { year?: YearMode; zone?: boolean; weekday?: boolean; refMs?: number } = {},
): string {
  const p = wallParts(ms, tf.tz)
  const wd = o.weekday ? `${WEEKDAYS[p.weekday]} ` : ''
  const day = `${wd}${MONTHS[p.month - 1]} ${p.day}`
  const date = showYear(ms, tf.tz, o.year, o.refMs) ? `${day}, ${p.year} ` : `${day}, `
  return `${date}${fmtClock(ms, tf, { zone: o.zone })}`
}

/** A day without a time in `tz`: "Oct 22"; `year` 'always' gives "Oct 22, 2026"; `weekday` gives "Thu Oct 22". */
export function fmtDayDate(ms: number, tz: string, o: { year?: YearMode; weekday?: boolean; refMs?: number } = {}): string {
  const p = wallParts(ms, tz)
  const wd = o.weekday ? `${WEEKDAYS[p.weekday]} ` : ''
  const day = `${wd}${MONTHS[p.month - 1]} ${p.day}`
  return showYear(ms, tz, o.year, o.refMs) ? `${day}, ${p.year}` : day
}

/** "Aug 14, 2025 – Aug 18, 2025" (the header style), each day in `tz`. */
export function fmtDayRange(startMs: number, endMs: number, tz: string): string {
  return `${fmtDayDate(startMs, tz, { year: 'always' })} – ${fmtDayDate(endMs, tz, { year: 'always' })}`
}

// ------------------------------------------------------------------------------------------------- zone-free helpers
/** "T+05:30" style offset for hours (negative -> "T−01:00"). */
export function fmtTPlus(hours: number): string {
  const sign = hours < 0 ? '−' : '+'
  const total = Math.round(Math.abs(hours) * 60)
  const h = Math.floor(total / 60)
  return `T${sign}${pad2(h)}:${pad2(total % 60)}`
}

/** "2d 05h", "5h 30m", "12m" */
export function fmtDuration(ms: number): string {
  const m = Math.round(Math.abs(ms) / MINUTE_MS)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `${d}d ${pad2(h)}h`
  if (h > 0) return `${h}h ${pad2(mm)}m`
  return `${mm}m`
}

/** Relative wall-clock time: "just now", "4 min ago", "3 h ago", "2 d ago", "in 12 min". */
export function fmtRelative(ms: number, nowMs: number = Date.now()): string {
  const d = nowMs - ms
  const a = Math.abs(d)
  let s: string
  if (a < 45_000) return 'just now'
  if (a < HOUR_MS) s = `${Math.round(a / MINUTE_MS)} min`
  else if (a < 36 * HOUR_MS) s = `${Math.round(a / HOUR_MS)} h`
  else s = `${Math.round(a / DAY_MS)} d`
  return d >= 0 ? `${s} ago` : `in ${s}`
}

/** Floor to the whole UTC hour (forecast start times are hourly). */
export function floorToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}

/** Hours since an origin (raster time units). */
export function hoursSince(ms: number, originMs: number): number {
  return (ms - originMs) / HOUR_MS
}

/** Epoch ms from raster hours. */
export function msFromHours(hours: number, originMs: number): number {
  return originMs + hours * HOUR_MS
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
