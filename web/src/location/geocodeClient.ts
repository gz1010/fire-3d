// Address lookup through the Fire-3d API's Census Geocoder proxy (owner: location; CONTRACT §6). Only explicitly
// submitted US street addresses go here; coordinates and incident names are resolved locally. The default timeout
// outlasts the proxy's own worst case (two 10 s upstream attempts), so a slow Census reply surfaces as the proxy's
// clear 504 rather than a client-side abort.
import { API_BASE, fetchJson, type FetchOptions } from '../api/client'
import type { GeocodeResponse } from './types'

export function geocodeAddress(query: string, opts?: FetchOptions): Promise<GeocodeResponse> {
  return fetchJson<GeocodeResponse>(`${API_BASE}/api/geocode?q=${encodeURIComponent(query.trim())}`, { timeoutMs: 30_000, ...opts })
}
