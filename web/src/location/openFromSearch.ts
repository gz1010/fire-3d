// Opening a fire from the location tools (owner: location; brief 2 decision 10, CONTRACT §13 shell). An explicit open:
// the map frames it and history gets a step (incidentSource 'search'); never a build.
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'

export function openFromSearch(id: string): void {
  useWorkspace.getState().setFireCard(null)
  void useStore.getState().selectIncident(id, { source: 'search' })
}
