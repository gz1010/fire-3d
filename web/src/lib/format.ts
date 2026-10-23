// Number/unit formatting for the UI (SPEC 4.5): acres, mph + cardinal, chains/hr, ft, °C, %, m.

export const ACRE_M2 = 4046.8564224
export const CHAIN_M = 20.1168
export const MPH_PER_MS = 2.2369362920544
export const FT_PER_M = 3.280839895
export const KT_PER_MS = 1.9438444924

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

const isNum = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/** 12480.4 -> "12,480" (digits = decimals). */
export function fmtNumber(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return '—'
  if (digits === 0) return nf0.format(v)
  if (digits === 1) return nf1.format(v)
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)
}

/** "12,480 ac" (or "—"). */
export function fmtAcres(acres: number | null | undefined, unit = true): string {
  if (!isNum(acres)) return '—'
  const s = acres < 10 ? fmtNumber(acres, 1) : fmtNumber(acres)
  return unit ? `${s} ac` : s
}

export const m2ToAcres = (m2: number) => m2 / ACRE_M2
export const msToMph = (ms: number) => ms * MPH_PER_MS
export const mToFt = (m: number) => m * FT_PER_M
/** metres per hour -> chains per hour */
export const metresPerHourToChains = (metresPerHour: number) => metresPerHour / CHAIN_M
/** chains per hour -> metres per minute */
export const chainsPerHourToMetresPerMin = (chPerH: number) => (chPerH * CHAIN_M) / 60

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

/** 16-point compass name of a direction in degrees (275 -> "W"). */
export function cardinal(deg: number | null | undefined): string {
  if (!isNum(deg)) return '—'
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

/** "19 mph" from m/s. */
export function fmtMph(speedMs: number | null | undefined): string {
  return isNum(speedMs) ? `${fmtNumber(msToMph(speedMs))} mph` : '—'
}

/** "W (275°)" from a FROM direction. */
export function fmtDirection(dirDeg: number | null | undefined): string {
  return isNum(dirDeg) ? `${cardinal(dirDeg)} (${fmtNumber(((dirDeg % 360) + 360) % 360)}°)` : '—'
}

/** "19 mph W (275°)" */
export function fmtWind(speedMs: number | null | undefined, dirDeg: number | null | undefined): string {
  return `${fmtMph(speedMs)} ${fmtDirection(dirDeg)}`
}

/** "27 ch/h" */
export function fmtRos(chPerH: number | null | undefined): string {
  return isNum(chPerH) ? `${fmtNumber(chPerH, chPerH < 10 ? 1 : 0)} ch/h` : '—'
}

/** "6 ft" from metres. */
export function fmtFt(m: number | null | undefined): string {
  return isNum(m) ? `${fmtNumber(mToFt(m))} ft` : '—'
}

/** "6–9 ft" range from feet values. */
export function fmtFtRange(loFt: number | null | undefined, hiFt: number | null | undefined): string {
  if (!isNum(loFt) || !isNum(hiFt)) return '—'
  return `${fmtNumber(loFt)}–${fmtNumber(hiFt)} ft`
}

/** "34 °C" */
export function fmtTemp(c: number | null | undefined): string {
  return isNum(c) ? `${fmtNumber(c)} °C` : '—'
}

/** "13%" (value already in percent). */
export function fmtPct(v: number | null | undefined, digits = 0): string {
  return isNum(v) ? `${fmtNumber(v, digits)}%` : '—'
}

/** "62%" from a 0..1 fraction. */
export function fmtFraction(v: number | null | undefined, digits = 0): string {
  return isNum(v) ? `${fmtNumber(v * 100, digits)}%` : '—'
}

/** "1,240 m" */
export function fmtElev(m: number | null | undefined): string {
  return isNum(m) ? `${fmtNumber(m)} m` : '—'
}

/** "2.4 km" / "850 m" */
export function fmtDistance(m: number | null | undefined): string {
  if (!isNum(m)) return '—'
  return Math.abs(m) >= 1000 ? `${fmtNumber(m / 1000, 1)} km` : `${fmtNumber(m)} m`
}

/** "34.2017° N, 118.0712° W" */
export function fmtLatLon(lat: number | null | undefined, lon: number | null | undefined, digits = 4): string {
  if (!isNum(lat) || !isNum(lon)) return '—'
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`
}

/** "123 MW" */
export function fmtFrp(mw: number | null | undefined): string {
  return isNum(mw) ? `${fmtNumber(mw, mw < 10 ? 1 : 0)} MW` : '—'
}

/** Compact axis label: 900 -> "900", 15000 -> "15,000", 131612 -> "132k", 2.5e6 -> "2.5M". */
export function fmtAxis(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a >= 1e6) return `${fmtNumber(v / 1e6, a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e5) return `${fmtNumber(v / 1e3)}k`
  if (a > 0 && a < 1) return fmtNumber(v, 2)
  if (a > 0 && a < 10 && !Number.isInteger(v)) return fmtNumber(v, 1)
  return fmtNumber(v)
}

/** Hectares per acre (the map's overview labels and the plain-language areas use the same factor). */
const HA_PER_ACRE_FMT = 0.40468564224

/** "12.5k ac" style for tight spaces (exact below 10,000); `units` 'metric' gives hectares ("5.1k ha"), as the map's
 *  overview labels do (final verification, panel SR-m4). */
export function fmtAcresShort(acres: number | null | undefined, units: 'us' | 'metric' = 'us'): string {
  if (!isNum(acres)) return '—'
  const v = units === 'metric' ? acres * HA_PER_ACRE_FMT : acres
  const u = units === 'metric' ? 'ha' : 'ac'
  if (v >= 1e5) return `${fmtNumber(v / 1e3)}k ${u}`
  if (v >= 1e4) return `${fmtNumber(v / 1e3, 1)}k ${u}`
  return `${fmtAcres(v, false)} ${u}`
}

/** "145 kt" */
export function fmtKt(kt: number | null | undefined): string {
  return isNum(kt) ? `${fmtNumber(kt)} kt` : '—'
}

/** Altitude in feet from metres: "1,480 ft". */
export function fmtAltFt(m: number | null | undefined): string {
  return isNum(m) ? `${fmtNumber(mToFt(m))} ft` : '—'
}

/** "+12%" / "−8%" (value already in percent). */
export function fmtSignedPct(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return '—'
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNumber(Math.abs(v), digits)}%`
}

const SATELLITES: Record<string, string> = {
  N: 'Suomi NPP',
  NPP: 'Suomi NPP',
  SNPP: 'Suomi NPP',
  N20: 'NOAA-20',
  'NOAA-20': 'NOAA-20',
  J1: 'NOAA-20',
  N21: 'NOAA-21',
  'NOAA-21': 'NOAA-21',
  J2: 'NOAA-21',
  Aqua: 'Aqua',
  A: 'Aqua',
  Terra: 'Terra',
  T: 'Terra',
  G16: 'GOES-16',
  G17: 'GOES-17',
  G18: 'GOES-18',
  G19: 'GOES-19',
  L8: 'Landsat 8',
  L9: 'Landsat 9',
}

/** Human name of a FIRMS satellite code ("N20" -> "NOAA-20", "G18" -> "GOES-18"). */
export function satelliteName(code: string | null | undefined): string {
  if (!code) return '—'
  return SATELLITES[code] ?? SATELLITES[code.toUpperCase()] ?? code
}
