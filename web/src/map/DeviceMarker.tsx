// The browser's own location on the map (brief 4 locate-me, decision i-7; H3+H4 review R3). After "Use my location"
// the map flies there and this marks it: a light-blue dot (the screens' "selected point / distance" colour) with a white
// ring and a soft halo, a dashed ring when the browser's fix is coarser than 100 m, and a plain mono "YOU" label. It is
// drawn in this browser only (an SVG overlay over the map, under the chrome; aria-hidden: the locate prompt says it in
// words), never sent, and it gives way to the selected-point marker when the user checks the spot. Pointer events go
// through to the map.
import { useMemo } from 'react'
import { APPROXIMATE_OVER_M } from '../location/locate'
import { useWorkspace } from '../state/workspace'
import { useMapAnchor } from './useMapAnchor'

export function DeviceMarker() {
  const device = useWorkspace((s) => s.device)
  // the checked spot is the selected point: its own marker says it
  const checked = useWorkspace((s) => s.selection?.source === 'device' && s.device != null && s.selection.lat === s.device.lat && s.selection.lon === s.device.lon)
  const ll = useMemo(() => (device ? ([device.lon, device.lat] as const) : null), [device])
  const anchor = useMapAnchor(checked ? null : ll)
  if (!device || checked || !anchor || !anchor.inView) return null
  const approximate = device.accuracyM == null || device.accuracyM > APPROXIMATE_OVER_M
  return (
    <svg className="fxm-device" width="100%" height="100%" aria-hidden="true">
      <g transform={`translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)})`}>
        <circle r="18" className="fxm-device-halo" />
        {approximate && <circle r="26" className="fxm-device-ring" />}
        <circle r="7" className="fxm-device-dot" />
        <text x="14" y="-12" className="fxm-device-label">
          YOU
        </text>
      </g>
    </svg>
  )
}
