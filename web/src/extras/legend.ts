// Legend entries for the optional sources (owner: optional-sources). Each entry names its layer toggle
// (MapLayerKey), uses the official wording or the source's own product name, and carries a swatch description that
// shows line style / pattern, never colour alone (BRIEF §9).
import type { MapLayerKey } from '../state/workspace'
import type { CameraKind } from './types'

/** The optional layers (their MapLayerKey toggles) plus 'fireWeather': the NWS outlines drawn by the official map
 *  layer (no toggle of their own; shown while an alert is in effect near the open fire). */
export type ExtrasLayerKey = Extract<MapLayerKey, 'evacuation' | 'cameras' | 'recentImagery'> | 'fireWeather'

export type LegendSwatch =
  | { kind: 'hatch'; color: string; spacing: number; line: 'solid' | 'dashed' | 'dotted' }
  | { kind: 'camera'; variant: CameraKind }
  | { kind: 'direction' }
  | { kind: 'raster' }
  /** Outline only (NWS fire weather zones): no fill, the line style says which product. */
  | { kind: 'outline'; color: string; line: 'solid' | 'dashed' | 'dotted' }

export interface ExtrasLegendEntry {
  id: string
  layer: ExtrasLayerKey
  label: string
  /** Short qualifier, e.g. "official · current status" or "acquired Oct 15, 12:14 PDT". */
  detail: string | null
  swatch: LegendSwatch
  /** Label for the compact legend row (default: the layer's short name), e.g. "Satellite image · VIIRS NOAA-21 · Oct 17, 14:30". */
  compact?: string
}
