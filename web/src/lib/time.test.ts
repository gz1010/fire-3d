import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  fmtAt,
  fmtClock,
  fmtDate,
  fmtDateRange,
  fmtDateTime,
  fmtDateTimeTz,
  fmtDateTimeYear,
  fmtDateTimeYearTz,
  fmtDay,
  fmtDayDate,
  fmtDayRange,
  fmtTime,
  fmtWeekdayDay,
  isValidZone,
  laDayTicks,
  laParts,
  laTicks,
  laWallTicks,
  laWallToMs,
  localDayTicks,
  localHourTicks,
  localWallTicks,
  localYear,
  startOfLaDay,
  startOfLocalDay,
  timeFmt,
  tzLabel,
  viewerZone,
  wallParts,
  wallTimeToMs,
  zoneAbbr,
  zoneLine,
  zoneName,
  zoneOffsetMinutes,
  type Clock,
} from './time'

const DENVER = 'America/Denver'
const NY = 'America/New_York'
const CHI = 'America/Chicago'
const PHX = 'America/Phoenix'
const LA = 'America/Los_Angeles' // tz-ok: test file (the California regression cases)

// Thu Oct 22, 2026 15:40 MDT = 21:40 UTC
const T = Date.UTC(2026, 9, 22, 21, 40)
const tf24 = timeFmt(DENVER, '24h')
const tf12 = timeFmt(DENVER, '12h')

describe('§14.9.2 exact strings (America/Denver)', () => {
  it('fmtClock', () => {
    expect(fmtClock(T, tf24)).toBe('15:40')
    expect(fmtClock(T, tf12)).toBe('3:40 PM')
    // 07:05 MDT = 13:05 UTC
    const t0705 = Date.UTC(2026, 9, 22, 13, 5)
    expect(fmtClock(t0705, tf24)).toBe('07:05')
    expect(fmtClock(t0705, tf12)).toBe('7:05 AM')
    // 00:05 MDT = 06:05 UTC; 12:00 MDT = 18:00 UTC
    expect(fmtClock(Date.UTC(2026, 9, 22, 6, 5), tf12)).toBe('12:05 AM')
    expect(fmtClock(Date.UTC(2026, 9, 22, 6, 5), tf24)).toBe('00:05')
    expect(fmtClock(Date.UTC(2026, 9, 22, 18, 0), tf12)).toBe('12:00 PM')
    expect(fmtClock(Date.UTC(2026, 9, 22, 18, 0), tf24)).toBe('12:00')
  })

  it('fmtClock with the zone', () => {
    expect(fmtClock(T, tf24, { zone: true })).toBe('15:40 MDT')
    expect(fmtClock(T, tf12, { zone: true })).toBe('3:40 PM MDT')
  })

  it('fmtAt', () => {
    expect(fmtAt(T, tf24)).toBe('Oct 22, 15:40')
    expect(fmtAt(T, tf12)).toBe('Oct 22, 3:40 PM')
    expect(fmtAt(T, tf24, { zone: true })).toBe('Oct 22, 15:40 MDT')
    expect(fmtAt(T, tf12, { zone: true })).toBe('Oct 22, 3:40 PM MDT')
    expect(fmtAt(T, tf24, { year: 'always', zone: true })).toBe('Oct 22, 2026 15:40 MDT')
    expect(fmtAt(T, tf12, { year: 'always', zone: true })).toBe('Oct 22, 2026 3:40 PM MDT')
    expect(fmtAt(T, tf24, { weekday: true })).toBe('Thu Oct 22, 15:40')
    expect(fmtAt(T, tf12, { weekday: true })).toBe('Thu Oct 22, 3:40 PM')
  })

  it("fmtAt year 'auto' compares the local year with refMs's", () => {
    expect(fmtAt(T, tf24, { year: 'auto', refMs: T + 10 * DAY_MS })).toBe('Oct 22, 15:40')
    expect(fmtAt(T, tf24, { year: 'auto', refMs: Date.UTC(2027, 2, 1) })).toBe('Oct 22, 2026 15:40')
    expect(fmtAt(T, tf24, { year: 'never' })).toBe('Oct 22, 15:40')
    // Dec 31 20:00 EST is Jan 1 01:00 UTC: still 2026 in New York
    const nye = Date.UTC(2027, 0, 1, 1, 0)
    expect(fmtAt(nye, timeFmt(NY, '24h'), { year: 'auto', refMs: Date.UTC(2026, 6, 1) })).toBe('Dec 31, 20:00')
  })

  it('fmtDayDate, both clocks alike (no time)', () => {
    expect(fmtDayDate(T, DENVER)).toBe('Oct 22')
    expect(fmtDayDate(T, DENVER, { year: 'always' })).toBe('Oct 22, 2026')
    expect(fmtDayDate(T, DENVER, { weekday: true })).toBe('Thu Oct 22')
    expect(fmtDayDate(T, DENVER, { year: 'auto', refMs: Date.UTC(2025, 5, 1) })).toBe('Oct 22, 2026')
  })

  it('fmtDayRange', () => {
    expect(fmtDayRange(Date.UTC(2025, 7, 14, 20), Date.UTC(2025, 7, 18, 20), DENVER)).toBe('Aug 14, 2025 – Aug 18, 2025')
  })

  it('localWallTicks labels in both clocks', () => {
    // Oct 22 00:00 MDT (06:00 UTC) to Oct 22 13:00 MDT, every 6 h
    const s = Date.UTC(2026, 9, 22, 6)
    const e = s + 13 * HOUR_MS
    const t24 = localWallTicks(s, e, 6, tf24)
    const t12 = localWallTicks(s, e, 6, tf12)
    expect(t24.map((t) => t.timeLabel)).toEqual(['00:00', '06:00', '12:00'])
    expect(t12.map((t) => t.timeLabel)).toEqual(['12 AM', '6 AM', '12 PM'])
    expect(t24[0]).toMatchObject({ day: true, dayLabel: 'Oct 22', t: s })
    expect(t12[0]).toMatchObject({ day: true, dayLabel: 'Oct 22', t: s })
    expect(t12[1]).toMatchObject({ day: false, dayLabel: '' })
    expect(localWallTicks(s, e, 1, tf12).find((t) => t.timeLabel === '6 PM')).toBeUndefined()
    expect(localWallTicks(s, e, 1, tf12).map((t) => t.timeLabel)).toContain('1 PM')
    // daily steps: local midnights with the day label
    const days = localWallTicks(s - 1, s + 3 * DAY_MS, 24, tf12)
    expect(days.map((t) => t.dayLabel)).toEqual(['Oct 22', 'Oct 23', 'Oct 24', 'Oct 25'])
    expect(days.every((t) => t.timeLabel === '12 AM' && t.day)).toBe(true)
  })
})

