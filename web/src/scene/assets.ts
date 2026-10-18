// Shared GPU/CPU assets of the current incident (Contract for scene-core and scene-fx).
//
// useIncidentAssets() returns the assets of the store's current incident + selected forecast, or null while
// nothing is ready. Loading happens once per (incident id, built_ms) for the base layers and once per forecast run;
// every component calling the hook shares the same objects. Old textures are disposed when the incident, bundle
// build or forecast changes. Base parts (elevation, textures.elevation/naip/..., heightAt) keep their identity when
// only the forecast changes, so depend on those parts rather than on the whole object.
//
// Texture conventions (lib/raster.ts): rows are flipped on upload, so every texture lines up with the terrain plane
// UV (u = x/extent + .5, v = .5 - z/extent). uint8 layers sample as value/255 (fuel: code/255 -> use nearest;
// canopyCover: percent/255; skyView/water: 0..1). Arrival textures hold hours since manifest.time_origin_ms, with
// NEVER clamped to 60000. CPU arrays are as stored (row 0 = north).
import { useEffect } from 'react'
import type * as THREE from 'three'
import { create } from 'zustand'
import { bundleUrl } from '../api/client'
import type { ForecastManifest, IncidentManifest } from '../api/types'
import { sampleBilinear } from '../lib/geo'
import {
  arrivalFieldTexture,
  arrivalTexture,
  dataTexture,
  forecastFieldTexture,
  imageTexture,
  loadForecastLayer,
  loadLayer,
  packedHalfTexture,
  type LoadedLayer,
} from '../lib/raster'
import { useStore } from '../state/store'

export interface IncidentAssets {
  ready: boolean
  manifest: IncidentManifest
  /** Addition: the forecast whose rasters are loaded (null when none). */
  forecast: ForecastManifest | null
  /** Addition: identity key "<id>@<built_ms>#<run>" (changes whenever any part changes). */
  key: string
  extent: number
  elevation: { data: Float32Array; width: number; height: number; min: number; max: number }
  textures: {
    elevation: THREE.DataTexture // Float, linear, metres (not exaggerated)
    observedArrival: THREE.DataTexture | null
    arrivalP10: THREE.DataTexture | null
    arrivalP50: THREE.DataTexture | null
    arrivalP90: THREE.DataTexture | null
    burnProbability: THREE.DataTexture | null
    fuel: THREE.DataTexture | null
    canopyCover: THREE.DataTexture | null
    burnSeverity: THREE.DataTexture | null
    skyView: THREE.DataTexture | null
    water: THREE.DataTexture | null
    naip: THREE.Texture | null
    /** Addition: forecast quantiles packed as RGBA HalfFloat (r p10, g p50, b p90 arrival hours clamped to 60000;
     *  a burn probability 0..1), nearest filtering, plane UV (null without a forecast). */
    forecastPacked: THREE.DataTexture | null
    /** Addition: observed arrival as a smooth field for linear filtering (lib/raster arrivalFieldTexture):
     *  RG HalfFloat, r = arrival hours with NEVER filled near the burned area, g = never-mask (1 = never burns). */
    observedField: THREE.DataTexture | null
    /** Addition: forecast field for linear filtering (lib/raster forecastFieldTexture): RGBA HalfFloat, r/g/b =
     *  p10/p50/p90 arrival hours with NEVER filled near reached pixels, a = burn probability (null w/o forecast). */
    forecastField: THREE.DataTexture | null
  }
  arrays: {
    observedArrival: Float32Array | null // fire grid, hours since origin, NEVER = 1e6
    arrivalP50: Float32Array | null
    trees: Float32Array | null // 6 floats per tree: x, y(ground m), z, height_m, crown_radius_m, kind
    fireGrid: { width: number; height: number }
    /** Addition: FBFM40 codes on the fire grid (row 0 = north; 0 = nodata). */
    fuel: Uint8Array | null
    /** Addition: canopy cover percent on the fire grid. */
    canopyCover: Uint8Array | null
    /** Addition: forecast arrays on the fire grid (null without a forecast). */
    arrivalP10: Float32Array | null
    arrivalP90: Float32Array | null
    burnProbability: Float32Array | null
  }
  /** Terrain elevation in metres (not exaggerated) at local (x, z), bilinear. */
  heightAt(x: number, z: number): number
}

type ForecastTextureKey = 'arrivalP10' | 'arrivalP50' | 'arrivalP90' | 'burnProbability' | 'forecastPacked' | 'forecastField'
type ForecastArrayKey = 'arrivalP10' | 'arrivalP50' | 'arrivalP90' | 'burnProbability'

interface BaseAssets {
  key: string
  manifest: IncidentManifest
  extent: number
  elevation: IncidentAssets['elevation']
  textures: Omit<IncidentAssets['textures'], ForecastTextureKey>
  arrays: Omit<IncidentAssets['arrays'], ForecastArrayKey>
  heightAt: (x: number, z: number) => number
}

