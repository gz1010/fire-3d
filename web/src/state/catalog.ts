// Incident lists of the main store (brief 2, I1/I2; CONTRACT §13 shell): CAL FIRE's active fires, the 2026 season and
// the 2025 list, each loaded on its own so the overview shows the first list that arrives. Pure state transitions
// (catalog.test.ts); store.ts does the fetching.
import type { IncidentListResponse, IncidentSummary, Mode } from '../api/types'
import { SEASON_YEAR } from './overview'

export type CatalogList = 'live' | 'season' | 'historical'
export const CATALOG_LISTS: readonly CatalogList[] = ['live', 'season', 'historical']

export interface CatalogState {
  /** CAL FIRE active fires (`GET /api/incidents?mode=live`). */
  live: IncidentSummary[]
  /** The 2026 season: fires of >= 300 ac whatever their status (`?mode=historical&year=2026`). */
  season: IncidentSummary[]
  /** The 2025 list, >= minAcres (`?mode=historical&year=2025`). */
  historical: IncidentSummary[]
  /** Any list is loading. */
  loading: boolean
  /** The current list errors joined (null when every list is fine). */
  error: string | null
  /** Historical (2025) acreage threshold of the loaded list (server default 300; picker toggle 100). */
  minAcres: number
  /** Server `updated_ms` of the last successful response per list. */
  updatedMs: Record<CatalogList, number | null>
  listLoading: Record<CatalogList, boolean>
  listErrors: Record<CatalogList, string | null>
}

export const EMPTY_CATALOG: CatalogState = {
  live: [],
  season: [],
  historical: [],
  loading: false,
  error: null,
  minAcres: 300,
  updatedMs: { live: null, season: null, historical: null },
  listLoading: { live: false, season: false, historical: false },
  listErrors: { live: null, season: null, historical: null },
}

/** The lists the old `modes` option meant: live -> active fires; historical -> the 2025 list (as before brief 2). */
export function listsForModes(modes: readonly Mode[]): CatalogList[] {
  const out: CatalogList[] = []
  if (modes.includes('live')) out.push('live')
  if (modes.includes('historical')) out.push('historical')
  return out
}

function aggregate(c: CatalogState): CatalogState {
  const errors = CATALOG_LISTS.map((l) => c.listErrors[l]).filter((e): e is string => e != null)
  return { ...c, loading: CATALOG_LISTS.some((l) => c.listLoading[l]), error: errors.length ? [...new Set(errors)].join('; ') : null }
}

/** Mark lists as loading (their previous rows and errors stay until the answer arrives). */
export function catalogPending(c: CatalogState, lists: readonly CatalogList[], minAcres: number): CatalogState {
  const listLoading = { ...c.listLoading }
  for (const l of lists) listLoading[l] = true
  return aggregate({ ...c, listLoading, minAcres: lists.includes('historical') ? minAcres : c.minAcres })
}

/** Apply one list's answer. Season rows from another year are dropped (a server that ignores `year=` answers 2025). */
export function catalogApply(c: CatalogState, list: CatalogList, res: Pick<IncidentListResponse, 'incidents' | 'updated_ms'>): CatalogState {
  const rows = list === 'season' ? res.incidents.filter((s) => s.year === SEASON_YEAR) : res.incidents
  return aggregate({
    ...c,
    [list]: rows,
    updatedMs: { ...c.updatedMs, [list]: res.updated_ms },
    listLoading: { ...c.listLoading, [list]: false },
    listErrors: { ...c.listErrors, [list]: null },
  })
}

/** Record a failed list (its previous rows stay, so a refresh failure does not empty the overview). */
export function catalogFail(c: CatalogState, list: CatalogList, message: string): CatalogState {
  return aggregate({ ...c, listLoading: { ...c.listLoading, [list]: false }, listErrors: { ...c.listErrors, [list]: message } })
}

/** Replace one incident's summary in every list that holds it (keeps the bundle chips fresh). */
export function catalogPatch(c: CatalogState, s: IncidentSummary): CatalogState {
  const patch = (list: IncidentSummary[]) => {
    const i = list.findIndex((x) => x.id === s.id)
    if (i < 0) return list
    const out = list.slice()
    // a detail answer has no list-only fields (bbox_lonlat): keep the list's
    out[i] = { ...list[i], ...s, bbox_lonlat: s.bbox_lonlat ?? list[i].bbox_lonlat }
    return out
  }
  return { ...c, live: patch(c.live), season: patch(c.season), historical: patch(c.historical) }
}
