// Plain-language telemetry for Public/Command (owner: timeline-feed; CONTRACT §8, BRIEF §9). Primary labels use
// everyday words and units from the workspace `units` setting (US customary by default); the original scientific
// name, value and unit stay in `scientific` for detail views and Forensic.
// No invented categories: nothing here sorts a value into "slow / fast / low / high". Fire weather severity (FFWI) is
// shown as its 0-100 value with an explanation: the only threshold found (NOAA SPC's old note that FFWI >= 50
// "generally appears significant on a national scale") is an informal rule of thumb, not a category scale, and its
// page is offline, so it is not used.
import type { EnsembleKind, ForecastManifest, Mode } from '../api/types'
import type { LatticeField } from '../state/store'
import type { Units } from '../state/workspace'
import { CHAIN_M, FT_PER_M, MPH_PER_MS, cardinal, satelliteName } from './format'
import { HOUR_MS, fmtDateTime, fmtDateTimeYear, fmtRelative, tzLabel } from './time'

export interface PlainValue {
  /** Primary everyday text, e.g. "0.4 mph". "—" when unknown. */
  text: string
  /** Number in `unit` (null when unknown). */
  value: number | null
  unit: string
  /** Original scientific name, value and unit for details / Forensic, e.g. "Rate of spread (ROS) 32 ch/h". */
  scientific: string | null
}

export const MI_M = 1609.344
export const HA_PER_ACRE = 0.40468564224