describe('six zones (Node ICU, July and January)', () => {
  const jul = Date.UTC(2026, 6, 15, 18)
  const jan = Date.UTC(2026, 0, 15, 18)
  const cases: [string, string, string][] = [
    [LA, 'PDT', 'PST'],
    ['America/Boise', 'MDT', 'MST'],
    [DENVER, 'MDT', 'MST'],
    [PHX, 'MST', 'MST'],
    [CHI, 'CDT', 'CST'],
    ['America/Indiana/Knox', 'CDT', 'CST'],
    ['America/North_Dakota/Center', 'CDT', 'CST'],
    ['America/Detroit', 'EDT', 'EST'],
    [NY, 'EDT', 'EST'],
  ]
  it.each(cases)('%s: %s / %s', (tz, summer, winter) => {
    expect(zoneAbbr(jul, tz)).toBe(summer)
    expect(zoneAbbr(jan, tz)).toBe(winter)
    expect(fmtClock(jul, timeFmt(tz, '24h'), { zone: true }).endsWith(` ${summer}`)).toBe(true)
  })

  it('offsets', () => {
    expect(zoneOffsetMinutes(jul, LA)).toBe(-420)
    expect(zoneOffsetMinutes(jan, LA)).toBe(-480)
    expect(zoneOffsetMinutes(jul, PHX)).toBe(-420)
    expect(zoneOffsetMinutes(jan, PHX)).toBe(-420)
    expect(zoneOffsetMinutes(jul, CHI)).toBe(-300)
    expect(zoneOffsetMinutes(jan, NY)).toBe(-300)
    expect(zoneOffsetMinutes(jul, 'UTC')).toBe(0)
  })

  it('the same instant reads differently in each zone', () => {
    // 2026-10-17 04:30 UTC = Oct 17 00:30 EDT = Oct 16 21:30 PDT (the audit's G1 example)
    const ms = Date.UTC(2026, 9, 17, 4, 30)
    expect(fmtAt(ms, timeFmt(NY, '24h'), { zone: true })).toBe('Oct 17, 00:30 EDT')
    expect(fmtAt(ms, timeFmt(LA, '24h'), { zone: true })).toBe('Oct 16, 21:30 PDT')
    expect(fmtAt(ms, timeFmt(CHI, '12h'), { zone: true })).toBe('Oct 16, 11:30 PM CDT')
    expect(fmtAt(ms, timeFmt(PHX, '12h'), { zone: true })).toBe('Oct 16, 9:30 PM MST')
    expect(fmtDayDate(ms, NY)).toBe('Oct 17')
    expect(fmtDayDate(ms, LA)).toBe('Oct 16')
  })

  it('zone names and the panel line', () => {
    expect(zoneName(DENVER, jul)).toBe('Mountain Time')
    expect(zoneName(NY, jan)).toBe('Eastern Time')
    expect(zoneName(CHI)).toBe('Central Time')
    expect(zoneName(LA)).toBe('Pacific Time')
    expect(zoneName(PHX)).toBe('Mountain Standard Time')
    expect(zoneLine(timeFmt(DENVER, '12h'), jul, 'fire')).toBe("Times: Mountain Time (MDT), the fire's local time")
    expect(zoneLine(timeFmt(NY, '24h'), jan, 'place')).toBe('Times: Eastern Time (EST), local time at this place')
    expect(zoneLine(timeFmt(CHI, '24h'), jul, 'viewer')).toBe("Times: your device's time (CDT)")
  })
})

