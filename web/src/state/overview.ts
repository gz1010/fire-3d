// The national overview (brief 2, decision 1; brief 3, CONTRACT §14.11): which fires the overview list and the map's
// overview markers show, how a fire's agency status reads, where a click on a fire flies, and the list's "in this view"
// counts. Pure (overview.test.ts). The overview is the map workspace with no incident open (useStore.incidentId ===
// null). Every value shown here is an agency's official record (CAL FIRE in California, NIFC WFIGS elsewhere);
// nothing in the overview is model output, and a place without a marker is never an all-clear.
import type { IncidentSummary, ListSource } from '../api/types'
import type { LonLatBox } from '../lib/fireBounds'
import { stateName } from '../lib/usStates'
import type { MapFlyTo } from './workspace'

/** "This year's large fires" (PLAN-2 defaults): the 2026 season, with 2025 behind a filter. */
export const SEASON_YEAR = 2026
export const PAST_YEAR = 2025
/** Size threshold of the season list (fires of at least this many acres, whatever their status). */
export const SEASON_MIN_ACRES = 300

export type OverviewFilter = 'active' | 'season' | 'past'

export const OVERVIEW_FILTERS: { value: OverviewFilter; label: string; tip: string }[] = [
  { value: 'active', label: 'Active', tip: 'Every fire CAL FIRE or NIFC lists as active right now, whatever its size' },
  { value: 'season', label: `${SEASON_YEAR} season`, tip: `Active fires and ${SEASON_YEAR} fires of ${SEASON_MIN_ACRES} acres or more` },
  { value: 'past', label: String(PAST_YEAR), tip: `${PAST_YEAR} fires of ${SEASON_MIN_ACRES} acres or more (100 with the picker's switch)` },
]

/** CONTRACT §14.14 list absence: the legend, the list footer and the empty view; the phone peek has the short form. */
export const LIST_ABSENCE = 'Only fires reported to CAL FIRE or NIFC are listed; a place with no marker is not an all-clear. Follow local officials.'
export const LIST_ABSENCE_SHORT = 'Only reported fires are listed · not an all-clear'
/** CONTRACT §14.14: a list source is down. */
export const NIFC_LIST_DOWN = 'The national fire list (NIFC) is unavailable right now; only California fires (CAL FIRE) are listed.'
export const CALFIRE_LIST_DOWN = "CAL FIRE's list is unavailable right now; California fires are listed from NIFC WFIGS."
/** The empty view (§14.11): never "no fires". */
export const EMPTY_VIEW = 'No listed fires in this view.'

export interface OverviewCatalog {
  live: readonly IncidentSummary[]
  season: readonly IncidentSummary[]
  historical: readonly IncidentSummary[]
}

/** An agency lists the fire as active (the live list holds only active fires). */
export function isActiveFire(s: Pick<IncidentSummary, 'mode' | 'is_active'>): boolean {
  return s.mode === 'live' || s.is_active
}

const byAcres = (a: IncidentSummary, b: IncidentSummary) =>
  (b.acres ?? -1) - (a.acres ?? -1) || b.started_ms - a.started_ms || a.name.localeCompare(b.name)

/** The fires one overview filter shows, deduplicated by id (a live row wins over the season row of the same fire);
 *  active fires first in the season view, each group by acres (largest first). */
