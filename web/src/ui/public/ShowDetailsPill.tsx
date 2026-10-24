// "Show details" (brief 4, Main.dc.html; PLAN-4 decision d): the Public overview opens minimal (bar, search + locate,
// the compact controls, the disclaimer, the credits and this pill). The pill shows or hides the details: the map
// controls bar, the "Fires in the lower 48" panel, the overview readout, the scale bar and the legend
// (useWorkspace.overviewDetails). Its count is the number of fires the map shows for the current filter (the list's
// "Show all N"); a spinner while the lists load. On phones it opens and closes the fire list sheet instead
// (panels.updates; decision h). The Command overview always shows its details and has no pill.
import { Layers } from 'lucide-react'
import { useWorkspace } from '../../state/workspace'
import { Spinner } from '../controls'
import { detailsPillLabel } from './overviewText'
import { useOverviewCount } from './useOverviewCount'

export function ShowDetailsPill({ sheet = false }: { sheet?: boolean }) {
  const details = useWorkspace((s) => s.overviewDetails)
  const listOpen = useWorkspace((s) => s.panels.updates)
  const { count, loading } = useOverviewCount()
  // phones: the pill is the list sheet's toggle
  const open = sheet ? listOpen : details
  const label = detailsPillLabel(open, count)
  return (
    <button
      type="button"
      className={`ovw-pill${open ? ' is-open' : ''}`}
      aria-expanded={open}
      aria-label={label.aria}
      data-panel-toggle={sheet ? 'updates' : undefined}
      onClick={() => {
        const ws = useWorkspace.getState()
        if (sheet) ws.setPanel('updates', !open)
        else {
          ws.setOverviewDetails(!open)
          // the list is part of the details: showing them shows it
          if (!open && !ws.panels.updates) ws.setPanel('updates', true)
        }
      }}
    >
      <Layers size={18} aria-hidden="true" className="ovw-pill-icon" />
      <span className="ovw-pill-text">{label.text}</span>
      <span className="ovw-pill-count mw-mono" aria-hidden="true">
        {count == null ? <Spinner size={10} /> : count.toLocaleString('en-US')}
        {count != null && loading && <Spinner size={9} />}
      </span>
    </button>
  )
}
