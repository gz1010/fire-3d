// Showing a fire's card (brief 2 I3; brief-3 integration, CONTRACT §14.11 as built). Every way of picking a fire whose
// card should show goes through showFireCard, so they all behave the same: the overview list row and the header picker
// (ui/shell/fireActions re-exports it), a click on a fire's map marker or label (map/mapController), the search box's
// fire result (location/SearchBox) and the location card's nearest-fire rows (location/OverviewCard).
//  * The card opens, and the map flies to the fire while the map is shown (Forensic keeps its camera).
//  * A fire without a ready analysis holds the map's zoom focus (`source: 'fire-card'`, map/focus.ts FocusHold): a
//    prepared fire whose analysis area the view covers (Lower Sugarloaf next to Little Giant, WA) does not open instead
//    of the fire the user picked. A prepared fire is flown to as before, and the zoom then opens it.
//  * Another fire that is open closes first, so the header and the panels never describe a fire other than the one
//    the map shows with its card. Closing is an ordinary history step (Back returns to that fire); it happens before
//    the flight because the map releases the focus hold whenever the open fire changes.
import type { IncidentSummary } from '../api/types'
import { analysisState, findFire, fireFlyTo } from './overview'
import { useStore } from './store'
import { useWorkspace } from './workspace'

/** Open fire `id`'s card and fly the map to it. `row` is the caller's own summary of the fire (a search hit, a
 *  location card row), used when the open fire and the lists do not have it. */
export function showFireCard(id: string, row?: IncidentSummary | null): void {
  const st = useStore.getState()
  const fire = findFire(id, st.summary, st.catalog) ?? (row?.id === id ? row : null)
  const fly = fire ? fireFlyTo(fire) : null
  const onMap = useWorkspace.getState().workspace === 'map'
  const hold = fire != null && fly != null && onMap && analysisState(fire) !== 'ready'
  // another fire is open: close it, or the header, the updates and the coordinate strip keep describing it while the
  // map is at the picked fire
  if (hold && st.incidentId != null && st.incidentId !== id) st.closeIncident()
  const ws = useWorkspace.getState()
  ws.setFireCard(id)
  if (fly && onMap) ws.requestMapFlyTo(hold ? { ...fly, source: 'fire-card' } : fly)
}