const UNKNOWN = (unit: string): PlainValue => ({ text: '—', value: null, unit, scientific: null })
const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const nf = (digits: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const NF0 = nf(0)
const NF1 = nf(1)
const NF2 = nf(2)

/** "12,480" / "3.4" / "0.25": integers from 10, one decimal from 1, two decimals below 1. */
export function fmtPlainNumber(v: number): string {
  const a = Math.abs(v)
  if (a >= 10) return NF0.format(v)
  if (a >= 1) return NF1.format(v)
  return NF2.format(v)
}

/** Speeds: "0" for zero, "< 0.01" for tiny positive values, else fmtPlainNumber. */
function speedNumber(v: number): string {
  if (v === 0) return '0'
  if (v < 0.005) return '< 0.01'
  return fmtPlainNumber(v)
}

/** One-line explanations shared by tooltips and detail views (keep wording consistent across agents). */
export const EXPLAIN = {
  spreadSpeed:
    'Spread speed: how fast the fire edge moves across the ground. Fire scientists call it the rate of spread (ROS) and measure it in chains per hour (1 chain = 66 ft = 20.1 m).',
  fireWeatherSeverity:
    'Fire weather severity is the Fosberg Fire Weather Index (FFWI, Fosberg 1978): a 0–100 score that combines wind speed, relative humidity and temperature. Higher numbers mean weather more favorable to fire spread. It describes the weather only (not fuels, terrain or the fire itself). Fire-3d computes it from weather-model data at the fire and does not sort it into categories.',
  burnProbability:
    'Burn chance is the share of the model runs (an ensemble with slightly different weather) that burned a spot by the end of the forecast period. It describes this model ensemble, not a guarantee, and it is not an official forecast.',
  arrivalQuantiles:
    'Model runs disagree about timing. P10, P50 and P90 are the times by which 10%, 50% and 90% of the runs had reached a spot. They are arrival-time quantiles, not best-case or worst-case scenarios.',
  windDirection: 'Wind directions are where the wind blows FROM (meteorological convention): "from NE" means a wind blowing toward the southwest.',
  satelliteDetection:
    'A satellite detection is a pixel where a satellite sensor saw unusual heat. It shows roughly where fire was burning at that moment, not the exact fire edge; pixels are 375 m (VIIRS) to 1 km (MODIS) or about 2 km (GOES) across.',
  experimental: 'Experimental model output, not an official forecast or evacuation instruction. Follow local officials.',
} as const

// ------------------------------------------------------------------------------------------------- physical values
/** "Spread speed" from a rate of spread in chains/hour (1 chain = 20.1168 m; 80 ch/h = 1 mph). */
export function spreadSpeed(chainsPerHour: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? 'mph' : 'km/h'
  if (!ok(chainsPerHour) || chainsPerHour < 0) return UNKNOWN(unit)
  const mPerH = chainsPerHour * CHAIN_M
  const v = units === 'us' ? mPerH / MI_M : mPerH / 1000
  return { text: `${speedNumber(v)} ${unit}`, value: v, unit, scientific: `Rate of spread (ROS) ${chainsPerHour < 10 ? NF1.format(chainsPerHour) : NF0.format(chainsPerHour)} ch/h` }
}

/** Area growth per hour: "2,741 acres per hour" / "1,109 ha per hour". */
export function growthRate(acresPerHour: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? 'acres/h' : 'ha/h'
  if (!ok(acresPerHour)) return UNKNOWN(unit)
  const v = units === 'us' ? acresPerHour : acresPerHour * HA_PER_ACRE
  return { text: `${fmtPlainNumber(v)} ${units === 'us' ? 'acres' : 'ha'} per hour`, value: v, unit, scientific: `${acresPerHour >= 0 ? '+' : ''}${NF0.format(acresPerHour)} ac/h` }
}

export function windSpeed(speedMs: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? 'mph' : 'km/h'
  if (!ok(speedMs) || speedMs < 0) return UNKNOWN(unit)
  const v = units === 'us' ? speedMs * MPH_PER_MS : speedMs * 3.6
  return { text: `${Math.round(v)} ${unit}`, value: v, unit, scientific: `${NF1.format(speedMs)} m/s` }
}

/** Meteorological FROM direction as words: "from SSW" ('' when unknown). */
export function windFrom(fromDeg: number | null | undefined): string {
  return ok(fromDeg) ? `from ${cardinal(fromDeg)}` : ''
}

/** "17 mph from SSW, gusts 26 mph" (FROM convention); scientific "7.6 m/s from 202°, gusts 11.6 m/s". */
export function windSummary(speedMs: number | null | undefined, fromDeg: number | null | undefined, gustMs: number | null | undefined, units: Units): PlainValue {
  const s = windSpeed(speedMs, units)
  if (s.value == null) return s
  const g = windSpeed(gustMs, units)
  const text = [s.text, windFrom(fromDeg)].filter(Boolean).join(' ') + (g.value != null ? `, gusts ${g.text}` : '')
  const dir = ok(fromDeg) ? ` from ${Math.round(((fromDeg % 360) + 360) % 360)}°` : ''
  return { ...s, text, scientific: `${s.scientific}${dir}${g.value != null ? `, gusts ${g.scientific}` : ''}` }
}

/** "Fire weather severity" = the Fosberg Fire Weather Index, shown as "42 of 100" with its explanation. Values above
 *  100 (possible with winds above ~30 mph in Fire-3d's uncapped computation) read "100+ of 100". */
export function fireWeatherSeverity(ffwi: number | null | undefined): PlainValue & { explanation: string } {
  const explanation = EXPLAIN.fireWeatherSeverity
  if (!ok(ffwi)) return { ...UNKNOWN('FFWI'), explanation }
  const v = Math.max(0, ffwi)
  const text = v > 100 ? '100+ of 100' : `${Math.round(v)} of 100`
  const over = v > 100 ? ' (above the top of the 0–100 scale)' : ''
  return { text, value: v, unit: 'FFWI', scientific: `Fosberg Fire Weather Index (FFWI) ${NF1.format(v)}${over}`, explanation }
}

export function temperature(c: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? '°F' : '°C'
  if (!ok(c)) return UNKNOWN(unit)
  const v = units === 'us' ? c * 1.8 + 32 : c
  return { text: `${Math.round(v)}${unit}`, value: v, unit, scientific: `${NF1.format(c)} °C` }
}

/** Distances: mi (ft below 0.1 mi) or km (m below 1 km). */
export function distance(m: number | null | undefined, units: Units): PlainValue {
  if (!ok(m) || m < 0) return UNKNOWN(units === 'us' ? 'mi' : 'km')
  const scientific = `${NF0.format(m)} m`
  if (units === 'us') {
    const mi = m / MI_M
    if (mi < 0.1) return { text: `${NF0.format(m * FT_PER_M)} ft`, value: m * FT_PER_M, unit: 'ft', scientific }
    return { text: `${mi < 10 ? NF1.format(mi) : NF0.format(mi)} mi`, value: mi, unit: 'mi', scientific }
  }
  if (m < 1000) return { text: `${NF0.format(m)} m`, value: m, unit: 'm', scientific }
  return { text: `${m < 10_000 ? NF1.format(m / 1000) : NF0.format(m / 1000)} km`, value: m / 1000, unit: 'km', scientific }
}

export function area(acres: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? 'acres' : 'ha'
  if (!ok(acres) || acres < 0) return UNKNOWN(unit)
  const v = units === 'us' ? acres : acres * HA_PER_ACRE
  const num = v < 10 ? NF1.format(v) : NF0.format(v)
  return { text: `${num} ${unit}`, value: v, unit, scientific: `${acres < 10 ? NF1.format(acres) : NF0.format(acres)} ac` }
}

export function elevation(m: number | null | undefined, units: Units): PlainValue {
  const unit = units === 'us' ? 'ft' : 'm'
  if (!ok(m)) return UNKNOWN(unit)
  const v = units === 'us' ? m * FT_PER_M : m
  return { text: `${NF0.format(v)} ${unit}`, value: v, unit, scientific: `${NF0.format(m)} m` }
}

/** Eight-point direction word ("northeast"). */
export function directionWord(deg: number): string {
  const words = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
  return words[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

const CARDINAL_WORDS: Record<string, string> = {
  N: 'north',
  NNE: 'north-northeast',
  NE: 'northeast',
  ENE: 'east-northeast',
  E: 'east',
  ESE: 'east-southeast',
  SE: 'southeast',
  SSE: 'south-southeast',
  S: 'south',
  SSW: 'south-southwest',
  SW: 'southwest',
  WSW: 'west-southwest',
  W: 'west',
  WNW: 'west-northwest',
  NW: 'northwest',
  NNW: 'north-northwest',
}

/** "ESE" -> "east-southeast" (unknown abbreviations are returned unchanged). */
export function cardinalWord(abbr: string): string {
  return CARDINAL_WORDS[abbr.toUpperCase()] ?? abbr
}

/** "12 min ago" / "in 3 h". */
export function relativeTime(ms: number, nowMs: number): string {
  return fmtRelative(ms, nowMs)
}

// ------------------------------------------------------------------------------------------------- forecasts
type ForecastPeriodInput = Pick<ForecastManifest, 'start_ms' | 'horizon_h'>

export const forecastEndMs = (f: ForecastPeriodInput): number => f.start_ms + f.horizon_h * HOUR_MS

const when = (ms: number) => `${fmtDateTime(ms)} ${tzLabel(ms)}`

/** The period a forecast covers: "Jan 8, 00:18 – Jan 11, 00:18 PST (72 h)" (both zones when DST changes inside). */
export function forecastPeriod(f: ForecastPeriodInput): string {
  const end = forecastEndMs(f)
  const z0 = tzLabel(f.start_ms)
  const z1 = tzLabel(end)
  return `${fmtDateTime(f.start_ms)}${z0 !== z1 ? ` ${z0}` : ''} – ${fmtDateTime(end)} ${z1} (${f.horizon_h} h)`
}

/** Burn probability for its real period (the whole horizon, never "next 24 h"):
 *  "12% of model runs (4 of 31) burned this spot by Jan 11, 00:18 PST (72 h after Jan 8, 00:18 PST)". */
export function burnProbabilityText(fraction: number, f: ForecastPeriodInput, members?: number): string {
  const end = forecastEndMs(f)
  const period = `by ${when(end)} (${f.horizon_h} h after ${when(f.start_ms)})`
  const n = members != null && members > 0 ? members : null
  if (!(fraction > 0)) return `None of the ${n != null ? `${n} ` : ''}model runs burned this spot ${period}`
  const pct = fraction >= 1 ? '100%' : fraction > 0.995 ? 'Over 99%' : fraction < 0.005 ? 'Under 1%' : `${Math.round(fraction * 100)}%`
  const count = n != null ? ` (${Math.round(fraction * n)} of ${n})` : ''
  return `${pct} of model runs${count} burned this spot ${period}`
}

/** "+22 h" lead time of `tMs` into the forecast, whole hours (null outside its period). */
export function forecastLead(f: ForecastPeriodInput, tMs: number): string | null {
  const end = forecastEndMs(f)
  if (tMs < f.start_ms || tMs > end) return null
  return `+${Math.round((tMs - f.start_ms) / HOUR_MS)} h`
}

/** Weather data source in words: "open-meteo:historical-forecast:gfs_hrrr" -> "Archived NOAA HRRR weather-model
 *  forecasts (via Open-Meteo)". Unknown strings come back unchanged. */
export function weatherSourceName(raw: string | null | undefined): string {
  if (!raw) return 'Weather model'
  const s = raw.trim()
  if (/fixture|synthetic/i.test(s) && !/^open-meteo:/i.test(s)) return /hrrr/i.test(s) ? 'Weather model (NOAA HRRR, simulated fixture data)' : 'Simulated weather (development fixture)'
  if (!/^open-meteo:/i.test(s)) return s
  const tokens = s.slice('open-meteo:'.length).split(/[:+\s]/).map((t) => t.toLowerCase())
  const models: string[] = []
  const add = (m: string) => {
    if (!models.includes(m)) models.push(m)
  }
  for (const t of tokens) {
    if (t === 'gfs_hrrr' || t === 'hrrr' || t === 'ncep_hrrr_conus') add('NOAA HRRR')
    else if (t.startsWith('gfs')) add('NOAA GFS')
    else if (t.startsWith('ecmwf')) add('ECMWF')
    else if (t.startsWith('era5')) add('ERA5 reanalysis')
    else if (t.startsWith('icon')) add('DWD ICON')
  }
  const archived = tokens.includes('historical-forecast')
  const list = models.length ? models.join(' + ') : 'weather'
  return `${archived ? 'Archived ' : ''}${list} ${archived ? 'weather-model forecasts' : 'weather model'} (via Open-Meteo)`
}

/** How the forecast ensemble was built, in words. */
export function ensemblePhrase(ensemble: EnsembleKind, members: number): string {
  switch (ensemble) {
    case 'gfs025':
      return `${members} model runs, each driven by a different member of NOAA's GFS weather ensemble`
    case 'ecmwf_ifs025':
      return `${members} model runs, each driven by a different member of the ECMWF weather ensemble`
    case 'perturbed':
      return `${members} model runs with small random changes to wind, humidity and temperature`
    case 'none':
      return `${members === 1 ? 'One model run' : `${members} model runs`} with a single weather series (no weather ensemble)`
    default:
      return `${members} model runs`
  }
}

export interface ForecastDescription {
  /** "Spread forecast (72 h)" / "Hindcast (72 h)". */
  title: string
  /** forecastPeriod(f). */
  period: string
  /** "Issued Oct 17, 12:07 PDT" / "Model re-run Oct 17, 2026 12:07 PDT, after the fire". */
  issued: string
  /** ensemblePhrase(...). */
  runs: string
  /** What the probabilities mean, with the period. */
  probability: string
  /** How uncertainty is expressed (arrival quantiles). */
  uncertainty: string
  /** Weather input in words. */
  weather: string
  /** Experimental / not official. */
  caveat: string
}

/** "(72 h)" -> "(72\u00a0h)": a no-break space so a number never wraps away from its unit in narrow text. */
export const keepUnits = (s: string): string => s.replace(/(\d) (h|min|days)\b/g, '$1\u00a0$2')

/** Plain description of a forecast run: period, probability, uncertainty (BRIEF §9). Historical runs are hindcasts:
 *  the model re-run for a past period, issued after the fact. */
export function forecastDescription(f: Pick<ForecastManifest, 'start_ms' | 'horizon_h' | 'issued_ms' | 'weather'>, mode: Mode): ForecastDescription {
  const end = forecastEndMs(f)
  const n = f.weather.members
  const hind = mode === 'historical'
  return {
    title: keepUnits(`${hind ? 'Hindcast' : 'Spread forecast'} (${f.horizon_h} h)`),
    period: keepUnits(forecastPeriod(f)),
    issued: hind ? `Model re-run ${fmtDateTimeYear(f.issued_ms)} ${tzLabel(f.issued_ms)}, after the fire, to compare with what happened` : `Issued ${when(f.issued_ms)}`,
    runs: ensemblePhrase(f.weather.ensemble, n),
    probability: `Chances are shares of the ${n} model runs. Inside the period the map shades where at least 10%, 50% or 90% of the runs had reached by the time shown; a spot's burn chance covers the whole period, until ${when(end)}. They describe this model ensemble, not a guarantee.`,
    uncertainty: EXPLAIN.arrivalQuantiles,
    weather: weatherSourceName(f.weather.source),
    caveat: EXPLAIN.experimental,
  }
}

export interface ModeledArea {
  /** Series time used (the hour at or before tMs). */
  tMs: number
  p10: PlainValue
  p50: PlainValue
  p90: PlainValue
  /** "About 15,200 acres (middle run); 80% of runs between 12,000 and 19,000 acres". */
  text: string
}

/** Modeled burned area at `tMs` from the forecast's hourly series (quantiles of the members' areas); null outside
 *  the series. */
export function modeledArea(f: Pick<ForecastManifest, 'series'>, tMs: number, units: Units): ModeledArea | null {
  const t = f.series.t_ms
  if (!t.length || tMs < t[0] || tMs > t[t.length - 1] + HOUR_MS) return null
  let i = 0
  while (i + 1 < t.length && t[i + 1] <= tMs) i++
  const p10 = area(f.series.area_acres_p10[i], units)
  const p50 = area(f.series.area_acres_p50[i], units)
  const p90 = area(f.series.area_acres_p90[i], units)
  if (p50.value == null) return null
  // the forecast start (and very quiet fires): every run has the same area, so there is no range to state
  const range = p10.value != null && p90.value != null ? (p10.text === p90.text ? '; the runs agree at this time' : `; 80% of runs between ${p10.text} and ${p90.text}`) : ''
  return { tMs: t[i], p10, p50, p90, text: `About ${p50.text} (middle run)${range}` }
}

// ------------------------------------------------------------------------------------------------- names
export interface PlainName {
  name: string
  explanation: string
  scientific: string
}

/** Everyday names of the Forensic lattice fields ("Activity lattice", "Slope lattice", ...). */
export const LATTICE_NAMES: Record<LatticeField, PlainName> = {
  activity: {
    name: 'Activity lattice',
    explanation: 'Grid of golden points over the analysis area. Brighter points mark places that burned recently, lie near the active fire edge, or were reached by model runs ahead of it.',
    scientific: 'Golden lattice, field "activity" (burn recency + front proximity + forecast probability)',
  },
  probability: {
    name: 'Burn-chance lattice',
    explanation: 'Grid of golden points; brighter points were burned by a larger share of the model runs during the forecast period.',
    scientific: 'Golden lattice, field "probability" (forecast burn_probability)',
  },
  elevation: { name: 'Elevation lattice', explanation: 'Grid of golden points; brighter points are higher ground.', scientific: 'Golden lattice, field "elevation"' },
  slope: { name: 'Slope lattice', explanation: 'Grid of golden points; brighter points are steeper ground.', scientific: 'Golden lattice, field "slope"' },
  canopy: { name: 'Tree-cover lattice', explanation: 'Grid of golden points; brighter points have denser tree canopy.', scientific: 'Golden lattice, field "canopy" (LANDFIRE canopy cover)' },
}

export function latticeName(field: LatticeField): string {
  return LATTICE_NAMES[field].name
}

/** Data source labels in words, e.g. "FIRMS VIIRS NOAA-21" -> "NASA FIRMS (VIIRS, NOAA-21)". Development-fixture
 *  sources keep a "(fixture)" note. Unknown strings come back unchanged. */
export function sourceName(raw: string | null | undefined): string {
  if (!raw) return 'Unknown source'
  let s = raw.trim()
  const fixture = /\(fixture\)/i.test(s)
  s = s.replace(/\s*\(fixture\)\s*/gi, ' ').trim()
  const tag = fixture ? ' (fixture)' : ''
  // weather: "<open-meteo source> (10 m gust at the fire)"
  if (/^open-meteo:/i.test(s)) return weatherSourceName(s.replace(/\s*\(.*\)\s*$/, '')) + tag
  if (/^open-meteo\b/i.test(s)) return `Weather model (${s.replace(/^open-meteo\s*/i, '') || 'Open-Meteo'}, via Open-Meteo)${tag}`
  const firms = s.match(/^FIRMS\s+(VIIRS|MODIS|GOES|LANDSAT)\s*(.*)$/i)
  if (firms) return `NASA FIRMS (${firms[1].toUpperCase()}${firms[2] ? `, ${satelliteName(firms[2].trim())}` : ''})${tag}`
  if (/^observed arrival\b/i.test(s)) {
    const what = /spread direction/i.test(s) ? 'spread direction from the reconstructed fire growth' : 'satellite detections and mapped perimeters'
    return `Fire-3d reconstruction (${what})${tag}`
  }
  if (/terrain\s*\+\s*observed arrival/i.test(s)) return `Fire-3d analysis (${/3DEP/i.test(s) ? 'USGS 3DEP terrain' : 'terrain'} + reconstructed spread)${tag}`
  if (/^CAL FIRE\s*\+\s*FIRMS GOES$/i.test(s)) return `CAL FIRE report + NASA FIRMS (GOES)${tag}`
  if (/^CAL FIRE\b/i.test(s)) return `CAL FIRE${tag}`
  if (/WFIGS/i.test(s)) return `${s.replace(/\bContainmentDateTime\b/, 'containment record')}${tag}`
  return `${s}${tag}`
}
