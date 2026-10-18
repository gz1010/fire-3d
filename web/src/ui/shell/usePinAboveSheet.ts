// Phones (brief 2 C-R2): a map click selects a point and opens the location card as a bottom sheet; when the sheet
// would cover the pin, pan the map so the pin sits in the visible map above it (the safe insets from useMapSafeArea
// include the sheet, and the map centres fly-to targets inside them). Searches and pasted coordinates fly by themselves.
import { useEffect } from 'react'
import { useMapRuntime } from '../../map/mapStore'
import { useWorkspace } from '../../state/workspace'
import { pointHidden } from './layout'

/** Extra distance (px) the pin keeps from the covered edge, so its label stays visible too. */
const PIN_MARGIN_PX = 36
/** How long after a click the sheet may still appear (its size arrives with the next layout pass). */
const WATCH_MS = 1200

export function usePinAboveSheet(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    let until = 0
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    function check() {
      raf = 0
      if (performance.now() > until) return
      const ws = useWorkspace.getState()
      const sel = ws.selection
      const map = useMapRuntime.getState().map
      if (!sel || sel.source !== 'click' || !map) {
        until = 0
        return
      }
      // a flight or gesture in progress: look again once the map has settled
      if (map.isMoving()) {
        map.once('moveend', schedule)
        return
      }
      const c = map.getContainer()
      const p = map.project([sel.lon, sel.lat])
      if (!pointHidden({ x: p.x, y: p.y }, c.clientWidth, c.clientHeight, ws.safeInsets, PIN_MARGIN_PX)) return
      until = 0
      ws.requestMapFlyTo({ lon: sel.lon, lat: sel.lat, zoom: map.getZoom() })
    }
    const unsub = useWorkspace.subscribe((s, p) => {
      if (s.selection !== p.selection && s.selection?.source === 'click') {
        until = performance.now() + WATCH_MS
        schedule()
      } else if (s.safeInsets !== p.safeInsets && performance.now() <= until) schedule()
    })
    return () => {
      unsub()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [enabled])
}
