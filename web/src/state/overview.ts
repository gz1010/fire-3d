// The national overview (brief 2, decision 1; brief 3, CONTRACT §14.11): which fires the overview list and the map's
// overview markers show, how a fire's agency status reads, where a click on a fire flies, and the list's "in this view"
// counts. Pure (overview.test.ts). The overview is the map workspace with no incident open (useStore.incidentId ===
// null). Every value shown here is an agency's official record (CAL FIRE in California, NIFC WFIGS elsewhere);
// nothing in the overview is model output, and a place without a marker is never an all-clear.
import type { IncidentSummary, ListSource } from '../api/types'
import type { LonLatBox } from '../lib/fireBounds'
import { fmtRelative } from '../lib/time'
import type { CatalogList } from './catalog'
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
/** CONTRACT §14.16: both source lists down. The server lists only the fires prepared on it (from their saved records). */
export const ALL_LISTS_DOWN =
  'The fire lists (CAL FIRE and NIFC) could not be reached right now. Only fires prepared on this server are listed, with their records as saved when each was prepared. Not an all-clear: follow local officials.'
/** The phone peek's short form of ALL_LISTS_DOWN. */
export const ALL_LISTS_DOWN_SHORT = 'Fire lists unavailable right now'
/** §14.16: a list that could not be refreshed, served from an older copy (relative time: the rows span many zones). */
export function staleListText(id: ListSource['id'], retrievedMs: number | null, nowMs: number): string {
  const who = id === 'wfigs' ? 'The national fire list (NIFC)' : "CAL FIRE's list"
  const copy = retrievedMs != null ? `the copy fetched ${fmtRelative(retrievedMs, nowMs)}` : 'an older copy'
  return `${who} could not be refreshed right now; showing ${copy}. Newer fires may be missing.`
}
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

/** Number of active fires (the phone peek line "N active fires · newest record 5 min old"). */
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

/** The fire card's "Analysis ready: …" (validation review W-m8): the experimental model is named only when the open
 *  bundle holds a model run (`modelRuns` > 0); a bundle without one (the test fires, Eaton) says so; a fire that is not
 *  open (`modelRuns` null) names only what every prepared bundle holds. */
export function analysisReadyText(modelRuns: number | null): string {
  if (modelRuns == null) return 'Analysis ready: spread reconstruction'
  return modelRuns > 0 ? 'Analysis ready: spread reconstruction and the experimental model' : 'Analysis ready: spread reconstruction (no model run yet)'
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

/** W11: above this many rows the overview list renders only the rows near the visible part of its scroller. */
export const LIST_WINDOW_MIN = 150
/** Rows rendered above and below the visible ones (keyboard steps and fast scrolls stay smooth). */
export const LIST_OVERSCAN = 10

/** The rows [start, end) a windowed list renders: the rows between `scrollTop` and `scrollTop + viewH` (px, in the
 *  list's own coordinates) plus the overscan. Lists of LIST_WINDOW_MIN rows or fewer render every row. */
export function listWindow(n: number, scrollTop: number, viewH: number, rowH: number, overscan = LIST_OVERSCAN): { start: number; end: number } {
  if (n <= LIST_WINDOW_MIN) return { start: 0, end: n }
  const h = Math.max(1, rowH)
  const y = Math.max(0, scrollTop)
  const start = Math.max(0, Math.min(n, Math.floor(y / h) - overscan))
  const end = Math.max(start, Math.min(n, Math.ceil((y + Math.max(0, viewH)) / h) + overscan))
  return { start, end }
}

/** The scroll position (list coordinates) that shows row `i` whole: unchanged when it already shows, else the
 *  nearest edge (a keyboard step scrolls by one row, Home and End jump). */
export function scrollToRow(i: number, rowH: number, scrollTop: number, viewH: number): number {
  const top = i * rowH
  const bottom = top + rowH
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewH) return Math.max(0, bottom - viewH)
  return scrollTop
}

/** How the source lists behind the shown lists answered (CONTRACT §14.1 sources[], §14.16). */
export interface ListHealth {
  /** Every source of every list that reported its sources is unavailable: the server lists only prepared fires. */
  allDown: boolean
  /** Sources reported unavailable (deduplicated over the lists). */
  down: Set<ListSource['id']>
  /** Sources served from an older copy that could not be refreshed, with that copy's fetch time (the oldest). */
  stale: Map<ListSource['id'], number | null>
  /** When Fire-3d fetched the lists shown: the oldest `retrieved_ms` of the available sources (null: not reported). */
  fetchedMs: number | null
  /** The newest of those `retrieved_ms` (several lists may have been fetched at different times). */
  fetchedNewestMs: number | null
}

export function listHealth(sources: readonly (readonly ListSource[] | null | undefined)[]): ListHealth {
  const down = new Set<ListSource['id']>()
  const stale = new Map<ListSource['id'], number | null>()
  let reported = 0
  let allDown = true
  let fetchedMs: number | null = null
  let fetchedNewestMs: number | null = null
  for (const list of sources) {
    if (!list?.length) continue
    reported += 1
    for (const src of list) {
      if (src.status === 'unavailable') {
        down.add(src.id)
        continue
      }
      allDown = false
      if (src.retrieved_ms != null) {
        fetchedMs = fetchedMs == null ? src.retrieved_ms : Math.min(fetchedMs, src.retrieved_ms)
        fetchedNewestMs = fetchedNewestMs == null ? src.retrieved_ms : Math.max(fetchedNewestMs, src.retrieved_ms)
      }
      if (src.stale) {
        const prev = stale.get(src.id)
        const t = src.retrieved_ms ?? null
        stale.set(src.id, prev == null ? t : t == null ? prev : Math.min(prev, t))
      }
    }
  }
  return { allDown: reported > 0 && allDown, down, stale, fetchedMs, fetchedNewestMs }
}

