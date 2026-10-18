// Time helpers. Data timestamps are epoch ms UTC; the UI shows America/Los_Angeles time (SPEC 4.2),
// e.g. "Aug 14, 17:02". Raster times are hours since manifest.time_origin_ms.

export const TZ = 'America/Los_Angeles'
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

const cache = new Map<string, Intl.DateTimeFormat>()
function fmt(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', ...opts })
    cache.set(key, f)
  }
  return f
}

/** "Aug 14, 17:02" */
export function fmtDateTime(ms: number): string {
  const p = laParts(ms)
  return `${MONTHS[p.month - 1]} ${p.day}, ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** "Aug 14, 2025" */
export function fmtDate(ms: number): string {
  return fmt('date', { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

/** "Aug 14, 2025 14:26" */
export function fmtDateTimeYear(ms: number): string {
  const p = laParts(ms)
  return `${MONTHS[p.month - 1]} ${p.day}, ${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** "17:02" */
export function fmtTime(ms: number): string {
  const p = laParts(ms)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

/** "Aug 14" */
export function fmtDay(ms: number): string {
  const p = laParts(ms)
  return `${MONTHS[p.month - 1]} ${p.day}`
}

/** "Aug 14, 2025 – Aug 18, 2025" (the reference header style). */
export function fmtDateRange(startMs: number, endMs: number): string {
  return `${fmtDate(startMs)} – ${fmtDate(endMs)}`
}

/** Short zone label for a timestamp: "PDT" / "PST". */
export function tzLabel(ms: number): string {
  const part = fmt('tz', { timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')
  return part?.value ?? 'PT'
}

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

export interface LaParts {
  year: number
  month: number // 1..12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = Sunday
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Wall-clock parts in America/Los_Angeles. */
export function laParts(ms: number): LaParts {
  const parts = fmt('parts', {
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

/** UTC offset of America/Los_Angeles at `ms`, in minutes (e.g. -420 for PDT). */
export function laOffsetMinutes(ms: number): number {
  const p = laParts(ms)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return Math.round((asUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS)
}

/** Epoch ms of local (LA) midnight on the day containing `ms` (DST-safe). */
export function startOfLaDay(ms: number): number {
  const p = laParts(ms)
  let guess = Date.UTC(p.year, p.month - 1, p.day) - laOffsetMinutes(ms) * MINUTE_MS
  // correct across a DST change between midnight and `ms`
  guess -= (laOffsetMinutes(guess) - laOffsetMinutes(ms)) * MINUTE_MS
  return guess
}

/** Local-time ticks between start and end every `stepHours` (aligned to LA midnight). */
export function laTicks(startMs: number, endMs: number, stepHours = 24): number[] {
  const out: number[] = []
  let day = startOfLaDay(startMs)
  while (day <= endMs + DAY_MS) {
    for (let h = 0; h < 24; h += stepHours) {
      const t = day + h * HOUR_MS
      if (t >= startMs && t <= endMs) out.push(t)
    }
    day = startOfLaDay(day + 26 * HOUR_MS)
  }
  return out
}

/** Local-midnight ticks every `stepDays` days between start and end (DST-safe). */
export function laDayTicks(startMs: number, endMs: number, stepDays = 1): number[] {
  const out: number[] = []
  let day = startOfLaDay(startMs)
  let i = 0
  while (day <= endMs) {
    if (day >= startMs && i % stepDays === 0) out.push(day)
    day = startOfLaDay(day + 26 * HOUR_MS)
    i++
  }
  return out
}

/** "Aug 14, 17:02 PDT" */
export function fmtDateTimeTz(ms: number): string {
  return `${fmtDateTime(ms)} ${tzLabel(ms)}`
}

/** "Aug 14, 2025 14:26 PDT" */
export function fmtDateTimeYearTz(ms: number): string {
  return `${fmtDateTimeYear(ms)} ${tzLabel(ms)}`
}

/** "Fri Aug 14" */
export function fmtWeekdayDay(ms: number): string {
  const p = laParts(ms)
  return `${WEEKDAYS[p.weekday]} ${MONTHS[p.month - 1]} ${p.day}`
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

/** Epoch ms of an America/Los_Angeles wall-clock time (DST-safe; nonexistent spring-forward times resolve forward). */
export function laWallToMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  // Pacific time is UTC-7 (PDT) or UTC-8 (PST): keep the candidate whose wall clock matches (earliest if ambiguous)
  const pdt = asUtc + 420 * MINUTE_MS
  const pst = asUtc + 480 * MINUTE_MS
  const matches = (ms: number) => {
    const p = laParts(ms)
    return p.day === day && p.hour === hour % 24 && p.minute === minute
  }
  if (matches(pdt)) return pdt
  if (matches(pst)) return pst
  return pst // nonexistent spring-forward time: resolve forward
}

export interface TimeTick {
  t: number
  /** true at local midnight (day boundary) */
  day: boolean
  /** "Aug 15" at midnight, else "" */
  dayLabel: string
  /** "06:00" */
  timeLabel: string
}

const TICK_STEPS_H = [1, 3, 6, 12, 24, 48, 168, 336, 672]

/** Smallest tick step (hours) from 1 h … 4 weeks whose spacing is at least `minPx` for the given width. */
export function tickStepHours(spanMs: number, widthPx: number, minPx: number): number {
  const pxPerHour = widthPx / Math.max(1, spanMs / HOUR_MS)
  return TICK_STEPS_H.find((h) => h * pxPerHour >= minPx) ?? TICK_STEPS_H[TICK_STEPS_H.length - 1]
}

/** Wall-clock aligned ticks in Pacific time (every `stepHours`; multi-day steps land on local midnights). */
export function laWallTicks(startMs: number, endMs: number, stepHours: number): TimeTick[] {
  const out: TimeTick[] = []
  if (!(endMs > startMs)) return out
  const p0 = laParts(startMs)
  let y = p0.year
  let mo = p0.month
  let d = p0.day
  const nDays = Math.max(1, Math.round(stepHours / 24))
  for (let guard = 0; guard < 2000; guard++) {
    const midnight = laWallToMs(y, mo, d)
    if (midnight > endMs) break
    if (stepHours >= 24) {
      // stable alignment: even days for 2-day steps, Mondays for weekly steps (day 0 = Thu Jan 1 1970)
      const dayNumber = Math.round(Date.UTC(y, mo - 1, d) / DAY_MS) + (nDays % 7 === 0 ? 3 : 0)
      if (dayNumber % nDays === 0 && midnight >= startMs) out.push({ t: midnight, day: true, dayLabel: fmtDay(midnight), timeLabel: '00:00' })
    } else {
      for (let h = 0; h < 24; h += stepHours) {
        const t = laWallToMs(y, mo, d, h)
        if (t < startMs || t > endMs || (stepHours < 6 && laParts(t).hour !== h)) continue // skip the spring-forward gap
        out.push({ t, day: h === 0, dayLabel: h === 0 ? fmtDay(t) : '', timeLabel: `${pad2(h)}:00` })
      }
    }
    // next local day: noon + 24 h is always inside the next day
    const next = laParts(laWallToMs(y, mo, d, 12) + DAY_MS)
    y = next.year
    mo = next.month
    d = next.day
  }
  return out
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
