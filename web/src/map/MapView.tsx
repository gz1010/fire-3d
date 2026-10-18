// Public/Command map (owner: map-core; CONTRACT §4.1). A thin React shell around MapController (mapController.ts):
// one MapLibre map for 2D and 3D, created on mount and removed on unmount (the inactive workspace is unmounted, so the
// map never renders in the background). Notices for failing providers and the modeled-area boundary render above it.
import 'maplibre-gl/dist/maplibre-gl.css'
import './map.css'
import { useEffect, useRef } from 'react'
import { MapController } from './mapController'
import { MapNotices } from './MapNotices'

export function MapView() {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const controller = new MapController(el)
    return () => controller.destroy()
  }, [])
  return (
    <>
      <div ref={ref} className="mw-map-canvas" />
      <MapNotices />
    </>
  )
}

export default MapView