/** "newest record 10 min old" (final fixes R7): the newest agency time inside the list, said as an age, so it never
 *  reads as an update newer than Fire-3d's last check ("updated 10 min ago · checked 30 min ago" did). */
export function newestRecordText(newestMs: number, nowMs: number): string {
  const r = fmtRelative(newestMs, nowMs)
  return `newest record ${r.endsWith(' ago') ? `${r.slice(0, -4)} old` : 'under a minute old'}`
}

/** When Fire-3d fetched the list(s) shown (final fixes R7): "list checked 30 min ago"; sources fetched at different
 *  times "lists checked in the last 30 min", or "sources checked in the last 8 min" for one list built from two
 *  sources (the Active list: CAL FIRE and NIFC WFIGS are kept for different times), since the oldest fetch bounds them
 *  all and a single "checked" time would read as older than the newest record; a copy that could not be refreshed
 *  "copy fetched 47 min ago" (panel F2). */
export function listCheckedText(oldestMs: number, newestMs: number | null, nowMs: number, opts: { lists: number; stale: boolean }): string {
  const r = fmtRelative(oldestMs, nowMs)
  if (opts.stale) return `copy fetched ${r}`
  const spread = newestMs != null && newestMs - oldestMs >= 60_000 && r.endsWith(' ago')
  if (!spread) return `${opts.lists <= 1 ? 'list' : 'lists'} checked ${r}`
  return `${opts.lists <= 1 ? 'sources' : 'lists'} checked in the last ${r.slice(0, -4)}`
}

/** The notices for the lists shown: both sources down (one notice, ALL_LISTS_DOWN); else the §14.14 notice per source
 *  reported unavailable, then a §14.16 notice per source served from an older copy. */
export function listSourceNotices(sources: readonly (readonly ListSource[] | null | undefined)[], nowMs: number = Date.now()): string[] {
  const h = listHealth(sources)
  if (h.allDown) return [ALL_LISTS_DOWN]
  const out: string[] = []
  if (h.down.has('wfigs')) out.push(NIFC_LIST_DOWN)
  if (h.down.has('calfire')) out.push(CALFIRE_LIST_DOWN)
  for (const id of ['wfigs', 'calfire'] as const) if (h.stale.has(id) && !h.down.has(id)) out.push(staleListText(id, h.stale.get(id) ?? null, nowMs))
  return out
}

/** Each list's name in a failure line ("Could not load the 2026 list: …"). */
const LIST_NAME: Record<CatalogList, string> = { live: 'the active fires', season: `the ${SEASON_YEAR} list`, historical: `the ${PAST_YEAR} list` }

/** The failure lines of the lists shown: a list that never loaded says "Could not load", one with an earlier copy says
 *  how old that copy is (never "Showing the last list" when there was none; final verification, panel SR-M2). */
export function listErrorLines(lists: readonly CatalogList[], errors: Record<CatalogList, string | null>, updatedMs: Record<CatalogList, number | null>, nowMs: number): string[] {
  const out: string[] = []
  for (const l of lists) {
    const e = errors[l]
    if (e == null) continue
    const t = updatedMs[l]
    out.push(t == null ? `Could not load ${LIST_NAME[l]}: ${e}.` : `Could not refresh ${LIST_NAME[l]}: ${e}. Showing the copy loaded ${fmtRelative(t, nowMs)}.`)
  }
  return out
}

/** Forensic's banner when no active fire is listed and a replay is open: the replay's own year, and never "no active
 *  fires" when a list could not be reached (§14.16). */
export function noLiveText(health: Pick<ListHealth, 'allDown' | 'down'>, replayYear: number | null): string {
  const replay = replayYear != null ? `showing a ${replayYear} replay` : 'showing a replay'
  if (health.allDown) return `The fire lists (CAL FIRE and NIFC) could not be reached right now · ${replay}`
  if (health.down.size) return `Some fire lists are unavailable right now; the others list no active fires · ${replay}`
  return `No active fires listed by CAL FIRE or NIFC right now · ${replay}`
}

/** The overview filter's empty text when no fire at all is listed (the in-view empty text is EMPTY_VIEW). */
export function emptyListText(filter: OverviewFilter, minAcres: number, health?: Pick<ListHealth, 'allDown' | 'down'>): string {
  // a source that could not be reached never "lists no fires" (§14.16)
  if (health?.allDown) return 'No fires prepared on this server to show while the fire lists are unavailable.'
  if (health?.down.size) return 'No fires listed by the lists that could be reached; the others are unavailable right now.'
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

/** Settings → Service: the live count, or "unknown" when the fire lists could not be reached (never 0; §14.16). */
export function activeCountText(n: number | null | undefined): string {
  if (n == null) return 'unknown (fire lists unavailable)'
  return `${n.toLocaleString('en-US')} incident${n === 1 ? '' : 's'}`
}
