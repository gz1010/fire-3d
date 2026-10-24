// The overview top bar's right side (brief 4, Main.dc.html; PLAN-4 §3.3, decision i-4): the viewer's local date and
// the number of active fires the agencies list ("OCT 24 2026 · 203 ACTIVE"), mono capitals with the count in fire
// orange. Its tooltip says whose list it is and that a place with no marker is not an all-clear.
import { useShallow } from 'zustand/react/shallow'
import { listHealth } from '../../state/overview'
import { useStore } from '../../state/store'
import { useNow } from '../hooks'
import { ACTIVE_COUNT_TIP, activeCountPart, barDate } from './overviewText'

export function OverviewStatus() {
  const nowMs = useNow(60_000)
  const live = useStore(
    useShallow((s) => ({
      count: s.catalog.live.length,
      loaded: s.catalog.updatedMs.live != null,
      loading: s.catalog.listLoading.live,
      failed: s.catalog.listErrors.live != null,
      sources: s.catalog.sources?.live ?? null,
    })),
  )
  const part = activeCountPart({ ...live, allDown: listHealth([live.sources]).allDown })
  return (
    <span className="ovw-status" data-tip={ACTIVE_COUNT_TIP}>
      <span className="ovw-status-date">{barDate(nowMs)}</span>
      <span className="ovw-status-sep" aria-hidden="true">
        {' · '}
      </span>
      <span className={`ovw-status-count is-${part.tone}`}>{part.text}</span>
      <span className="mw-sr-only">. {ACTIVE_COUNT_TIP}</span>
    </span>
  )
}
