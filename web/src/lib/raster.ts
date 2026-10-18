// Bundle raster loading + three.js textures (SPEC 4.1, 4.3, 9.6).
// Arrays are kept exactly as stored (row-major, row 0 = NORTH); textures are uploaded with rows flipped so that
// DataTexture (u, v) matches the terrain plane UV (u = x/extent + .5, v = .5 - z/extent; v = 1 at the north edge).
// Binary downloads are cached by URL (deduped, LRU-bounded) so every file is fetched once.
import * as THREE from 'three'
import { bundleUrl, fetchArrayBuffer } from '../api/client'
import type { ForecastLayerName, ForecastManifest, IncidentManifest, LayerInfo } from '../api/types'

export type RasterArray = Float32Array | Uint8Array | Uint16Array | Int16Array

export interface LoadedLayer {
  name: string
  url: string
  info: LayerInfo
  /** Row-major as stored: row 0 = north edge, col 0 = west edge. Points layers: count x k values. */
  data: RasterArray
  width: number
  height: number
}

/** Arrival textures clamp to this (NEVER = 1e6 does not fit in half floats). */
export const ARRIVAL_CLAMP = 60000

const MAX_CACHE_BYTES = 384 * 1024 * 1024
const cache = new Map<string, { promise: Promise<ArrayBuffer>; bytes: number }>()
let cachedBytes = 0

function fetchCached(url: string): Promise<ArrayBuffer> {
  const hit = cache.get(url)
  if (hit) {
    cache.delete(url) // LRU: move to the end
    cache.set(url, hit)
    return hit.promise
  }
  const entry = { promise: fetchArrayBuffer(url), bytes: 0 }
  cache.set(url, entry)
  entry.promise.then(
    (buf) => {
      entry.bytes = buf.byteLength
      cachedBytes += buf.byteLength
      for (const [k, v] of cache) {
        if (cachedBytes <= MAX_CACHE_BYTES || k === url) break
        cache.delete(k)
        cachedBytes -= v.bytes
      }
    },
    () => cache.delete(url),
  )
  return entry.promise
}

/** Drop cached downloads (all, or those whose URL contains `match`). */
export function clearRasterCache(match?: string): void {
  for (const [k, v] of cache) {
    if (!match || k.includes(match)) {
      cache.delete(k)
      cachedBytes -= v.bytes
    }
  }
}

function typedArray(info: LayerInfo, buf: ArrayBuffer): RasterArray {
  switch (info.dtype) {
    case 'float32':
      return new Float32Array(buf)
    case 'uint8':
      return new Uint8Array(buf)
    case 'uint16':
      return new Uint16Array(buf)
    case 'int16':
      return new Int16Array(buf)
    default:
      throw new Error(`layer ${info.file}: dtype ${info.dtype} is not a raster`)
  }
}

async function loadInfo(incidentId: string, name: string, info: LayerInfo, version: number | string): Promise<LoadedLayer> {
  const url = bundleUrl(incidentId, info.file, version)
  const buf = await fetchCached(url)
  const data = typedArray(info, buf)
  if (info.grid === 'points') {
    const count = info.count ?? 0
    if (count <= 0 || data.length % count !== 0) throw new Error(`layer ${name}: ${data.length} values for ${count} points`)
    return { name, url, info, data, width: data.length / count, height: count }
  }
  const width = info.width ?? 0
  const height = info.height ?? 0
  if (data.length !== width * height) throw new Error(`layer ${name}: expected ${width}x${height}, got ${data.length} values`)
  return { name, url, info, data, width, height }
}

/** Load `manifest.layers[name]` (cached by URL; `?v=built_ms`). */
export function loadLayer(manifest: IncidentManifest, name: string): Promise<LoadedLayer> {
  const info = manifest.layers[name]
  if (!info) return Promise.reject(new Error(`layer ${name} is not in the manifest`))
  return loadInfo(manifest.id, name, info, manifest.built_ms)
}

/** Load a forecast raster (arrival_p10/p50/p90, burn_probability, flame_length_p50). */
export function loadForecastLayer(manifest: IncidentManifest, forecast: ForecastManifest, name: ForecastLayerName): Promise<LoadedLayer> {
  const info = forecast.layers[name]
  if (!info) return Promise.reject(new Error(`forecast layer ${name} missing`))
  return loadInfo(manifest.id, name, info, `${manifest.built_ms}-${forecast.issued_ms}`)
}

/** Copy of `data` with rows reversed (row 0 north -> texture row 0 = south = v 0). */
export function flipRows<T extends RasterArray>(data: T, width: number, height: number, channels = 1): T {
  const out = new (data.constructor as { new (n: number): T })(data.length)
  const row = width * channels
  for (let r = 0; r < height; r++) out.set(data.subarray((height - 1 - r) * row, (height - r) * row) as never, r * row)
  return out
}