interface ForecastAssets {
  key: string
  baseKey: string
  forecast: ForecastManifest
  textures: Pick<IncidentAssets['textures'], ForecastTextureKey>
  arrays: Pick<IncidentAssets['arrays'], ForecastArrayKey>
}

interface AssetsState {
  assets: IncidentAssets | null
  loading: boolean
  error: string | null
}

/** Imperative access (e.g. inside useFrame): assetStore.getState().assets */
export const assetStore = create<AssetsState>()(() => ({ assets: null, loading: false, error: null }))

let base: BaseAssets | null = null
let baseKey: string | null = null
let fc: ForecastAssets | null = null
let fcKey: string | null = null

const baseKeyOf = (m: IncidentManifest | null) => (m && m.status === 'ready' ? `${m.id}@${m.built_ms}` : null)
const fcKeyOf = (bk: string | null, f: ForecastManifest | null) =>
  bk && f && f.status === 'ready' && f.incident_id === bk.split('@')[0] ? `${bk}#${f.run_id}-${f.issued_ms}` : null

function disposeAll(t: Record<string, THREE.Texture | null>) {
  for (const v of Object.values(t)) v?.dispose()
}

async function optional<T>(name: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    console.warn(`[assets] optional layer ${name} unavailable`, e)
    return null
  }
}

