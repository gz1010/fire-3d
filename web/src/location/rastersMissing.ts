// Raster slots for a check without a bundle (owner: location): every layer 'missing'.
import type { RasterSlot } from '../data/rasters'
import type { LocationRasters } from './types'

const MISSING: RasterSlot = { status: 'missing', layer: null, error: null }

export function makeRastersMissing(): LocationRasters {
  return { observedArrival: MISSING, elevation: MISSING, fuel: MISSING, burnProbability: MISSING, arrivalP10: MISSING, arrivalP50: MISSING, arrivalP90: MISSING }
}