function finish(tex: THREE.DataTexture, filter: 'linear' | 'nearest'): THREE.DataTexture {
  const f = filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter
  tex.minFilter = f
  tex.magFilter = f
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.flipY = false
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}

/** Arrival-time texture: rows flipped, values clamped to <= 60000 (NEVER/NaN -> 60000), HalfFloat RedFormat, linear. */
export function arrivalTexture(layer: LoadedLayer): THREE.DataTexture {
  const { data, width: w, height: h } = layer
  const half = new Uint16Array(w * h)
  const toHalf = THREE.DataUtils.toHalfFloat
  for (let r = 0; r < h; r++) {
    const src = (h - 1 - r) * w
    const dst = r * w
    for (let c = 0; c < w; c++) {
      const v = data[src + c]
      half[dst + c] = toHalf(v < ARRIVAL_CLAMP ? v : ARRIVAL_CLAMP)
    }
  }
  const tex = new THREE.DataTexture(half, w, h, THREE.RedFormat, THREE.HalfFloatType)
  tex.name = layer.name
  return finish(tex, 'linear')
}

export interface DataTextureOptions {
  /** Sampling filter (default linear; use nearest for categorical data such as fuel codes). */
  filter?: 'linear' | 'nearest'
  /** GPU storage for float data: 'float' (exact, default) or 'half'. uint8 always uploads as normalized bytes. */
  type?: 'float' | 'half'
  /** Replace this value (default: the layer's nodata) with `nodataValue` (default 0) before upload. */
  nodata?: number
  nodataValue?: number
}

/** Generic single-channel texture, rows flipped to plane UV. uint8 -> normalized [0,1] (value/255);
 *  float32/uint16/int16 -> float (or half) texture holding the raw values. */
export function dataTexture(layer: LoadedLayer, opts: DataTextureOptions = {}): THREE.DataTexture {
  const { data, width: w, height: h } = layer
  const filter = opts.filter ?? 'linear'
  if (data instanceof Uint8Array) {
    const tex = new THREE.DataTexture(flipRows(data, w, h), w, h, THREE.RedFormat, THREE.UnsignedByteType)
    tex.name = layer.name
    tex.unpackAlignment = 1
    return finish(tex, filter)
  }
  const nodata = opts.nodata ?? layer.info.nodata
  const fill = opts.nodataValue ?? 0
  const f = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    const src = (h - 1 - r) * w
    const dst = r * w
    for (let c = 0; c < w; c++) {
      const v = data[src + c]
      f[dst + c] = (nodata !== undefined && v === nodata) || Number.isNaN(v) ? fill : v
    }
  }
  let tex: THREE.DataTexture
  if (opts.type === 'half') {
    const half = new Uint16Array(f.length)
    for (let i = 0; i < f.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.max(-65000, Math.min(65000, f[i])))
    tex = new THREE.DataTexture(half, w, h, THREE.RedFormat, THREE.HalfFloatType)
  } else {
    tex = new THREE.DataTexture(f, w, h, THREE.RedFormat, THREE.FloatType)
  }
  tex.name = layer.name
  return finish(tex, filter)
}

export interface PackedTextureOptions {
  /** Upper clamp per channel (default ARRIVAL_CLAMP for every channel). Values above (and NaN) become the clamp. */
  clampHi?: number[]
  /** Value of a channel whose layer is null (default 0). */
  fill?: number[]
  filter?: 'linear' | 'nearest'
  name?: string
}

/** Pack up to 4 same-size single-channel layers into one RGBA HalfFloat texture (rows flipped to plane UV), so a
 *  shader reads all of them with one fetch (e.g. forecast p10/p50/p90/burn probability). Values are clamped to
 *  [-65000, clampHi]; NaN -> clampHi. Missing layers (null) fill with `fill[i]`. */
