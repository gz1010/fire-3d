// Address, town and ZIP lookup through the Fire-3d API (owner: us-web; CONTRACT §6, §14.10). Street addresses go to the
// Census Geocoder proxy; US towns and ZIP codes are matched locally by the backend (no upstream call). Coordinates and
// incident names are resolved in the browser and never come here. The default timeout outlasts the proxy's own worst
// case (two 10 s upstream attempts), so a slow Census reply surfaces as the proxy's clear 504 rather than a
// client-side abort.
import { API_BASE, ApiError, fetchJson, type FetchOptions } from '../api/client'
import type { GeocodeResponse } from './types'

export function geocodeAddress(query: string, opts?: FetchOptions): Promise<GeocodeResponse> {
  return fetchJson<GeocodeResponse>(`${API_BASE}/api/geocode?q=${encodeURIComponent(query.trim())}`, { timeoutMs: 30_000, ...opts })
}

/** The backend's own message ({"detail": "..."}), when it sent one. */
function detailOf(e: ApiError): string | null {
  try {
    const d = (JSON.parse(e.body) as { detail?: unknown }).detail
    return typeof d === 'string' && d.trim() ? d.trim() : null
  } catch {
    return null
  }
}

/** A lookup failure in plain words (no status codes, no server jargon). */
export function plainSearchError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 429:
        return 'Too many address lookups in the last minute. Wait a moment, then try again. Coordinates and map clicks still work.'
      case 502:
        return 'The U.S. Census address service is not working right now. Try again later, or click the map.'
      case 504:
        return 'The U.S. Census address service did not answer in time. Try again in a moment.'
      case 400:
      case 503: {
        const d = detailOf(e)
        if (d) return d.replace(/\s*\(HTTP \d{3}\)/g, '')
        return e.status === 400
          ? 'This search could not be read. Enter a street address with a house number, a US town or a ZIP code (e.g. 150 N Capitol Blvd, Boise, ID; Springfield, IL; 83702).'
          : 'Town and ZIP search is not available right now. Enter a street address, or click the map.'
      }
      default:
        return e.status >= 500 ? 'The Fire-3d server had a problem with this search. Try again in a moment.' : 'This search could not be completed. Try again, or click the map.'
    }
  }
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'The search took too long. Try again in a moment.'
  return 'Cannot reach the Fire-3d server. Check your connection, then try again. Coordinates and map clicks still work.'
}