export function overviewFires(catalog: OverviewCatalog, filter: OverviewFilter): IncidentSummary[] {
  if (filter === 'past') return [...catalog.historical].sort(byAcres)
  if (filter === 'active') return [...catalog.live].sort(byAcres)
  const seen = new Set<string>()
  const out: IncidentSummary[] = []
  for (const s of [...catalog.live, ...catalog.season]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out.sort((a, b) => Number(isActiveFire(b)) - Number(isActiveFire(a)) || byAcres(a, b))
}

/** Newest record update among the rows: the agencies' own times, not when Fire-3d fetched the list (the list's
 *  `updated_ms` is Fire-3d's check time). */
export function newestRecordMs(rows: readonly Pick<IncidentSummary, 'updated_ms'>[]): number | null {
  let best: number | null = null
  for (const r of rows) if (r.updated_ms != null && Number.isFinite(r.updated_ms) && (best == null || r.updated_ms > best)) best = r.updated_ms
  return best
}

/** Every prepared fire in the three lists, whatever the overview filter (decision 10: the map may focus any of them by
 *  zoom): rows with a ready analysis and its area (`bbox_lonlat`), deduplicated by id (the live row wins). The lists
 *  stay loaded at all times; the filter changes only the overview markers and the panel list. */
export function preparedFires(catalog: OverviewCatalog): IncidentSummary[] {
  const seen = new Set<string>()
  const out: IncidentSummary[] = []
  for (const s of [...catalog.live, ...catalog.season, ...catalog.historical]) {
    if (seen.has(s.id) || s.bundle_status !== 'ready' || !s.bbox_lonlat) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

/** Number of active fires (the phone peek line "N active fires · records updated 5 min ago"). */
export function activeCount(catalog: Pick<OverviewCatalog, 'live'>): number {
  return catalog.live.length
}

/** A fire by id: the open fire's summary first (freshest), then the live, season and 2025 lists. */
export function findFire(id: string | null | undefined, summary: IncidentSummary | null, catalog: OverviewCatalog): IncidentSummary | null {
  if (!id) return null
  if (summary?.id === id) return summary
  return catalog.live.find((s) => s.id === id) ?? catalog.season.find((s) => s.id === id) ?? catalog.historical.find((s) => s.id === id) ?? null
}

export type FireStatusKey = 'active' | 'contained' | 'out'

/** The agency's status in plain words (the record's own flags; never inferred from model output). */
export function fireStatus(s: Pick<IncidentSummary, 'mode' | 'is_active' | 'percent_contained' | 'contained_ms'>): { key: FireStatusKey; label: string } {
  if (s.mode === 'live' && s.is_active) return { key: 'active', label: 'Active' }
  if ((s.percent_contained ?? 0) >= 100 || s.contained_ms != null) return { key: 'contained', label: 'Contained' }
  return s.is_active ? { key: 'active', label: 'Active' } : { key: 'out', label: 'Out' }
}

export type AnalysisState = 'ready' | 'building' | 'error' | 'none'

/** Whether Fire-3d's analysis (the incident bundle) exists for a fire. */
export function analysisState(s: Pick<IncidentSummary, 'bundle_status'>): AnalysisState {
  return s.bundle_status === 'ready' || s.bundle_status === 'building' || s.bundle_status === 'error' ? s.bundle_status : 'none'
}

const M_PER_DEG_LAT = 111_320
const ACRE_M2 = 4046.8564224
/** Smallest half-width of a fire's fly-to box (m). */
export const FIRE_VIEW_MIN_M = 3000

/** Half-width (m) of the view around a fire without a known area: 2.5x the radius of a circle of its acreage, at
 *  least 3 km (opening-map audit R2). */
export function fireViewRadiusM(acres: number | null | undefined): number {
  const a = typeof acres === 'number' && Number.isFinite(acres) && acres > 0 ? acres : 0
  return Math.max(FIRE_VIEW_MIN_M, 2.5 * Math.sqrt((a * ACRE_M2) / Math.PI))
}

const validLonLat = (lon: number, lat: number) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180

/** Where a click on a fire (list row or marker) flies: the built bundle's area when the row has one, else a box
 *  around the agency's reported point sized by the acreage. */
export function fireFlyTo(s: Pick<IncidentSummary, 'lat' | 'lon' | 'acres' | 'bbox_lonlat'>): Omit<MapFlyTo, 'nonce'> | null {
  const b = s.bbox_lonlat
  if (b && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] && validLonLat(b[0], b[1]) && validLonLat(b[2], b[3]))
    return { lon: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2, bounds: [b[0], b[1], b[2], b[3]] }
  if (!validLonLat(s.lon, s.lat)) return null
  const r = fireViewRadiusM(s.acres)
  const dLat = r / M_PER_DEG_LAT
  const dLon = r / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((s.lat * Math.PI) / 180)))
  return { lon: s.lon, lat: s.lat, bounds: [s.lon - dLon, s.lat - dLat, s.lon + dLon, s.lat + dLat] }
}

