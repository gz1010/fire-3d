// The overview list's data for the current filter (owner: us-web; brief 3 §14.11, §14.14, §14.16): the rows, the
// lists' loading and failure state, the sources' health and the notices. Shared by the "Fires in the lower 48" panel
// (ui/shell/OverviewPanel.tsx) and, while that panel is not shown, the overview's banner (ui/public/ListNoticeBanner.tsx;
// brief 4 H3+H4 review R2).
import { useMemo } from 'react'
import { useNow } from '../hooks'
import { listErrorLines, listHealth, listSourceNotices, overviewFires, type OverviewFilter } from '../../state/overview'
import { useStore, type CatalogList } from '../../state/store'
import { useWorkspace } from '../../state/workspace'

/** The catalog lists behind each filter. */
export const LIST_OF: Record<OverviewFilter, CatalogList[]> = { active: ['live'], season: ['live', 'season'], past: ['historical'] }

export function useOverviewData() {
  const catalog = useStore((s) => s.catalog)
  const filter = useWorkspace((s) => s.overviewFilter)
  const nowMs = useNow(30_000)
  const rows = useMemo(() => overviewFires(catalog, filter), [catalog, filter])
  const lists = LIST_OF[filter]
  const loading = lists.some((l) => catalog.listLoading[l])
  const errors = lists.map((l) => catalog.listErrors[l]).filter((e): e is string => e != null)
  const checked = lists.map((l) => catalog.updatedMs[l]).filter((t): t is number => t != null)
  const shownSources = lists.map((l) => catalog.sources?.[l])
  const health = listHealth(shownSources)
  const notices = listSourceNotices(shownSources, nowMs)
  const errorLines = listErrorLines(lists, catalog.listErrors, catalog.updatedMs, nowMs)
  // "checked": when Fire-3d fetched the lists (sources[].retrieved_ms), never the time of the answer (panel F2)
  const checkedMs = health.fetchedMs ?? (checked.length ? Math.min(...checked) : null)
  const checkedNewestMs = health.fetchedMs != null ? health.fetchedNewestMs : checked.length ? Math.max(...checked) : null
  return { catalog, filter, rows, loading, notices, health, errorLines, nowMs, error: errors.length ? [...new Set(errors)].join('; ') : null, checkedMs, checkedNewestMs, listCount: lists.length }
}

/** The list-down and list-failure lines for the current filter (§14.14 / §14.16 wording, the same as the panel's), and
 *  a retry for a failed list. The overview shows them as a banner when the list itself is not shown (Public minimal,
 *  phones with the sheet closed; PLAN-4 §11 d "list-down banners stay visible", review R2). */
export function useListNotices(): { lines: string[]; retry: (() => void) | null } {
  const { notices, errorLines, error, filter } = useOverviewData()
  const lines = useMemo(() => [...notices, ...(error ? errorLines : [])], [notices, errorLines, error])
  return { lines, retry: error ? () => void useStore.getState().loadCatalog({ lists: LIST_OF[filter] }) : null }
}
