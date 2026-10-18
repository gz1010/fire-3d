// What "the fire" is when Fire-3d measures how far an official area lies from it (owner: official-web): the newest
// mapped perimeter at or before the given time (thinned), the satellite heat detections up to that time (VIIRS /
// MODIS / Landsat, thinned; GOES pixels are too coarse) and the reported location; plus the analysis area (the AOI
// quadrilateral) used for "Cal OES does not say which fire this is for". Pure, tested in fire.test.ts.
import type { Detection, IncidentManifest, IncidentSummary, Perimeter } from '../api/types'
import { aoiCornersLonLat, localToLonLat } from '../lib/reproject'
import { thinRing, type LonLat } from './geo'

const MAX_DETECTIONS = 300

export interface FireReference {
  /** The reported location (CAL FIRE's point) and recent heat detections (lon/lat). */
  points: LonLat[]
  /** Outer rings of the newest mapped perimeter at or before the time (lon/lat, thinned). */
  rings: LonLat[][]
  /** The analysis area's corners (lon/lat), null without a ready manifest. */
  aoi: LonLat[] | null
  /** The perimeter's time, when one is used. */
  perimeterMs: number | null
  /** Number of heat detections used. */
  detections: number
}

export function fireReference(
  summary: Pick<IncidentSummary, 'lat' | 'lon'> | null,
  manifest: Pick<IncidentManifest, 'grid'> | null,
  perimeters: readonly Perimeter[] | null | undefined,
  timeMs: number,
  detections?: readonly Detection[] | null,
): FireReference {
  const points: LonLat[] = summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon) ? [[summary.lon, summary.lat]] : []
  let rings: LonLat[][] = []
  let perimeterMs: number | null = null
  if (manifest?.grid && perimeters?.length) {
    let best: Perimeter | null = null
    for (const p of perimeters) if (p.t_ms <= timeMs && (!best || p.t_ms > best.t_ms)) best = p
    if (best) {
      const grid = manifest.grid
      rings = best.rings.filter((r) => r.length >= 3).map((r) => thinRing(r.map(([x, z]) => localToLonLat(x, z, grid))))
      perimeterMs = best.t_ms
    }
  }
  let n = 0
  if (detections?.length) {
    const recent = detections.filter((d) => d.instrument !== 'GOES' && d.t_ms <= timeMs && Number.isFinite(d.lon) && Number.isFinite(d.lat))
    const step = Math.max(1, Math.ceil(recent.length / MAX_DETECTIONS))
    for (let i = 0; i < recent.length; i += step) {
      points.push([recent[i].lon, recent[i].lat])
      n++
    }
  }
  const aoi = manifest?.grid ? aoiCornersLonLat(manifest.grid) : null
  return { points, rings, aoi, perimeterMs, detections: n }
}

/** What a distance to the fire was measured to, for details and tooltips. */
export function fireReferenceText(f: FireReference): string {
  const parts = [f.rings.length ? 'its newest mapped perimeter' : null, f.detections ? 'its satellite heat detections' : null, f.points.length > f.detections ? 'its reported location' : null].filter(
    (s): s is string => s != null,
  )
  if (!parts.length) return ''
  if (parts.length === 1) return `Distance measured to the fire's ${parts[0].replace(/^its /, '')}.`
  return `Distance measured to the nearest of the fire's ${parts.slice(0, -1).map((p) => p.replace(/^its /, '')).join(', ')} and ${parts[parts.length - 1].replace(/^its /, '')}.`
}
