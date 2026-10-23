// Test helper (brief 3, CONTRACT §14.9): pure helpers without an explicit TimeFmt use `getTimeFormat()` (the open
// fire's zone, else the selected place's, else the viewer's, with the workspace's clock). Tests that check the brief-2
// California strings set the clock of a California place in Command (24-hour, Pacific) once, here, instead of relying
// on the test machine's zone.
import { usePlaceZone } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'

export function setCaliforniaCommandClock(): void {
  usePlaceZone.getState().setPlaceZone('America/Los_Angeles') // tz-ok: these tests check California strings
  useWorkspace.setState({ workspace: 'map', preset: 'command' })
}
