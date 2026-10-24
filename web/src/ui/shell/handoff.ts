// Workspace switching with a preserved geographic view centre (owner: shell, CONTRACT §3).
// Incident, data context, forecast run, timeline time and selection live in stores that both workspaces share, so
// only the camera needs a hand-off: map -> Forensic sets the existing store.flyTo (local x/z, read by CameraRig when
// it mounts); Forensic -> map writes useWorkspace.view from the Forensic camera before the map mounts.
// Brief 4 (decision k): the compass heading travels both ways, in 2D as in 3D (store.flyTo.bearingDeg for Forensic,
// read by CameraRig; view.bearing for the map); north up only when the user asks for it. Back on the map the Forensic
// heading is used only when the user turned the Forensic camera there (a drag that changed the heading, or a turn /
// north-up command); otherwise the map gets back its own heading from before it left (review H2-B2: Forensic frames a
// fire at its own default azimuth, which the user never chose).
// lib/reproject is the map-side home of the UTM helpers (map-core may make it three.js-free)
import { angleDelta } from '../../lib/compass'
import { localToLonLat, lonLatToLocal } from '../../lib/reproject'
import { useSceneStore } from '../../scene/sceneStore'
import { useMapRuntime } from '../../map/mapStore'
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

/** Camera commands that do not turn the Forensic camera (any other kind, such as north up or H5's turns, does). */
const NON_TURNING = new Set<string>(['frame-fire', 'zoom-in', 'zoom-out'])

/** The heading the map gets back from Forensic: the Forensic camera's when the user turned it there, else the map's own
 *  from before it left (null: north up, as a map that never had a heading). Pure. */
export function returnBearing(forensicBearing: number, turnedInForensic: boolean, mapBearing: number | null): number {
  return turnedInForensic ? forensicBearing : (mapBearing ?? 0)
}

/** The map's heading when it handed over to Forensic (null: Forensic was opened directly). */
let mapBearingAtLeave: number | null = null
/** The user turned the Forensic camera since Forensic was entered. */
let turnedInForensic = false

/** Watch the Forensic camera for the user's own turns (only while Forensic is the workspace). */
useSceneStore.subscribe((s, p) => {
  if (useWorkspace.getState().workspace !== 'forensic') return
  if (s.cameraCommand && s.cameraCommand !== p.cameraCommand && !NON_TURNING.has(s.cameraCommand.kind)) turnedInForensic = true
  // a drag (OrbitControls 'start' … 'end', and its damping right after) that changed the heading
  if ((s.interacting || p.interacting) && s.camera && p.camera && Math.abs(angleDelta(p.camera.bearingDeg, s.camera.bearingDeg)) > 0.1) turnedInForensic = true
})

/** store.flyTo for the Forensic camera. CameraRig applies it on mount when the incident's assets are cached; on a
 *  first visit it frames the fire once the assets arrive, so the request is repeated right after that. */
function flyForensic(incidentId: string, x: number, z: number, distance: number, bearingDeg: number): void {
  useStore.getState().flyToLocal(x, z, distance, bearingDeg)
  void import('../../scene/assets').then(({ assetStore }) => {
    if (assetStore.getState().assets?.manifest.id === incidentId) return
    const unsub = assetStore.subscribe((a) => {
      if (a.assets?.manifest.id !== incidentId) return
      unsub()
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const s = useStore.getState()
          if (useWorkspace.getState().workspace === 'forensic' && s.incidentId === incidentId) s.flyToLocal(x, z, distance, bearingDeg)
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
    mapBearingAtLeave = useMapRuntime.getState().camera?.bearing ?? v?.bearing ?? null
    turnedInForensic = false
    const local = m && v ? lonLatToLocal(v.centerLon, v.centerLat, m.grid) : null
    const half = m ? m.grid.extent_m / 2 : 0
    if (m && v && local && Math.abs(local[0]) <= half && Math.abs(local[1]) <= half) {
      // the live map heading (the stored view is written when the camera settles)
      const bearing = useMapRuntime.getState().camera?.bearing ?? v.bearing
      flyForensic(m.id, local[0], local[1], forensicDistance(metersPerPixel(v.zoom, v.centerLat), window.innerHeight), bearing)
    } else {
      s.setFlyTo(null) // outside the analysis area: Forensic frames the fire
    }
  } else {
    const cam = useSceneStore.getState().camera
    if (m && cam) {
      const [lon, lat] = localToLonLat(cam.target[0], cam.target[2], m.grid)
      const threeD = ws.perspective === '3d'
      // the heading is kept in 2D too (the map turns in 2D since brief 4): the Forensic one when the user turned it,
      // else the map's own from before it left (or the stored view's, when Forensic was opened directly)
      const bearing = returnBearing(cam.bearingDeg, turnedInForensic, mapBearingAtLeave ?? ws.view?.bearing ?? null)
      ws.setView({ centerLon: lon, centerLat: lat, zoom: zoomForMetersPerPixel(cam.metersPerPixel, lat), bearing, pitch: threeD ? Math.min(cam.polarDeg, 60) : 0 })
    }
    mapBearingAtLeave = null
    turnedInForensic = false
  }
  ws.setWorkspace(target)
}