export function packedHalfTexture(layers: (LoadedLayer | null)[], opts: PackedTextureOptions = {}): THREE.DataTexture {
  const first = layers.find((l): l is LoadedLayer => l != null)
  if (!first) throw new Error('packedHalfTexture: no layers')
  const w = first.width
  const h = first.height
  for (const l of layers) if (l && (l.width !== w || l.height !== h)) throw new Error(`packedHalfTexture: ${l.name} is ${l.width}x${l.height}, expected ${w}x${h}`)
  const out = new Uint16Array(w * h * 4)
  const toHalf = THREE.DataUtils.toHalfFloat
  for (let ch = 0; ch < 4; ch++) {
    const l = layers[ch] ?? null
    const hi = Math.min(opts.clampHi?.[ch] ?? ARRIVAL_CLAMP, 65000)
    if (!l) {
      const v = toHalf(opts.fill?.[ch] ?? 0)
      for (let i = 0; i < w * h; i++) out[i * 4 + ch] = v
      continue
    }
    const d = l.data
    const nodata = l.info.nodata
    for (let r = 0; r < h; r++) {
      const src = (h - 1 - r) * w
      const dst = r * w
      for (let c = 0; c < w; c++) {
        let v = d[src + c]
        if (Number.isNaN(v) || v > hi || (nodata !== undefined && v === nodata)) v = hi
        else if (v < -65000) v = -65000
        out[(dst + c) * 4 + ch] = toHalf(v)
      }
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType)
  tex.name = opts.name ?? 'packed'
  return finish(tex, opts.filter ?? 'nearest')
}

/** Arrival values at or above this are treated as NEVER (raster NEVER = 1e6; textures clamp to 60000). */
export const NEVER_THRESHOLD = 50000

/** Copy of an arrival raster (hours, NEVER = 1e6) where NEVER pixels within `rings` pixels of burned ones get an
 *  extrapolated time (max of the 8 neighbours + `stepH` per ring); farther NEVER pixels become ARRIVAL_CLAMP. With
 *  such a field, linear texture filtering no longer sweeps through every time value at the burned/unburned edge
 *  (which would light a false front along the whole perimeter); pair it with a never-mask to cut the edge. */
export function fillNever(src: ArrayLike<number>, width: number, height: number, rings = 4, stepH = 1): Float32Array {
  const n = width * height
  let cur = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = src[i]
    cur[i] = Number.isFinite(v) && v < NEVER_THRESHOLD ? v : Number.NaN
  }
  let next = new Float32Array(cur)
  for (let ring = 0; ring < rings; ring++) {
    let changed = false
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const i = r * width + c
        if (!Number.isNaN(cur[i])) continue
        let m = -Infinity
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= height) continue
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc
            if (cc < 0 || cc >= width || (dr === 0 && dc === 0)) continue
            const v = cur[rr * width + cc]
            if (v > m) m = v // NaN compares false
          }
        }
        if (m > -Infinity) {
          next[i] = m + stepH
          changed = true
        }
      }
    }
    if (!changed) break
    const t = cur
    cur = next
    next = t
    next.set(cur)
  }
  for (let i = 0; i < n; i++) if (Number.isNaN(cur[i]) || cur[i] > ARRIVAL_CLAMP) cur[i] = ARRIVAL_CLAMP
  return cur
}

/** Observed-arrival field for smooth shading: RG HalfFloat, linear, rows flipped to plane UV.
 *  R = arrival hours with NEVER filled near the burned area (see fillNever), G = never-mask (1 = never burns).
 *  Burned at time t <=> R <= t && G < 0.5 (the G = 0.5 isoline is the anti-aliased final perimeter). */
export function arrivalFieldTexture(layer: LoadedLayer, rings = 4): THREE.DataTexture {
  const { data, width: w, height: h } = layer
  const filled = fillNever(data, w, h, rings)
  const out = new Uint16Array(w * h * 2)
  const toHalf = THREE.DataUtils.toHalfFloat
  const one = toHalf(1)
  const zero = toHalf(0)
  for (let r = 0; r < h; r++) {
    const src = (h - 1 - r) * w
    const dst = r * w
    for (let c = 0; c < w; c++) {
      const v = data[src + c]
      out[(dst + c) * 2] = toHalf(filled[src + c])
      out[(dst + c) * 2 + 1] = Number.isFinite(v) && v < NEVER_THRESHOLD ? zero : one
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGFormat, THREE.HalfFloatType)
  tex.name = `${layer.name}_field`
  return finish(tex, 'linear')
}

/** Replace masked pixels (mask != 0) with the mean of unmasked / already filled 8-neighbours, ring by ring. */
function inpaint(v: Float32Array, mask: Uint8Array, w: number, h: number, passes: number): void {
  const known = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) known[i] = mask[i] ? 0 : 1
  for (let pass = 0; pass < passes; pass++) {
    const add: number[] = []
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c
        if (known[i]) continue
        let acc = 0
        let n = 0
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= h) continue
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc
            if (cc < 0 || cc >= w) continue
            const j = rr * w + cc
            if (known[j]) {
              acc += v[j]
              n++
            }
          }
        }
        if (n > 0) {
          v[i] = acc / n
          add.push(i)
        }
      }
    }
    if (add.length === 0) break
    for (const i of add) known[i] = 1
  }
}