describe('zone validation and the viewer fallback (never Pacific)', () => {
  it('isValidZone', () => {
    expect(isValidZone(NY)).toBe(true)
    expect(isValidZone('Mars/Olympus')).toBe(false)
    expect(isValidZone('')).toBe(false)
  })
  it('timeFmt falls back to the viewer zone', () => {
    expect(timeFmt(null, '24h').tz).toBe(viewerZone())
    expect(timeFmt(undefined, '12h').tz).toBe(viewerZone())
    expect(timeFmt('Not/AZone', '24h').tz).toBe(viewerZone())
    expect(timeFmt(NY, '12h')).toEqual({ tz: NY, clock: '12h' })
  })
  it('timeFmt instances are shared and frozen', () => {
    expect(timeFmt(NY, '24h')).toBe(timeFmt(NY, '24h'))
    expect(Object.isFrozen(timeFmt(NY, '24h'))).toBe(true)
    expect(timeFmt(NY, '24h')).not.toBe(timeFmt(NY, '12h'))
  })
  it('zoneAbbr falls back to the offset when the zone has no English abbreviation', () => {
    expect(zoneAbbr(Date.UTC(2026, 0, 15), 'America/Sao_Paulo')).toBe('UTC−3')
    expect(zoneAbbr(Date.UTC(2026, 0, 15), 'Asia/Kolkata')).toMatch(/^(IST|UTC\+5:30)$/)
    expect(zoneAbbr(Date.UTC(2026, 0, 15), 'UTC')).toBe('UTC')
  })
  it('localYear is computed in the zone', () => {
    const ms = Date.UTC(2027, 0, 1, 1, 0) // Dec 31 2026 20:00 EST
    expect(localYear(ms, NY)).toBe(2026)
    expect(localYear(ms, 'UTC')).toBe(2027)
  })
})