// ------------------------------------------------------------------------------------------------- brief 3 (§14.11)
/** County words: "Garfield Co.", Louisiana "Calcasieu Parish"; names that already say what they are stay verbatim. */
export function countyWords(county: string, state: string | null | undefined): string {
  const c = county.trim()
  if (/\b(county|parish|borough|census area|municipality|city)\b/i.test(c)) return c
  return state === 'LA' ? `${c} Parish` : `${c} Co.`
}

/** Where a fire is, for rows, cards, hovers and the picker: "Garfield Co., CO"; without a county the record's
 *  location or unit, then the state ("CO"). */
export function fireWhere(s: Pick<IncidentSummary, 'county' | 'location' | 'admin_unit'> & { state?: string | null }): string {
  const st = s.state?.trim() || null
  const place = s.county?.trim() ? countyWords(s.county, st) : (s.location?.trim() || s.admin_unit?.trim() || '')
  if (!place) return st ?? ''
  return st && !new RegExp(`(,|\\s)${st}$`).test(place) ? `${place}, ${st}` : place
}

/** Is the fire's reported point inside a lon/lat box ([w, s, e, n]; a box crossing the antimeridian has w > e)? */
export function inBox(s: Pick<IncidentSummary, 'lon' | 'lat'>, box: LonLatBox): boolean {
  if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) return false
  const [w, so, e, n] = box
  if (s.lat < so || s.lat > n) return false
  return w <= e ? s.lon >= w && s.lon <= e : s.lon >= w || s.lon <= e
}

/** The rows whose point is inside the map view (the list "in this view"); every row when there is no view yet. */
export function firesInView<T extends Pick<IncidentSummary, 'lon' | 'lat'>>(rows: readonly T[], view: LonLatBox | null): T[] {
  return view ? rows.filter((r) => inBox(r, view)) : [...rows]
}

/** "312 fires in this view · Show all 1,334" (the counts of §14.11). */
export function inViewLabel(inView: number, total: number): { inView: string; all: string } {
  return { inView: `${inView.toLocaleString('en-US')} fire${inView === 1 ? '' : 's'} in this view`, all: `Show all ${total.toLocaleString('en-US')}` }
}

/** The §14.14 notices for list sources reported unavailable (deduplicated over the lists shown). */
export function listSourceNotices(sources: readonly (readonly ListSource[] | null | undefined)[]): string[] {
  const down = new Set<string>()
  for (const list of sources) for (const src of list ?? []) if (src.status === 'unavailable') down.add(src.id)
  const out: string[] = []
  if (down.has('wfigs')) out.push(NIFC_LIST_DOWN)
  if (down.has('calfire')) out.push(CALFIRE_LIST_DOWN)
  return out
}

/** The overview filter's empty text when no fire at all is listed (the in-view empty text is EMPTY_VIEW). */
export function emptyListText(filter: OverviewFilter, minAcres: number): string {
  if (filter === 'active') return 'CAL FIRE and NIFC list no active fires right now.'
  if (filter === 'season') return `CAL FIRE and NIFC list no active fires and no ${SEASON_YEAR} fires of ${SEASON_MIN_ACRES} acres or more.`
  return `No ${PAST_YEAR} fires of ${minAcres} acres or more are listed.`
}

/** The overview counts per filter (memoised by the caller on the catalog lists). */
export function overviewCounts(catalog: OverviewCatalog): Record<OverviewFilter, number> {
  return { active: overviewFires(catalog, 'active').length, season: overviewFires(catalog, 'season').length, past: catalog.historical.length }
}

/** A picker row's place: "Los Angeles Co., CA · Altadena", "Garfield Co., CO", or '—'. */
export function pickerWhere(s: IncidentSummary): string {
  const where = fireWhere(s)
  return (s.county?.trim() && s.location?.trim() ? `${where} · ${s.location.trim()}` : where) || '—'
}

/** Does a row match a search (lowercase)? Name (and the record's own name), county, place, unit, id, the state code
 *  and its name ("idaho", "id"), and the "Garfield Co., CO" line. */
export function pickerMatches(s: IncidentSummary, q: string): boolean {
  if (!q) return true
  const st = s.state ?? null
  const words = [s.name, s.source_name, s.county, s.location, s.admin_unit, s.id, st, stateName(st), fireWhere(s)]
  return words.some((v) => v?.toLowerCase().includes(q))
}
