// Workspace switching with a preserved geographic view centre (owner: shell, CONTRACT §3).
// Incident, data context, forecast run, timeline time and selection live in stores that both workspaces share, so
// only the camera needs a hand-off: map -> Forensic sets the existing store.flyTo (local x/z, read by CameraRig when
// it mounts); Forensic -> map writes useWorkspace.view from the Forensic camera before the map mounts.
// lib/reproject is the map-side home of the UTM helpers (map-core may make it three.js-free)
import { localToLonLat, lonLatToLocal } from '../../lib/reproject'
import { useSceneStore } from '../../scene/sceneStore'
import { useStore } from '../../state/store'
import { useWorkspace, type Workspace } from '../../state/workspace'

/** MapLibre ground resolution (512 px world at zoom 0): metres per CSS pixel at `zoom` and latitude. */
export function metersPerPixel(zoom: number, lat: number): number {
  return (78271.51696402048 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/** Inverse of metersPerPixel. */
export function zoomForMetersPerPixel(mpp: number, lat: number): number {
  return Math.log2((78271.51696402048 * Math.cos((lat * Math.PI) / 180)) / Math.max(1e-6, mpp))
}

/** Forensic orbit distance showing the same ground resolution (CameraRig fov 35 deg). */
export function forensicDistance(mpp: number, viewportHeightPx: number, fovDeg = 35): number {
  return (mpp * viewportHeightPx) / (2 * Math.tan(((fovDeg * Math.PI) / 180) / 2))
}

/** store.flyTo for the Forensic camera. CameraRig applies it on mount when the incident's assets are cached; on a
 *  first visit it frames the fire once the assets arrive, so the request is repeated right after that. */
function flyForensic(incidentId: string, x: number, z: number, distance: number): void {
  useStore.getState().flyToLocal(x, z, distance)
  void import('../../scene/assets').then(({ assetStore }) => {
    if (assetStore.getState().assets?.manifest.id === incidentId) return
    const unsub = assetStore.subscribe((a) => {
      if (a.assets?.manifest.id !== incidentId) return
      unsub()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const s = useStore.getState()
          if (useWorkspace.getState().workspace === 'forensic' && s.incidentId === incidentId) s.flyToLocal(x, z, distance)
        }),
      )
    })
  })
}

export function switchWorkspace(target: Workspace): void {
  const ws = useWorkspace.getState()
  if (ws.workspace === target) return
  const s = useStore.getState()
  const m = s.manifest?.status === 'ready' ? s.manifest : null
  if (target === 'forensic') {
    const v = ws.view
    const local = m && v ? lonLatToLocal(v.centerLon, v.centerLat, m.grid) : null
    const half = m ? m.grid.extent_m / 2 : 0
    if (m && v && local && Math.abs(local[0]) <= half && Math.abs(local[1]) <= half) {
      flyForensic(m.id, local[0], local[1], forensicDistance(metersPerPixel(v.zoom, v.centerLat), window.innerHeight))
    } else {
      s.setFlyTo(null) // outside the analysis area: Forensic frames the fire
    }
  } else {
    const cam = useSceneStore.getState().camera
    if (m && cam) {
      const [lon, lat] = localToLonLat(cam.target[0], cam.target[2], m.grid)
      const threeD = ws.perspective === '3d'
      ws.setView({ centerLon: lon, centerLat: lat, zoom: zoomForMetersPerPixel(cam.metersPerPixel, lat), bearing: threeD ? cam.bearingDeg : 0, pitch: threeD ? Math.min(cam.polarDeg, 60) : 0 })
    }
  }
  ws.setWorkspace(target)
}