describe('DST start and end (2026: Mar 8 and Nov 1)', () => {
  const zones: [string, number, number][] = [
    // zone, standard offset (h), daylight offset (h)
    [NY, -5, -4],
    [CHI, -6, -5],
    [DENVER, -7, -6],
  ]
  it.each(zones)('%s: wallTimeToMs around spring-forward and fall-back', (tz, std, dst) => {
    // a normal time
    expect(wallTimeToMs(tz, 2026, 3, 7, 12, 0)).toBe(Date.UTC(2026, 2, 7, 12 - std))
    expect(wallTimeToMs(tz, 2026, 3, 9, 12, 0)).toBe(Date.UTC(2026, 2, 9, 12 - dst))
    // spring-forward gap: 02:30 does not exist; it resolves forward to 03:30 daylight time
    const gap = wallTimeToMs(tz, 2026, 3, 8, 2, 30)
    expect(gap).toBe(Date.UTC(2026, 2, 8, 2 - std, 30))
    expect(wallParts(gap, tz)).toMatchObject({ day: 8, hour: 3, minute: 30 })
    // 03:00 exists (just after the change)
    expect(wallParts(wallTimeToMs(tz, 2026, 3, 8, 3, 0), tz)).toMatchObject({ hour: 3, minute: 0 })
    // fall-back: 01:30 happens twice; the earlier (daylight) instant wins
    const amb = wallTimeToMs(tz, 2026, 11, 1, 1, 30)
    expect(amb).toBe(Date.UTC(2026, 10, 1, 1 - dst, 30))
    expect(zoneAbbr(amb, tz).endsWith('DT')).toBe(true)
    // midnights
    expect(startOfLocalDay(Date.UTC(2026, 2, 8, 18), tz)).toBe(Date.UTC(2026, 2, 8, -std))
    expect(startOfLocalDay(Date.UTC(2026, 10, 1, 18), tz)).toBe(Date.UTC(2026, 10, 1, -dst))
  })

  it.each(zones)('%s: hourly localWallTicks skip the missing hour and keep 24 local midnights apart', (tz) => {
    const s = wallTimeToMs(tz, 2026, 3, 8)
    const e = wallTimeToMs(tz, 2026, 3, 8, 6)
    const ticks = localWallTicks(s, e, 1, timeFmt(tz, '24h'))
    expect(ticks.map((t) => t.timeLabel)).toEqual(['00:00', '01:00', '03:00', '04:00', '05:00', '06:00'])
    expect(localWallTicks(s, e, 1, timeFmt(tz, '12h')).map((t) => t.timeLabel)).toEqual(['12 AM', '1 AM', '3 AM', '4 AM', '5 AM', '6 AM'])
    // the spring-forward day is 23 h long, the fall-back day 25 h
    const days = localDayTicks(wallTimeToMs(tz, 2026, 3, 7), wallTimeToMs(tz, 2026, 3, 10), tz)
    expect(days.length).toBe(4)
    expect(days[2] - days[1]).toBe(23 * HOUR_MS)
    const fall = localDayTicks(wallTimeToMs(tz, 2026, 10, 31), wallTimeToMs(tz, 2026, 11, 2), tz)
    expect(fall[2] - fall[1]).toBe(25 * HOUR_MS)
    // fall-back hourly ticks: each wall hour once, every tick on the hour
    const fb = localWallTicks(wallTimeToMs(tz, 2026, 11, 1), wallTimeToMs(tz, 2026, 11, 1, 4), 1, timeFmt(tz, '24h'))
    expect(fb.map((t) => t.timeLabel)).toEqual(['00:00', '01:00', '02:00', '03:00', '04:00'])
    expect(fb.every((t) => t.t % HOUR_MS === 0)).toBe(true)
  })

  it('America/Phoenix has no DST: a plain 24 h day and every hour present', () => {
    const s = wallTimeToMs(PHX, 2026, 3, 8)
    expect(s).toBe(Date.UTC(2026, 2, 8, 7))
    const ticks = localWallTicks(s, s + 6 * HOUR_MS, 1, timeFmt(PHX, '24h'))
    expect(ticks.map((t) => t.timeLabel)).toEqual(['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00'])
    const days = localDayTicks(s, wallTimeToMs(PHX, 2026, 11, 3), PHX)
    expect(new Set(days.slice(1).map((d, i) => d - days[i]))).toEqual(new Set([DAY_MS]))
    expect(wallTimeToMs(PHX, 2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 8, 30))
    expect(zoneAbbr(wallTimeToMs(PHX, 2026, 7, 1), PHX)).toBe('MST')
  })

  it('localHourTicks are aligned to local midnight in the zone', () => {
    const s = Date.UTC(2026, 9, 22, 0)
    const ny = localHourTicks(s, s + DAY_MS, NY, 6).map((t) => wallParts(t, NY).hour)
    expect(new Set(ny)).toEqual(new Set([0, 6, 12, 18]))
    const den = localHourTicks(s, s + DAY_MS, DENVER, 12).map((t) => wallParts(t, DENVER).hour)
    expect(new Set(den)).toEqual(new Set([0, 12]))
  })
})

