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

/** Open fire `id` in the Public fire view (brief 4 decision b; CONTRACT §15.3): no card, one history entry (state/history.ts
 *  pushes it, `fromOverview` when the overview was shown), the map frames the fire (state/workspace.ts drops the
 *  overview's view) and nothing is built. The fire already open is only framed again. */
export function openFireView(id: string): void {
  const ws = useWorkspace.getState()
  ws.setFireCard(null)
  const st = useStore.getState()
  if (st.incidentId === id) {
    ws.returnToIncident()
    return
  }
  void st.selectIncident(id, { source: 'card' })
}

/** The Public preset on the map opens fires directly (decision b); Command and Forensic keep the fire card. */
export function opensFireView(): boolean {
  const ws = useWorkspace.getState()
  return ws.workspace === 'map' && ws.preset === 'public'
}

/** Every way of picking a fire on the map (a list row, a marker or its label, a search result, a location card's
 *  nearest-fire row): the fire view in Public, the fire card in Command and Forensic. */
export function pickFire(id: string, row?: IncidentSummary | null): void {
  if (opensFireView()) openFireView(id)
  else showFireCard(id, row)
}
