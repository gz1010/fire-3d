// Scale bar arithmetic (owner: map-core): the longest "nice" distance (1, 2, 2.5 or 5 x 10^n, plus 1/4 and 1/2 mile)
// that fits in `maxPx` CSS pixels, in US customary (ft below a mile, then mi) or metric (m, then km) units.
import type { Units } from '../state/workspace'

const FT = 0.3048
const MI = 1609.344

const steps = (max: number): number => {
  if (!(max > 0) || !Number.isFinite(max)) return 0
  const p = Math.pow(10, Math.floor(Math.log10(max)))
  for (const m of [5, 2.5, 2, 1]) if (m * p <= max) return m * p
  return p
}

export interface ScaleChoice {
  /** Bar length in CSS pixels. */
  px: number
  /** e.g. "2,000 ft", "0.5 mi", "500 m", "2 km". */
  label: string
  meters: number
}

export function niceScale(mPerPx: number, units: Units, maxPx = 90): ScaleChoice {
  const maxM = mPerPx * maxPx
  if (units === 'us') {
    const maxMi = maxM / MI
    if (maxMi >= 1) {
      const mi = steps(maxMi)
      return { px: (mi * MI) / mPerPx, label: `${mi.toLocaleString('en-US')} mi`, meters: mi * MI }
    }
    const maxFt = maxM / FT
    // fractions of a mile read better than 2,500 ft
    for (const f of [0.5, 0.25]) if (f * 5280 <= maxFt && f * 5280 >= maxFt / 2) return { px: (f * MI) / mPerPx, label: `${f} mi`, meters: f * MI }
    const ft = steps(maxFt)
    return { px: (ft * FT) / mPerPx, label: `${ft.toLocaleString('en-US')} ft`, meters: ft * FT }
  }
  if (maxM >= 1000) {
    const km = steps(maxM / 1000)
    return { px: (km * 1000) / mPerPx, label: `${km.toLocaleString('en-US')} km`, meters: km * 1000 }
  }
  const m = steps(maxM)
  return { px: m / mPerPx, label: `${m.toLocaleString('en-US')} m`, meters: m }
}