describe('deprecated Pacific names keep their old strings (§14.9.3)', () => {
  // Eaton: Jan 8, 2025 19:40 PST = Jan 9 03:40 UTC
  const eaton = Date.UTC(2025, 0, 9, 3, 40)
  it('formatters', () => {
    expect(fmtDateTime(eaton)).toBe('Jan 8, 19:40')
    expect(fmtDate(eaton)).toBe('Jan 8, 2025')
    expect(fmtDateTimeYear(eaton)).toBe('Jan 8, 2025 19:40')
    expect(fmtTime(eaton)).toBe('19:40')
    expect(fmtDay(eaton)).toBe('Jan 8')
    expect(tzLabel(eaton)).toBe('PST')
    expect(fmtDateTimeTz(eaton)).toBe('Jan 8, 19:40 PST')
    expect(fmtDateTimeYearTz(eaton)).toBe('Jan 8, 2025 19:40 PST')
    expect(fmtWeekdayDay(eaton)).toBe('Wed Jan 8')
    expect(fmtDateRange(Date.UTC(2025, 0, 7, 20), Date.UTC(2025, 0, 31, 20))).toBe('Jan 7, 2025 – Jan 31, 2025')
    expect(laParts(eaton)).toMatchObject({ year: 2025, month: 1, day: 8, hour: 19, minute: 40, weekday: 3 })
  })
  it('the new API in Pacific 24-hour gives the same strings (California Command/Forensic unchanged)', () => {
    const tf = timeFmt(LA, '24h')
    expect(fmtAt(eaton, tf)).toBe(fmtDateTime(eaton))
    expect(fmtAt(eaton, tf, { zone: true })).toBe(fmtDateTimeTz(eaton))
    expect(fmtClock(eaton, tf)).toBe(fmtTime(eaton))
    expect(fmtDayDate(eaton, LA, { year: 'always' })).toBe(fmtDate(eaton))
  })
  it('ticks and wall times', () => {
    expect(laWallToMs(2025, 1, 8, 19, 40)).toBe(eaton)
    expect(laWallToMs(2026, 3, 8, 2, 30)).toBe(Date.UTC(2026, 2, 8, 10, 30)) // gap resolves forward
    expect(laWallToMs(2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 8, 30)) // earliest of the two
    expect(startOfLaDay(eaton)).toBe(Date.UTC(2025, 0, 8, 8))
    const s = Date.UTC(2025, 0, 7, 20)
    const e = Date.UTC(2025, 0, 10, 20)
    expect(laDayTicks(s, e)).toEqual(localDayTicks(s, e, LA))
    expect(laTicks(s, e, 6)).toEqual(localHourTicks(s, e, LA, 6))
    const ticks = laWallTicks(s, e, 6)
    expect(ticks[0]).toMatchObject({ t: s, day: false, timeLabel: '12:00' })
    expect(ticks.find((t) => t.day)).toMatchObject({ dayLabel: 'Jan 8', timeLabel: '00:00', t: Date.UTC(2025, 0, 8, 8) })
  })
})

describe('clock type', () => {
  it('only two clocks', () => {
    const clocks: Clock[] = ['12h', '24h']
    expect(clocks.map((c) => fmtClock(T + 30 * MINUTE_MS, timeFmt(DENVER, c)))).toEqual(['4:10 PM', '16:10'])
  })
})
