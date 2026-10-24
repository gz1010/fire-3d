// The Public fire view's map profile (brief 4 H4, PLAN-4 decision a; CONTRACT §15.5 "H4"). Pure and tested
// (fireProfile.test.ts); the map controller, the legend, the notices and the Layers drawer read it.
// In Public, inside a fire, the map shows only the current fire area: the newest agency perimeter (whatever the
// timeline time; filled, as the screen's "fire area"), the reported location (drawn by the fire view's own overlay,
// ui/public/ReportedPoint.tsx), the official layers (evacuation zones, NWS outlines) and the other fires, dimmed.
// Modeled spread, the observed burned-area raster (an estimate), satellite detections, the modeled-area boundary and
// event markers stay in Command ("MORE IN COMMAND ›"). Command and the overview keep the full map ('full').
import type { Perimeter } from '../api/types'
import type { MapLayerKey, Preset } from '../state/workspace'

export type MapProfile = 'full' | 'public-fire'

/** Public with a fire open draws the fire view's profile; everything else the full map. */
export function mapProfileOf(preset: Preset, hasFire: boolean): MapProfile {
  return preset === 'public' && hasFire ? 'public-fire' : 'full'
}

/** The workspace layers the Public fire view never draws (they stay in Command). */
export const PUBLIC_FIRE_HIDDEN: readonly MapLayerKey[] = ['observed', 'forecast', 'detections', 'events']

/** What the map draws: the user's layer choices, less what the profile leaves out. The choices themselves are kept
 *  (Command shows them again as they were). */
export function profileLayers(profile: MapProfile, layers: Readonly<Record<MapLayerKey, boolean>>): Record<MapLayerKey, boolean> {
  const out = { ...layers }
  if (profile === 'public-fire') for (const k of PUBLIC_FIRE_HIDDEN) out[k] = false
  return out
}

/** The newest perimeter of the bundle, whatever the timeline time (the last one on ties); null when there is none. */
export function newestPerimeter(perimeters: readonly Perimeter[] | null | undefined): Perimeter | null {
  let best: Perimeter | null = null
  for (const p of perimeters ?? []) if (p && Number.isFinite(p.t_ms) && p.rings?.length && (!best || p.t_ms >= best.t_ms)) best = p
  return best
}

/** A live fire's perimeter older than this is tagged Stale in the key (agency perimeters are mapped about daily). */
export const PERIMETER_STALE_MS = 24 * 3_600_000

/** Whether the key tags the perimeter Stale: a live fire's perimeter older than PERIMETER_STALE_MS (a past fire's
 *  record is an archive: its date says how old it is). */
export function perimeterStale(perimeterMs: number, nowMs: number, live: boolean): boolean {
  return live && Number.isFinite(perimeterMs) && nowMs - perimeterMs > PERIMETER_STALE_MS
}

type Ring = readonly (readonly [number, number])[]

function ringContains(ring: Ring, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  return Math.abs(a) / 2
}

/** A perimeter's rings (exteriors and holes, unlabelled, as the backend writes them; location/geometry.ts reads them
 *  with the even-odd rule) grouped into polygons for a fill: [exterior, ...its holes]. A ring inside an even number of
 *  other rings is an exterior; inside an odd number, a hole of the smallest ring around it. Rings with fewer than three
 *  points are left out. Returns ring indices, so any coordinate space works. */
export function ringPolygons(rings: readonly Ring[]): number[][] {
  const ok = rings.map((r, i) => (r.length >= 3 ? i : -1)).filter((i) => i >= 0)
  const area = new Map(ok.map((i) => [i, ringArea(rings[i])]))
  // the rings around each ring (tested at its first point; rings of a valid perimeter do not cross)
  const around = new Map<number, number[]>()
  for (const i of ok) {
    const [x, y] = rings[i][0]
    around.set(
      i,
      ok.filter((j) => j !== i && (area.get(j) ?? 0) > (area.get(i) ?? 0) && ringContains(rings[j], x, y)),
    )
  }
  const polys = new Map<number, number[]>()
  for (const i of ok) if ((around.get(i)?.length ?? 0) % 2 === 0) polys.set(i, [i])
  for (const i of ok) {
    const outs = around.get(i) ?? []
    if (outs.length % 2 === 0) continue
    // the smallest exterior around it
    const host = outs.filter((j) => polys.has(j)).sort((a, b) => (area.get(a) ?? 0) - (area.get(b) ?? 0))[0]
    if (host != null) polys.get(host)?.push(i)
  }
  return [...polys.values()]
}
