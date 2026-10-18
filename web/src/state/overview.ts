// The California overview (brief 2, decision 1; CONTRACT §13 shell): which fires the overview list and the map's
// overview markers show, how a fire's CAL FIRE status reads, and where a click on a fire flies. Pure (overview.test.ts).
// The overview is the map workspace with no incident open (useStore.incidentId === null). Every value shown here is
// CAL FIRE's official record; nothing in the overview is model output.
import type { IncidentSummary } from '../api/types'
import type { MapFlyTo } from './workspace'

/** "This year's large fires" (PLAN-2 defaults): the 2026 season, with 2025 behind a filter. */
export const SEASON_YEAR = 2026
export const PAST_YEAR = 2025
/** Size threshold of the season list (CAL FIRE fires of at least this many acres, whatever their status). */
export const SEASON_MIN_ACRES = 300

export type OverviewFilter = 'active' | 'season' | 'past'

export const OVERVIEW_FILTERS: { value: OverviewFilter; label: string; tip: string }[] = [
  { value: 'active', label: 'Active', tip: 'Fires CAL FIRE lists as active right now' },
  { value: 'season', label: `${SEASON_YEAR} season`, tip: `Active fires and ${SEASON_YEAR} fires of ${SEASON_MIN_ACRES} acres or more` },
  { value: 'past', label: String(PAST_YEAR), tip: `${PAST_YEAR} fires of ${SEASON_MIN_ACRES} acres or more (100 with the picker's switch)` },
]

export interface OverviewCatalog {
  live: readonly IncidentSummary[]
  season: readonly IncidentSummary[]
  historical: readonly IncidentSummary[]
}

/** CAL FIRE lists the fire as active (the live list holds only active fires). */
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

/** Newest CAL FIRE record update among the rows: CAL FIRE's own time, not when Fire-3d fetched the list (the list's
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

/** Number of active fires (the phone peek line "N active fires · CAL FIRE, updated hh:mm"). */
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

/** CAL FIRE's status in plain words (the record's own flags; never inferred from model output). */
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
 *  around CAL FIRE's reported point sized by the acreage. */
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
