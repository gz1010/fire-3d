// Pure maths of the map's atmosphere (brief 4 decision g; CONTRACT §15.1; map/MapAtmosphere.tsx draws it): the
// globe-like vignette is a circle centred on the safe area (the part of the map the chrome leaves free, where a fire
// is framed), with a radius of half its shorter side, so the dark edge reads like a globe's limb; its strength grows
// with the zoom (faint on the national map, full from z10). Tested in map/atmosphere.test.ts.
import type { SafeInsets } from '../state/workspace'
import type { TintLevel } from './basemapStyle'

export type AtmosphereEdges = 'overview' | 'fire' | 'command'

/** Vignette strength at the national zoom and below (z3), and from z10 on. */
export const VIGNETTE_MIN = 0.25
export const VIGNETTE_MAX = 1
/** The strength is written to the page only when it moved at least this much (no style work per frame). */
export const VIGNETTE_STEP = 0.02

/** --mw-vignette: clamp((zoom − 3) / 7, .25, 1). */
export function vignetteStrength(zoom: number | null | undefined): number {
  if (zoom == null || !Number.isFinite(zoom)) return VIGNETTE_MIN
  return Math.min(VIGNETTE_MAX, Math.max(VIGNETTE_MIN, (zoom - 3) / 7))
}

/** Whether a new strength is worth writing: a change of VIGNETTE_STEP or more, or reaching either end exactly (so a
 *  slow zoom never stops just short of full strength). */
export function vignetteChanged(prev: number | null, next: number): boolean {
  if (prev == null) return true
  if (next === prev) return false
  return Math.abs(next - prev) >= VIGNETTE_STEP - 1e-9 || next === VIGNETTE_MIN || next === VIGNETTE_MAX
}

/** Centre (px from the map's top left) and radius of the vignette for a map of w × h CSS px and the chrome's safe
 *  insets. The insets are scaled down the way the map's own padding is (mapController.padding: at least 120 px of map
 *  stay free each way), and the radius never drops below a fifth of the map's shorter side. */
export function vignetteGeometry(w: number, h: number, i: SafeInsets): { x: number; y: number; r: number } {
  const W = Math.max(0, w)
  const H = Math.max(0, h)
  const maxH = Math.max(0, W - 120)
  const maxV = Math.max(0, H - 120)
  const sh = i.left + i.right > maxH ? maxH / Math.max(1, i.left + i.right) : 1
  const sv = i.top + i.bottom > maxV ? maxV / Math.max(1, i.top + i.bottom) : 1
  const left = Math.max(0, i.left * sh)
  const right = Math.max(0, i.right * sh)
  const top = Math.max(0, i.top * sv)
  const bottom = Math.max(0, i.bottom * sv)
  const fw = Math.max(0, W - left - right)
  const fh = Math.max(0, H - top - bottom)
  const r = Math.max(Math.min(fw, fh) / 2, Math.min(W, H) / 5)
  const round = (v: number) => Math.round(v * 10) / 10
  return { x: round(left + fw / 2), y: round(top + fh / 2), r: round(r) }
}

/** The basemap tint a view gets unless its chrome asks for another (decision j): the national map greyer, a fire view
 *  and Command as the aerial look has been. */
export function defaultTint(edges: AtmosphereEdges): TintLevel {
  return edges === 'overview' ? 'overview' : 'fire'
}
