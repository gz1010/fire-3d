// The number of fires the overview map shows for the current filter (the list's "Show all N"; brief 4 decision d), for
// the "Show details" pill.
import { useMemo } from 'react'
import { overviewFires } from '../../state/overview'
import { useStore, type CatalogList } from '../../state/store'
import { useWorkspace } from '../../state/workspace'

const LISTS_OF = { active: ['live'], season: ['live', 'season'], past: ['historical'] } as const satisfies Record<string, readonly CatalogList[]>

/** The number of fires the map shows for the current filter; null until the filter's lists have answered once. */
export function useOverviewCount(): { count: number | null; loading: boolean } {
  const catalog = useStore((s) => s.catalog)
  const filter = useWorkspace((s) => s.overviewFilter)
  return useMemo(() => {
    const lists = LISTS_OF[filter]
    const loading = lists.some((l) => catalog.listLoading[l])
    const loaded = lists.some((l) => catalog.updatedMs[l] != null)
    return { count: loaded ? overviewFires(catalog, filter).length : null, loading }
  }, [catalog, filter])
}
