// Coverage, state, county and time zone at a point (brief 3, CONTRACT §14.3, §14.10 W9): one GET /api/geo/lookup per
// point (rounded to about 1 m by the client, cached here and by the browser for a day). The web never decides coverage
// with its own boxes: Alaska, Hawaii, territories and places outside the US come from this answer only.
import { useEffect, useState } from 'react'
import { getGeoLookup, geoLookupQuery } from '../api/client'
import type { Coverage, GeoLookup } from '../api/types'

/** CONTRACT §14.14 coverage sentences. */
export const NOT_SUPPORTED_TEXT = 'Fire-3d does not support Alaska, Hawaii or US territories yet.'
export const OUTSIDE_US_TEXT = 'Outside the United States: Fire-3d has no data here.'

/** Alaska, Hawaii and territories: the fire lists cover the lower 48 only, so the "nearest fire" would be one more than
 *  a thousand miles away while fires here go unlisted. The card says so instead of listing them. */
export const UNLISTED_HERE_TEXT = 'Fire-3d lists fires in the lower 48 states only, so fires here are not listed. Follow local officials.'

/** False where the nearest listed fires say nothing about the place (Alaska, Hawaii, territories). Places outside the
 *  US keep the list: a point just across a border can be near a listed US fire, and its coverage sentence already says
 *  Fire-3d has no data there. */
export function nearestFiresMeaningful(g: Pick<GeoLookup, 'coverage' | 'supported'> | null | undefined): boolean {
  if (!g || g.supported) return true
  return g.coverage === 'lower48' || g.coverage === 'outside_us'
}

/** The §14.14 sentence for a point Fire-3d does not cover (null inside the lower 48). The backend's `note` wins when
 *  it says something; otherwise the fixed wording by coverage. */
export function coverageText(g: Pick<GeoLookup, 'coverage' | 'supported' | 'note'> | null | undefined): string | null {
  if (!g || g.supported || g.coverage === 'lower48') return null
  if (g.note && g.note.trim()) return g.note.trim()
  return g.coverage === 'outside_us' ? OUTSIDE_US_TEXT : NOT_SUPPORTED_TEXT
}

/** "Ada County, ID" / "Idaho" / null: where a point is, from the lookup. */
export function lookupPlace(g: Pick<GeoLookup, 'state' | 'state_name' | 'county'> | null | undefined): string | null {
  if (!g || !g.state) return null
  return g.county?.name ? `${g.county.name}, ${g.state}` : (g.state_name ?? g.state)
}

export type GeoLookupState = { status: 'loading'; data: null } | { status: 'ok'; data: GeoLookup } | { status: 'error'; data: null; error: string }

const cache = new Map<string, GeoLookup>()
const pending = new Map<string, Promise<GeoLookup>>()

/** One lookup per rounded point (shared by every card asking for it). */
export function lookupPoint(lon: number, lat: number): Promise<GeoLookup> {
  const key = geoLookupQuery(lon, lat)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(key)
  if (!p) {
    p = getGeoLookup(lon, lat)
      .then((g) => {
        cache.set(key, g)
        return g
      })
      .finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

/** The cached answer for a point, if any (no request). */
export function cachedLookup(lon: number, lat: number): GeoLookup | null {
  return cache.get(geoLookupQuery(lon, lat)) ?? null
}

/** The lookup for a point, fetched once (null coordinates: nothing). */
export function useGeoLookup(lon: number | null, lat: number | null): GeoLookupState {
  const valid = lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat)
  const [state, setState] = useState<{ key: string; s: GeoLookupState } | null>(null)
  const key = valid ? geoLookupQuery(lon, lat) : ''
  useEffect(() => {
    if (!valid) return
    // a cached answer is read during render below: nothing to fetch
    if (cachedLookup(lon, lat)) return
    let live = true
    lookupPoint(lon, lat).then(
      (g) => live && setState({ key, s: { status: 'ok', data: g } }),
      (e: unknown) => live && setState({ key, s: { status: 'error', data: null, error: e instanceof Error ? e.message : String(e) } }),
    )
    return () => {
      live = false
    }
  }, [key, valid, lon, lat])
  if (!valid) return { status: 'error', data: null, error: 'no point' }
  if (state && state.key === key) return state.s
  const hit = cachedLookup(lon, lat)
  return hit ? { status: 'ok', data: hit } : { status: 'loading', data: null }
}

/** Is a coverage value one Fire-3d supports? */
export const isSupportedCoverage = (c: Coverage | null | undefined): boolean => c === 'lower48'
