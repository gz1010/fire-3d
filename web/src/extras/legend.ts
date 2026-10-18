// Legend entries for the optional sources (owner: optional-sources). Each entry names its layer toggle
// (MapLayerKey), uses the official wording or the source's own product name, and carries a swatch description that
// shows line style / pattern, never colour alone (BRIEF §9).
import type { MapLayerKey } from '../state/workspace'
import type { CameraKind } from './types'

export type ExtrasLayerKey = Extract<MapLayerKey, 'evacuation' | 'cameras' | 'recentImagery'>

export type LegendSwatch =
  | { kind: 'hatch'; color: string; spacing: number; line: 'solid' | 'dashed' | 'dotted' }
  | { kind: 'camera'; variant: CameraKind }
  | { kind: 'direction' }
  | { kind: 'raster' }

export interface ExtrasLegendEntry {
  id: string
  layer: ExtrasLayerKey
  label: string
  /** Short qualifier, e.g. "official · current status" or "acquired Oct 15, 12:14 PDT". */
  detail: string | null
  swatch: LegendSwatch
}
