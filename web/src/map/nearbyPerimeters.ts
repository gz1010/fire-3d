// Other prepared fires in view (brief 2 decision 10; owner: map): their latest agency perimeter as a lighter dashed
// outline, so neighbouring fires stay visible while one fire is open (or on the overview when zoomed in). Only fires
// whose area is in view are fetched (their manifest for the grid, and perimeters.json: a few KB each), at most
// NEARBY_MAX at a time, nearest the view centre first; each bundle version is fetched once per session.
// Honest replay: while a past fire is open at timeline time t, a fire that had not started by t is not drawn, and each
// fire shows its latest perimeter published by t (live or on the overview: the latest one).
import type { IncidentSummary, ManifestGrid, Perimeter } from '../api/types'
import type { LonLatBox } from '../lib/fireBounds'
import { localToLonLat, type LonLat, type UtmGrid } from '../lib/reproject'
import { fmtDate } from '../lib/time'
import { boxesIntersect, distanceToBoxKm } from './focus'
import type { Feature, FeatureCollection, Geometry } from './overlayModel'

/** Other fires' perimeters are fetched and drawn from this zoom. */
export const NEARBY_MIN_ZOOM = 7
/** At most this many other fires at once (nearest the view centre). */
export const NEARBY_MAX = 8

export interface NearbyFire {
  id: string
  name: string
  builtMs: number | null
  bbox: LonLatBox
  startedMs: number
}

export interface NearbyBundle {
  grid: Pick<ManifestGrid, 'utm_zone' | 'center_e' | 'center_n'>
  perimeters: Pick<Perimeter, 't_ms' | 'acres' | 'rings'>[]
}

/** The prepared fires to outline: in view, not the open one, started by `startedBy` (replays), nearest first. */
export function nearbyFires(
  rows: readonly Pick<IncidentSummary, 'id' | 'name' | 'bundle_status' | 'bundle_built_ms' | 'bbox_lonlat' | 'started_ms'>[],
  view: LonLatBox,
  center: [number, number],
  openId: string | null,
  startedBy: number | null = null,
  max = NEARBY_MAX,
): NearbyFire[] {
  const seen = new Set<string>()
  const out: { fire: NearbyFire; d: number }[] = []
  for (const r of rows) {
    const b = r.bbox_lonlat
    if (r.bundle_status !== 'ready' || !b || r.id === openId || seen.has(r.id) || !boxesIntersect(b, view)) continue
    if (startedBy != null && r.started_ms > startedBy) continue
    seen.add(r.id)
    out.push({ fire: { id: r.id, name: r.name, builtMs: r.bundle_built_ms, bbox: b, startedMs: r.started_ms }, d: distanceToBoxKm(center, b) })
  }
  out.sort((a, b) => a.d - b.d || a.fire.id.localeCompare(b.fire.id))
  return out.slice(0, max).map((x) => x.fire)
}

/** Index of the perimeter to show: the newest, or the newest published by `tMs`; -1 when none. */
export function shownPerimeterIndex(perimeters: readonly Pick<Perimeter, 't_ms'>[], tMs: number | null): number {
  let best = -1
  for (let i = 0; i < perimeters.length; i++) {
    const t = perimeters[i].t_ms
    if (tMs != null && t > tMs) continue
    if (best < 0 || t > perimeters[best].t_ms) best = i
  }
  return best
}

function ringsLonLat(rings: readonly [number, number][][], grid: UtmGrid): LonLat[][] {
  return rings
    .filter((r) => r.length >= 2)
    .map((r) => {
      const out = r.map(([x, z]) => localToLonLat(x, z, grid))
      const [a, b] = [out[0], out[out.length - 1]]
      if (a[0] !== b[0] || a[1] !== b[1]) out.push(a)
      return out
    })
}

/** One outline per fire (its shown perimeter), labelled with the fire's name and the perimeter's date. */
export function nearbyPerimeterFeatures(entries: readonly { fire: NearbyFire; bundle: NearbyBundle }[], tMs: number | null): { fc: FeatureCollection; key: string } {
  const features: Feature<Geometry>[] = []
  const keys: string[] = []
  for (const { fire, bundle } of entries) {
    const i = shownPerimeterIndex(bundle.perimeters, tMs)
    if (i < 0) continue
    const p = bundle.perimeters[i]
    const coords = ringsLonLat(p.rings, bundle.grid)
    if (!coords.length) continue
    keys.push(`${fire.id}:${i}`)
    features.push({
      type: 'Feature',
      id: features.length,
      geometry: { type: 'MultiLineString', coordinates: coords },
      properties: { id: fire.id, name: fire.name, t: p.t_ms, label: `${fire.name} · perimeter ${fmtDate(p.t_ms)}` },
    })
  }
  return { fc: { type: 'FeatureCollection', features }, key: keys.join('|') }
}

type JsonFetcher = <T>(url: string) => Promise<T>

/** Fetches each fire's grid and perimeters once per bundle version (failures are retried on a later view). */
export class NearbyLoader {
  private readonly cache = new Map<string, Promise<NearbyBundle | null>>()
  private readonly done = new Map<string, NearbyBundle>()
  private readonly fetchJson: JsonFetcher
  private readonly url: (id: string, file: string, v: number | null) => string

  constructor(fetchJson: JsonFetcher, url: (id: string, file: string, v: number | null) => string) {
    this.fetchJson = fetchJson
    this.url = url
  }

  static key(f: Pick<NearbyFire, 'id' | 'builtMs'>): string {
    return `${f.id}@${f.builtMs ?? ''}`
  }

  /** The loaded bundle, or undefined while it is not (yet) in. */
  get(f: Pick<NearbyFire, 'id' | 'builtMs'>): NearbyBundle | undefined {
    return this.done.get(NearbyLoader.key(f))
  }

  load(f: Pick<NearbyFire, 'id' | 'builtMs'>): Promise<NearbyBundle | null> {
    const k = NearbyLoader.key(f)
    let p = this.cache.get(k)
    if (!p) {
      p = Promise.all([
        this.fetchJson<{ grid: NearbyBundle['grid'] }>(this.url(f.id, 'manifest.json', f.builtMs)),
        this.fetchJson<{ perimeters: NearbyBundle['perimeters'] }>(this.url(f.id, 'perimeters.json', f.builtMs)),
      ]).then(
        ([m, per]) => {
          const b: NearbyBundle = { grid: m.grid, perimeters: Array.isArray(per?.perimeters) ? per.perimeters : [] }
          this.done.set(k, b)
          return b
        },
        () => {
          this.cache.delete(k)
          return null
        },
      )
      this.cache.set(k, p)
    }
    return p
  }
}
