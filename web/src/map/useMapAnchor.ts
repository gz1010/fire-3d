// A map point on screen, kept current while the map moves (brief 4 H3, for H4's hazard-circle → reported-point leader
// on the fire view; the same projection LeaderLabels uses). Returns the point in the map container's pixels (the map
// fills the window, so these are window pixels too) and whether it is inside the map, or null without a map or point.
// One projection per frame while the camera moves (rAF), no React render when the point did not move by half a pixel.
// Draw the line with map/leaderLayout.ts helpers (segmentHitsRect to hide it when it would cross chrome).
import { useEffect, useState } from 'react'
import { useMapRuntime } from './mapStore'

export interface MapAnchor {
  x: number
  y: number
  /** Inside the map's visible area. */
  inView: boolean
}

export function useMapAnchor(lngLat: readonly [number, number] | null): MapAnchor | null {
  const map = useMapRuntime((s) => s.map)
  const lon = lngLat?.[0]
  const lat = lngLat?.[1]
  const [anchor, setAnchor] = useState<MapAnchor | null>(null)
  useEffect(() => {
    if (!map || lon == null || lat == null || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      setAnchor(null)
      return
    }
    let raf = 0
    const update = () => {
      raf = 0
      const p = map.project([lon, lat])
      const c = map.getContainer()
      const inView = p.x >= 0 && p.y >= 0 && p.x <= c.clientWidth && p.y <= c.clientHeight
      setAnchor((cur) => (cur && Math.abs(cur.x - p.x) < 0.5 && Math.abs(cur.y - p.y) < 0.5 && cur.inView === inView ? cur : { x: p.x, y: p.y, inView }))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    map.on('move', schedule)
    map.on('resize', schedule)
    return () => {
      map.off('move', schedule)
      map.off('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [map, lon, lat])
  return anchor
}
