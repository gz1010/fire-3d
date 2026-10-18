import { describe, expect, it } from 'vitest'
import { IMAGERY_SAMPLE } from './__fixtures__/samples'
import { byNewest, imageryCaption, imageryChipParts, imageryChipText, imagerySummaryAtMs, newestImagery, orderedProducts, pixelText, platformText, productLabel, withGroupHeadings } from './imagery'
import type { ImageryProduct, ImageryResponse } from './types'

const prods = IMAGERY_SAMPLE.products
const at = (p: ImageryProduct) => p.acquired_ms
const newestOf = (ps: ImageryProduct[]) => [...ps].sort(byNewest)[0]

describe('the newest image (map chip)', () => {
  it('offers the newest usable non-GOES image, preferring those taken after the fire started', () => {
    const usable = prods.filter((p) => p.available && p.display && p.family !== 'goes')
    expect(newestImagery(IMAGERY_SAMPLE, null)?.id).toBe(newestOf(usable).id)
    const start = at(newestOf(usable)) + 1
    // nothing after the start: the newest before it (context)
    expect(newestImagery(IMAGERY_SAMPLE, start)?.id).toBe(newestOf(usable).id)
    // only images acquired up to the replay time count
    const ref = at(newestOf(usable)) - 1
    const before = usable.filter((p) => at(p) <= ref)
    expect(newestImagery(IMAGERY_SAMPLE, null, ref)?.id).toBe(before.length ? newestOf(before).id : newestImagery({ ...IMAGERY_SAMPLE, products: prods.filter((p) => p.family === 'goes') } as ImageryResponse)?.id)
    const onlyGoes = { ...IMAGERY_SAMPLE, products: prods.filter((p) => p.family === 'goes') } as ImageryResponse
    expect(newestImagery(onlyGoes, null)?.family ?? 'goes').toBe('goes')
    expect(newestImagery(null)).toBeNull()
  })

  it('writes the chip and caption: platform, time, age, pixel size, cloud cover; replay ages read "earlier"', () => {
    const p = newestImagery(IMAGERY_SAMPLE, null)!
    const parts = imageryChipParts(p, at(p) + 18 * 3_600_000, true)
    expect(parts.age).toBe('18 h ago')
    expect(parts.pixel).toBe(pixelText(p))
    expect(imageryChipText(p, at(p) + 18 * 3_600_000, true)).toBe(`${platformText(p)} · ${parts.time} (18 h ago) · ${parts.pixel}`)
    expect(imageryChipParts(p, at(p) + 25 * 3_600_000, false).age).toBe('25 h earlier')
    expect(imageryChipParts(p, at(p), false).age).toBe('at the replay time')
    const c = imageryCaption(p, at(p) + 3_600_000, true)
    expect(c.title).toBe(`Satellite image · ${platformText(p)}`)
    expect(c.parts.join(' · ')).toMatch(/(acquired|passes) .* · 1 h ago · .*pixels.* · (cloud cover not reported|\d+ % cloud \(whole scene\))$/)
    expect(c.limits.length).toBeGreaterThan(0)
    expect(platformText({ family: 'viirs', platform: 'NOAA-21', sensor: 'VIIRS' })).toBe('VIIRS NOAA-21')
  })
})

describe('the image list order (O-R15)', () => {
  it('lists images since the fire started first (newest first), then context before it, then GOES', () => {
    const start = at(prods.filter((p) => p.family !== 'goes').sort((a, b) => at(a) - at(b))[1] ?? prods[0])
    const o = orderedProducts(IMAGERY_SAMPLE, start)
    const fams = o.map((p) => p.family)
    expect(fams.lastIndexOf('goes')).toBeLessThan(0 + fams.length)
    const goesFrom = fams.indexOf('goes')
    if (goesFrom >= 0) expect(fams.slice(goesFrom).every((f) => f === 'goes')).toBe(true)
    const fine = o.filter((p) => p.family !== 'goes')
    const afterIdx = fine.map((p) => (p.acquired_end_ms ?? at(p)) >= start)
    expect(afterIdx.indexOf(false) === -1 || afterIdx.slice(afterIdx.indexOf(false)).every((x) => !x)).toBe(true)
    const rows = withGroupHeadings(o, IMAGERY_SAMPLE.reference_ms, start, true)
    expect(rows.filter((r) => r.heading).map((r) => r.heading)).toEqual([...new Set(rows.map((r) => (r.p.family === 'goes' ? 'GOES-West: every 10 min, 1-2 km pixels' : r.t.beforeFire ? 'Before the fire (context)' : 'Since the fire started')))])
  })

  it('asks for one list per incident while the layer is off: now for live fires, the end of the record for replays', () => {
    expect(imagerySummaryAtMs({ mode: 'live', time_range: { end_ms: 5 } }, 10)).toBeNull()
    expect(imagerySummaryAtMs({ mode: 'historical', time_range: { end_ms: 1736535600000 + 1234 } }, 1792342686054)).toBe(1736535600000)
    expect(imagerySummaryAtMs(null, 1)).toBeNull()
  })
})

describe('labels and ties', () => {
  it('shows true color first at the same time, and US spelling', () => {
    const base = prods[0]
    const tc = { ...base, id: 'b', composite: 'true_color' as const, acquired_ms: 10 }
    const fc = { ...base, id: 'a', composite: 'fire_false_color' as const, acquired_ms: 10 }
    expect([fc, tc].sort(byNewest).map((p) => p.id)).toEqual(['b', 'a'])
    expect(productLabel({ label: 'VIIRS fire false colour (NOAA-21)' })).toBe('VIIRS fire false color (NOAA-21)')
  })
})

