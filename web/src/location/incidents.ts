// Incidents the location tools know about (owner: location; brief 2 O-R9). Pure. The pool is every CAL FIRE list
// the main store holds (live fires, the season lists behind the overview filter) plus the open incident's summary;
// the nearest fires are measured from CAL FIRE's reported location of each fire, which is where the fire was
// reported, not its edge: distance alone is never a risk statement.
import type { IncidentSummary } from '../api/types'
import { geodesicInverse } from '../lib/geodesy'

/** Every incident summary in the store: the open incident first, then each catalog list (any array of summaries, so
 *  lists added for the overview filter are included), without repeats. */
export function incidentPool(state: { summary: IncidentSummary | null; catalog: object }): IncidentSummary[] {
  const out: IncidentSummary[] = []
  const seen = new Set<string>()
  const add = (s: unknown) => {
    const v = s as IncidentSummary
    if (v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string' && !seen.has(v.id)) {
      seen.add(v.id)
      out.push(v)
    }
  }
  add(state.summary)
  for (const list of Object.values(state.catalog)) if (Array.isArray(list)) list.forEach(add)
  return out
}

/** Built analysis area of a list row (I2 `bbox_lonlat`, built bundles only), when valid. */
export function rowBbox(s: IncidentSummary): [number, number, number, number] | null {
  const b = (s as IncidentSummary & { bbox_lonlat?: unknown }).bbox_lonlat
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [w, so, e, n] = b as number[]
  return w < e && so < n ? [w, so, e, n] : null
}

export interface NearFire {
  summary: IncidentSummary
  /** Geodesic distance (m) from the point to CAL FIRE's reported location. */
  distanceM: number
  /** Direction of the reported location FROM the point (degrees from true north). */
  bearingDeg: number
  /** The point lies inside the fire's built analysis area (I2 bbox). */
  insideArea: boolean
}

const validPoint = (s: IncidentSummary) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180

/** The `limit` nearest fires to (lat, lon), nearest first; fires whose built area contains the point come first. */
export function nearestFires(pool: readonly IncidentSummary[], lat: number, lon: number, limit = 3): NearFire[] {
  const out: NearFire[] = []
  for (const s of pool) {
    if (!validPoint(s)) continue
    const g = geodesicInverse({ lat, lon }, { lat: s.lat, lon: s.lon })
    const b = rowBbox(s)
    const insideArea = s.bundle_status === 'ready' && !!b && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]
    out.push({ summary: s, distanceM: g.distanceM, bearingDeg: g.initialBearingDeg, insideArea })
  }
  out.sort((a, b) => Number(b.insideArea) - Number(a.insideArea) || a.distanceM - b.distanceM)
  return out.slice(0, limit)
}

export interface Nearby {
  /** The nearest fires (built area containing the point first). */
  fires: NearFire[]
  /** The nearest active fire when it is not among `fires`. */
  active: NearFire | null
  /** A built analysis area contains the point: offer "Open the <name> analysis". */
  inside: NearFire | null
}

/** What the overview card lists for a point (`isActive` says which fires are burning now). */
export function overviewNearby(pool: readonly IncidentSummary[], lat: number, lon: number, isActive: (s: IncidentSummary) => boolean, limit = 3): Nearby {
  const all = nearestFires(pool, lat, lon, Number.POSITIVE_INFINITY)
  const fires = all.slice(0, limit)
  const nearestActive = all.find((f) => isActive(f.summary)) ?? null
  return {
    fires,
    active: nearestActive && !fires.includes(nearestActive) ? nearestActive : null,
    inside: all.find((f) => f.insideArea) ?? null,
  }
}
