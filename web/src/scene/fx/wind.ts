// Wind on the 4x4 weather grid (SPEC 5.1 WeatherFile.grid): linear in time between hourly steps, bilinear in space.
// u east+, v north+ (m/s). Local z is south+, so a world velocity is (u, 0, -v).
import type { WeatherFile } from '../../api/types'
import type { WindState } from './state'

function upperBound(a: number[], x: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Fill `out` with the wind grid at epoch `tMs` (clamped to the file's range). Returns false without usable data
 *  (the grid is then zeroed, so shaders see calm air). */
export function updateWind(weather: WeatherFile | null, tMs: number, out: WindState): boolean {
  const g = weather?.grid
  const ts = weather?.t_ms
  if (!g || !ts || ts.length === 0 || g.u_ms.length < ts.length * 16 || g.v_ms.length < ts.length * 16 || g.x.length < 4 || g.z.length < 4) {
    out.valid = false
    out.meanSpeed = 0
    out.u.fill(0)
    out.v.fill(0)
    out.uv.fill(0)
    return false
  }
  const n = ts.length
  let i0 = Math.max(0, upperBound(ts, tMs) - 1)
  let f = 0
  if (tMs <= ts[0]) i0 = 0
  else if (i0 >= n - 1) i0 = n - 1
  else f = (tMs - ts[i0]) / Math.max(1, ts[i0 + 1] - ts[i0])
  const i1 = Math.min(n - 1, i0 + 1)
  let sum = 0
  for (let k = 0; k < 16; k++) {
    const u0 = g.u_ms[i0 * 16 + k]
    const v0 = g.v_ms[i0 * 16 + k]
    const u = u0 + (g.u_ms[i1 * 16 + k] - u0) * f
    const v = v0 + (g.v_ms[i1 * 16 + k] - v0) * f
    const uu = Number.isFinite(u) ? u : 0
    const vv = Number.isFinite(v) ? v : 0
    out.u[k] = uu
    out.v[k] = vv
    out.uv[2 * k] = uu
    out.uv[2 * k + 1] = vv
    sum += Math.hypot(uu, vv)
  }
  const x0 = g.x[0] ?? -1
  const dx = (g.x[3] - g.x[0]) / 3 || 1
  const z0 = g.z[0] ?? -1
  const dz = (g.z[3] - g.z[0]) / 3 || 1
  out.axes.set(x0, dx, z0, dz)
  out.valid = true
  out.meanSpeed = sum / 16
  return true
}

/** Bilinear wind at local (x, z) into `out` (u east+, v north+, m/s). Allocation-free. */
export function sampleWind(w: WindState, x: number, z: number, out: { u: number; v: number }): void {
  if (!w.valid) {
    out.u = 0
    out.v = 0
    return
  }
  const fx = Math.min(3, Math.max(0, (x - w.axes.x) / w.axes.y))
  const fz = Math.min(3, Math.max(0, (z - w.axes.z) / w.axes.w))
  const i0 = Math.min(2, Math.floor(fx))
  const j0 = Math.min(2, Math.floor(fz))
  const tx = fx - i0
  const tz = fz - j0
  const k00 = j0 * 4 + i0
  const k10 = k00 + 1
  const k01 = k00 + 4
  const k11 = k01 + 1
  const ua = w.u[k00] + (w.u[k10] - w.u[k00]) * tx
  const ub = w.u[k01] + (w.u[k11] - w.u[k01]) * tx
  const va = w.v[k00] + (w.v[k10] - w.v[k00]) * tx
  const vb = w.v[k01] + (w.v[k11] - w.v[k01]) * tx
  out.u = ua + (ub - ua) * tz
  out.v = va + (vb - va) * tz
}

/** Meteorological FROM direction (deg clockwise from north) of a (u, v) vector. */
export function windFromDeg(u: number, v: number): number {
  const d = (Math.atan2(-u, -v) * 180) / Math.PI
  return (d + 360) % 360
}