async function loadBase(m: IncidentManifest, key: string): Promise<BaseAssets> {
  const has = (n: string) => Boolean(m.layers[n])
  const opt = (n: string) => (has(n) ? optional(n, loadLayer(m, n)) : Promise.resolve(null))
  const naipInfo = m.layers.naip
  const [elev, arrival, fuel, cc, sev, sky, water, trees, naip] = await Promise.all([
    loadLayer(m, 'elevation'),
    opt('observed_arrival'),
    opt('fuel'),
    opt('canopy_cover'),
    opt('burn_severity'),
    opt('sky_view'),
    opt('water'),
    opt('trees'),
    naipInfo ? optional('naip', imageTexture(bundleUrl(m.id, naipInfo.file, m.built_ms))) : Promise.resolve(null),
  ])
  const ed = elev.data as Float32Array
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < ed.length; i++) {
    const v = ed[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  const extent = m.grid.extent_m
  const w = elev.width
  const h = elev.height
  const tex = (l: LoadedLayer | null, f: (l: LoadedLayer) => THREE.DataTexture) => (l ? f(l) : null)
  return {
    key,
    manifest: m,
    extent,
    elevation: { data: ed, width: w, height: h, min, max },
    textures: {
      elevation: dataTexture(elev, { filter: 'linear', type: 'float' }),
      observedArrival: tex(arrival, arrivalTexture),
      observedField: tex(arrival, (l) => arrivalFieldTexture(l)),
      fuel: tex(fuel, (l) => dataTexture(l, { filter: 'nearest' })),
      canopyCover: tex(cc, (l) => dataTexture(l)),
      burnSeverity: tex(sev, (l) => dataTexture(l, { type: 'half', nodataValue: 0 })),
      skyView: tex(sky, (l) => dataTexture(l)),
      water: tex(water, (l) => dataTexture(l)),
      naip,
    },
    arrays: {
      observedArrival: (arrival?.data as Float32Array | undefined) ?? null,
      trees: (trees?.data as Float32Array | undefined) ?? null,
      fireGrid: { width: m.grid.fire.width, height: m.grid.fire.height },
      fuel: fuel?.data instanceof Uint8Array ? fuel.data : null,
      canopyCover: cc?.data instanceof Uint8Array ? cc.data : null,
    },
    heightAt: (x: number, z: number) => sampleBilinear(ed, w, h, x, z, extent),
  }
}

async function loadForecast(m: IncidentManifest, f: ForecastManifest, key: string, bk: string, fuel: Uint8Array | null): Promise<ForecastAssets> {
  const [p10, p50, p90, prob] = await Promise.all([
    optional('arrival_p10', loadForecastLayer(m, f, 'arrival_p10')),
    optional('arrival_p50', loadForecastLayer(m, f, 'arrival_p50')),
    optional('arrival_p90', loadForecastLayer(m, f, 'arrival_p90')),
    optional('burn_probability', loadForecastLayer(m, f, 'burn_probability')),
  ])
  const f32 = (l: LoadedLayer | null) => (l?.data instanceof Float32Array ? l.data : null)
  return {
    key,
    baseKey: bk,
    forecast: f,
    textures: {
      arrivalP10: p10 ? arrivalTexture(p10) : null,
      arrivalP50: p50 ? arrivalTexture(p50) : null,
      arrivalP90: p90 ? arrivalTexture(p90) : null,
      burnProbability: prob ? dataTexture(prob, { type: 'half' }) : null,
      forecastPacked:
        p10 || p50 || p90 || prob
          ? packedHalfTexture([p10, p50, p90, prob], { clampHi: [60000, 60000, 60000, 1], fill: [60000, 60000, 60000, 0], name: 'forecast_packed' })
          : null,
      forecastField: p10 || p50 || p90 || prob ? forecastFieldTexture(p10, p50, p90, prob, 4, unburnableMask(fuel)) : null,
    },
    arrays: { arrivalP10: f32(p10), arrivalP50: f32(p50), arrivalP90: f32(p90), burnProbability: f32(prob) },
  }
}

/** Fire-grid mask of non-burnable fuel (FBFM40 91-99 and nodata 0). */
function unburnableMask(fuel: Uint8Array | null): Uint8Array | null {
  if (!fuel) return null
  const m = new Uint8Array(fuel.length)
  for (let i = 0; i < fuel.length; i++) m[i] = fuel[i] === 0 || fuel[i] < 100 ? 1 : 0
  return m
}

function compose(): void {
  if (!base) {
    assetStore.setState({ assets: null })
    return
  }
  const f = fc && fc.baseKey === base.key ? fc : null
  assetStore.setState({
    assets: {
      ready: true,
      manifest: base.manifest,
      forecast: f?.forecast ?? null,
      key: f ? f.key : `${base.key}#`,
      extent: base.extent,
      elevation: base.elevation,
      textures: {
        ...base.textures,
        arrivalP10: f?.textures.arrivalP10 ?? null,
        arrivalP50: f?.textures.arrivalP50 ?? null,
        arrivalP90: f?.textures.arrivalP90 ?? null,
        burnProbability: f?.textures.burnProbability ?? null,
        forecastPacked: f?.textures.forecastPacked ?? null,
        forecastField: f?.textures.forecastField ?? null,
      },
      arrays: {
        ...base.arrays,
        arrivalP10: f?.arrays.arrivalP10 ?? null,
        arrivalP50: f?.arrays.arrivalP50 ?? null,
        arrivalP90: f?.arrays.arrivalP90 ?? null,
        burnProbability: f?.arrays.burnProbability ?? null,
      },
      heightAt: base.heightAt,
    },
  })
}

/** Bring the shared assets in line with the store's manifest + forecast (idempotent; safe to call often). */
export async function syncIncidentAssets(): Promise<void> {
  const { manifest } = useStore.getState()
  const wantBase = baseKeyOf(manifest)
  if (wantBase !== baseKey) {
    if (fc) disposeAll(fc.textures)
    if (base) disposeAll(base.textures)
    fc = null
    fcKey = null
    base = null
    baseKey = wantBase
    compose()
    if (!wantBase || !manifest) {
      assetStore.setState({ loading: false, error: null })
      return
    }
    assetStore.setState({ loading: true, error: null })
    try {
      const b = await loadBase(manifest, wantBase)
      if (baseKey !== wantBase) {
        disposeAll(b.textures)
        return
      }
      base = b
      compose()
    } catch (e) {
      if (baseKey === wantBase) {
        baseKey = null
        assetStore.setState({ loading: false, error: e instanceof Error ? e.message : String(e) })
      }
      return
    }
  }
  if (!base) return
  const { forecast } = useStore.getState()
  const wantFc = fcKeyOf(base.key, forecast)
  if (wantFc !== fcKey) {
    if (fc) disposeAll(fc.textures)
    fc = null
    fcKey = wantFc
    compose()
    if (wantFc && forecast) {
      assetStore.setState({ loading: true })
      try {
        const f = await loadForecast(base.manifest, forecast, wantFc, base.key, base.arrays.fuel)
        if (fcKey !== wantFc) {
          disposeAll(f.textures)
          return
        }
        fc = f
        compose()
      } catch (e) {
        console.warn('[assets] forecast load failed', e)
      }
    }
  }
  assetStore.setState({ loading: false })
}

/** Assets of the current incident + selected forecast (null until the base layers are ready). */
export function useIncidentAssets(): IncidentAssets | null {
  const mKey = useStore((s) => (s.manifest ? `${s.manifest.id}@${s.manifest.built_ms}:${s.manifest.status}` : null))
  const fKey = useStore((s) => (s.forecast ? `${s.forecast.run_id}-${s.forecast.issued_ms}` : null))
  useEffect(() => {
    void syncIncidentAssets()
  }, [mKey, fKey])
  return assetStore((s) => s.assets)
}

/** True while base or forecast assets are loading. */
export const useAssetsLoading = () => assetStore((s) => s.loading)
/** Last asset loading error (null when fine). */
export const useAssetsError = () => assetStore((s) => s.error)
