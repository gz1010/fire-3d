// Shared option lists for menus and panels.
import type { AircraftCategory, EnsembleKind } from '../api/types'
import type { LatticeField, VisualStyle } from '../state/store'

export const STYLE_OPTIONS: { value: VisualStyle; label: string; desc: string }[] = [
  { value: 'hybrid', label: 'Hybrid', desc: 'Photographic terrain + golden data lattice over the fire' },
  { value: 'realistic', label: 'Realistic', desc: 'Natural light, smoke and flames; no lattice or telemetry' },
  { value: 'parametric', label: 'Parametric', desc: 'Dark relief; everything drawn as glowing points and lines' },
]

export const LATTICE_FIELDS: { value: LatticeField; label: string; desc: string }[] = [
  { value: 'activity', label: 'Activity', desc: 'Recency of burning + front proximity' },
  { value: 'probability', label: 'Probability', desc: 'Forecast burn probability' },
  { value: 'elevation', label: 'Elevation', desc: 'Terrain height' },
  { value: 'slope', label: 'Slope', desc: 'Terrain steepness' },
  { value: 'canopy', label: 'Canopy', desc: 'LANDFIRE canopy cover' },
]

export const EXAGGERATIONS = [1, 1.5, 2, 3]

export const CATEGORY_LABEL: Record<AircraftCategory, string> = {
  airtanker: 'Airtanker',
  helicopter: 'Helicopter',
  air_attack: 'Air attack',
  lead_plane: 'Lead plane',
  other_fire: 'Other fire',
  unknown: 'Other traffic',
}

export const ENSEMBLE_LABEL: Record<EnsembleKind, string> = {
  gfs025: 'GFS 0.25° ensemble',
  ecmwf_ifs025: 'ECMWF IFS 0.25° ensemble',
  perturbed: 'Perturbed HRRR',
  none: 'Deterministic',
}

export const ENSEMBLE_SHORT: Record<EnsembleKind, string> = {
  gfs025: 'GFS',
  ecmwf_ifs025: 'ECMWF',
  perturbed: 'Perturbed',
  none: 'None',
}
