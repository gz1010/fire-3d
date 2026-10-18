// Jumps for official rows (owner: official-web; PLAN-2 U-R5, CONTRACT §13): fit the map to the item's official area
// and highlight it (useOfficialRuntime.highlight, drawn by mountOfficialLayers). Official rows never move the
// timeline into a forecast period: feedModel.selectFeedItem seeks only for seekable items, and official producers
// mark an item seekable only inside the observed record.
import { useWorkspace } from '../state/workspace'
import type { BBox } from './geo'
import { useOfficialRuntime } from './runtime'
import type { OfficialHighlight } from './types'

/** Fit the map (Public/Command workspace) to [w, s, e, n]; nothing happens in Forensic. The flight is marked
 *  `source: 'official'`, so the map's zoom focus (decision 10) keeps the open fire: showing a zone that touches
 *  another prepared fire (Henderson's Orange County order lies inside the Norte Fire's area) never opens that fire. */
export function fitOfficialBounds(bounds: BBox | null | undefined): void {
  if (!bounds || !bounds.every(Number.isFinite)) return
  const ws = useWorkspace.getState()
  if (ws.workspace !== 'map') return
  ws.requestMapFlyTo({ lon: (bounds[0] + bounds[2]) / 2, lat: (bounds[1] + bounds[3]) / 2, bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], source: 'official' })
}

/** Highlight an official area and fit the map to it. `toggle`: a second call with the same id clears it. Returns
 *  whether the area is highlighted afterwards. */
export function showOfficialArea(h: OfficialHighlight, bounds: BBox | null | undefined, opts: { toggle?: boolean } = {}): boolean {
  const rt = useOfficialRuntime.getState()
  if (opts.toggle && rt.highlight?.id === h.id) {
    rt.setHighlight(null)
    return false
  }
  rt.setHighlight(h)
  fitOfficialBounds(bounds)
  return true
}

export function clearOfficialHighlight(): void {
  useOfficialRuntime.getState().setHighlight(null)
}
