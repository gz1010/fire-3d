// Optional-source layers on the Public/Command map (CONTRACT §12.3 item 2): recent satellite imagery, official
// evacuation zones and public cameras, mounted once per map by MapController and removed before map.remove(). Data
// and choices come from useExtrasRuntime (extras/runtime.ts), visibility from the workspace layer toggles. The handles
// re-add themselves after every basemap swap, after map-core has re-added its own layers (their style.load listeners
// are registered later). Stacking: imagery < zones < map-core's draped fire layers < labels < official wording and
// camera icons < map-core's top layers (incident, events, selection).
import type { Map as MapLibreMap } from 'maplibre-gl'
import { CAMERA_INTERACTIVE_LAYERS, mountCameraLayer } from '../extras/cameras'
import { EVAC_LAYERS, mountEvacuationLayer } from '../extras/evacuation'
import { mountImageryLayer } from '../extras/imagery'
import { useExtrasRuntime } from '../extras/runtime'
import { useWorkspace } from '../state/workspace'
import { drapedLayers, topLayers } from './layers'

/** Layers a hover or click may hit: camera icons (open the camera) and the zones' fill (official wording). */
export const EXTRAS_HOVER_LAYERS: { cameras: readonly string[]; zones: readonly string[] } = { cameras: CAMERA_INTERACTIVE_LAYERS, zones: [EVAC_LAYERS.tint] }

export interface ExtrasLayers {
  destroy(): void
}

export function bindExtrasLayers(map: MapLibreMap): ExtrasLayers {
  const draped = drapedLayers().map((l) => l.id)
  const top = topLayers().map((l) => l.id)
  const layers = useWorkspace.getState().mapLayers
  const rt = useExtrasRuntime.getState()
  // imagery goes below the zones when they exist (a later product change re-adds it there), else below the fire layers
  const img = mountImageryLayer(map, { beforeId: [EVAC_LAYERS.tint, ...draped], visible: layers.recentImagery, opacity: rt.opacity })
  const evac = mountEvacuationLayer(map, { beforeId: draped, topBeforeId: top, visible: layers.evacuation })
  const cams = mountCameraLayer(map, {
    topBeforeId: top,
    visible: layers.cameras,
    // a camera icon opens its entry (with "Show latest image") in the Layers panel
    onSelect: (id) => {
      useExtrasRuntime.getState().setCameraId(id)
      useWorkspace.getState().setPanel('layers', true)
    },
  })
  const push = () => {
    const s = useExtrasRuntime.getState()
    const l = useWorkspace.getState().mapLayers
    evac.setData(l.evacuation ? s.evac.data : null)
    cams.setData(l.cameras ? s.cams.data : null)
    img.setProduct(l.recentImagery ? s.product : null)
  }
  push()
  cams.setSelected(rt.cameraId)
  const unsubs = [
    useExtrasRuntime.subscribe((s, p) => {
      if (s.evac.data !== p.evac.data || s.cams.data !== p.cams.data || s.product !== p.product) push()
      if (s.cameraId !== p.cameraId) cams.setSelected(s.cameraId)
      if (s.opacity !== p.opacity) img.setOpacity(s.opacity)
    }),
    useWorkspace.subscribe((s, p) => {
      const a = s.mapLayers
      const b = p.mapLayers
      if (a === b) return
      if (a.evacuation !== b.evacuation) evac.setVisible(a.evacuation)
      if (a.cameras !== b.cameras) cams.setVisible(a.cameras)
      if (a.recentImagery !== b.recentImagery) img.setVisible(a.recentImagery)
      if (a.evacuation !== b.evacuation || a.cameras !== b.cameras || a.recentImagery !== b.recentImagery) push()
    }),
  ]
  return {
    destroy() {
      for (const u of unsubs) u()
      cams.remove()
      evac.remove()
      img.remove()
    },
  }
}