/** One pass of a 3x3 binomial blur (edges re-normalised). */
function smooth3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let acc = 0
      let wsum = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= h) continue
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc
          if (cc < 0 || cc >= w) continue
          const k = dr === 0 && dc === 0 ? 4 : dr === 0 || dc === 0 ? 2 : 1
          acc += src[rr * w + cc] * k
          wsum += k
        }
      }
      out[r * w + c] = acc / wsum
    }
  }
  return out
}

/** Forecast field for smooth shading: RGBA HalfFloat, linear, rows flipped to plane UV. r/g/b = arrival p10/p50/p90
 *  (hours) with NEVER filled near reached pixels (see fillNever); a = burn probability 0..1 by the horizon
 *  (0 where missing). For display `a` is inpainted across `unburnable` pixels (fire-grid mask, 1 = non-burnable fuel)
 *  and lightly smoothed (two 3x3 binomial passes). pK is finite where a >= K/100, so `a` doubles as the mask of
 *  every quantile. */
export function forecastFieldTexture(
  p10: LoadedLayer | null,
  p50: LoadedLayer | null,
  p90: LoadedLayer | null,
  prob: LoadedLayer | null,
  rings = 4,
  unburnable: Uint8Array | null = null,
): THREE.DataTexture {
  const first = [p10, p50, p90, prob].find((l): l is LoadedLayer => l != null)
  if (!first) throw new Error('forecastFieldTexture: no layers')
  const w = first.width
  const h = first.height
  const chans = [p10, p50, p90].map((l) => (l && l.width === w && l.height === h ? fillNever(l.data, w, h, rings) : null))
  const out = new Uint16Array(w * h * 4)
  const toHalf = THREE.DataUtils.toHalfFloat
  const never = toHalf(ARRIVAL_CLAMP)
  const pNodata = prob?.info.nodata
  let pd: Float32Array | null = null
  if (prob && prob.width === w && prob.height === h) {
    // light 3x3 smoothing of the member fraction: fewer one-pixel specks in the 10/50/90 % contours
    const raw = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const v = prob.data[i]
      raw[i] = Number.isFinite(v) && !(pNodata !== undefined && v === pNodata) ? Math.min(1, Math.max(0, v)) : 0
    }
    // non-burnable pixels (water, rock, roads) take their neighbours' value so the contours cross creeks and
    // fuel breaks instead of tracing both banks
    if (unburnable && unburnable.length === w * h) inpaint(raw, unburnable, w, h, 6)
    pd = smooth3(smooth3(raw, w, h), w, h)
  }
  for (let r = 0; r < h; r++) {
    const src = (h - 1 - r) * w
    const dst = r * w
    for (let c = 0; c < w; c++) {
      const o = (dst + c) * 4
      for (let k = 0; k < 3; k++) {
        const ch = chans[k]
        out[o + k] = ch ? toHalf(ch[src + c]) : never
      }
      out[o + 3] = toHalf(pd ? pd[src + c] : 0)
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType)
  tex.name = 'forecast_field'
  return finish(tex, 'linear')
}

/** 256 x 1 RGBA8 lookup texture (index = code, e.g. the FBFM40 LUTs in lib/fuels.ts); nearest, stored as data
 *  (no colour-space conversion: shaders receive the raw sRGB-encoded bytes / 255). */
export function lutTexture(lut: Uint8Array, name = 'lut'): THREE.DataTexture {
  if (lut.length !== 256 * 4) throw new Error(`lutTexture: expected 1024 bytes, got ${lut.length}`)
  const tex = new THREE.DataTexture(lut.slice(), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = name
  tex.unpackAlignment = 4
  return finish(tex, 'nearest')
}

/** Several 256-entry RGBA8 LUTs stacked as rows of one 256 x N texture (row i = luts[i]; sample row i at
 *  v = (i + 0.5) / N); nearest, raw sRGB-encoded bytes like lutTexture. */
export function lutAtlasTexture(luts: Uint8Array[], name = 'lut_atlas'): THREE.DataTexture {
  const out = new Uint8Array(256 * 4 * luts.length)
  luts.forEach((lut, i) => {
    if (lut.length !== 256 * 4) throw new Error(`lutAtlasTexture: LUT ${i} has ${lut.length} bytes, expected 1024`)
    out.set(lut, i * 1024)
  })
  const tex = new THREE.DataTexture(out, 256, luts.length, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.name = name
  tex.unpackAlignment = 4
  return finish(tex, 'nearest')
}

/** sRGB image texture (NAIP). Images keep flipY = true, so the top (north) row maps to v = 1. */
export async function imageTexture(url: string): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}
