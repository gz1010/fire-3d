import { describe, expect, it } from 'vitest'
import { areaParams, expandBbox, EXTRAS_PAST_TOLERANCE_MS, extrasAtMs, extrasUrl, incidentAreaBbox, isPastForCurrentSources } from './client'

const NOW = Date.UTC(2026, 9, 17, 20, 28)
const H = 3_600_000

describe('extras query parameters', () => {
  it('builds stable, rounded query strings', () => {
    expect(areaParams({ bbox: [-123.352812, 38.71249, -123.0412, 38.9559], atMs: 1736452800000.4, marginKm: 15 }).toString()).toBe(
      'bbox=-123.3528%2C38.7125%2C-123.0412%2C38.9559&at_ms=1736452800000&margin_km=15',
    )
    expect(areaParams({ incident: '2026-cooley-fire-0c342f', families: ['sentinel-2', 'goes'] }).toString()).toBe(
      'incident=2026-cooley-fire-0c342f&families=sentinel-2%2Cgoes',
    )
    expect(extrasUrl('evacuations', { incident: 'x', atMs: null })).toBe('/api/extras/evacuations?incident=x')
  })

  it('evacuations and cameras: current near now and in the forecast future, past otherwise (hour-quantised)', () => {
    expect(extrasAtMs('evacuations', 'live', NOW - 2 * H, NOW)).toBeNull()
    expect(extrasAtMs('cameras', 'live', NOW + 48 * H, NOW)).toBeNull()
    const past = NOW - 7 * H - 25 * 60_000
    expect(extrasAtMs('evacuations', 'live', past, NOW)).toBe(Math.floor(past / H) * H)
    expect(extrasAtMs('evacuations', 'historical', NOW, NOW)).toBe(Math.floor(NOW / H) * H)
    expect(isPastForCurrentSources('live', NOW - EXTRAS_PAST_TOLERANCE_MS + 1, NOW)).toBe(false)
    expect(isPastForCurrentSources('live', NOW - EXTRAS_PAST_TOLERANCE_MS - 1, NOW)).toBe(true)
    expect(isPastForCurrentSources('historical', NOW + H, NOW)).toBe(true)
  })

  it('live: the NOW marker (latest observation) and later stand for the present, even when the data is stale', () => {
    const marker = NOW - 35 * H // stale live incident: latest observation 35 h ago
    expect(extrasAtMs('evacuations', 'live', marker, NOW, marker)).toBeNull()
    expect(extrasAtMs('cameras', 'live', marker + 24 * H, NOW, marker)).toBeNull()
    expect(extrasAtMs('imagery', 'live', marker, NOW, marker)).toBeNull()
    expect(isPastForCurrentSources('live', marker, NOW, marker)).toBe(false)
    // scrubbed back before the marker: the past again
    expect(extrasAtMs('evacuations', 'live', marker - H, NOW, marker)).toBe(Math.floor((marker - H) / H) * H)
    expect(isPastForCurrentSources('live', marker - H, NOW, marker)).toBe(true)
    expect(extrasAtMs('imagery', 'live', marker - H, NOW, marker)).toBe(Math.floor((marker - H) / 1_800_000) * 1_800_000)
    // a marker never makes historical replay current
    expect(isPastForCurrentSources('historical', NOW, NOW, NOW)).toBe(true)
    expect(extrasAtMs('evacuations', 'historical', NOW, NOW, NOW)).toBe(Math.floor(NOW / H) * H)
  })

  it('imagery: now in live mode, else the selected time floored to 30 min (never in the future)', () => {
    expect(extrasAtMs('imagery', 'live', NOW - 10 * 60_000, NOW)).toBeNull()
    expect(extrasAtMs('imagery', 'live', NOW + 24 * H, NOW)).toBeNull()
    expect(extrasAtMs('imagery', 'live', NOW - 3 * H - 1000, NOW)).toBe(Math.floor((NOW - 3 * H - 1000) / 1_800_000) * 1_800_000)
    const t = Date.UTC(2025, 0, 9, 20, 17)
    expect(extrasAtMs('imagery', 'historical', t, NOW)).toBe(Date.UTC(2025, 0, 9, 20, 0))
    // playback within one 30-min window keeps the same query
    expect(extrasAtMs('imagery', 'historical', t + 10 * 60_000, NOW)).toBe(Date.UTC(2025, 0, 9, 20, 0))
  })
})

describe('incident area', () => {
  it('expands the analysis area by a margin', () => {
    const b = incidentAreaBbox({ lat: 38.83, lon: -123.19 }, { grid: { bbox_lonlat: [-123.3, 38.75, -123.1, 38.9] } } as never, 15)!
    expect(b[1]).toBeCloseTo(38.75 - 15 / 111.32, 6)
    expect(b[3]).toBeCloseTo(38.9 + 15 / 111.32, 6)
    expect(b[0]).toBeLessThan(-123.3 - 0.17)
    expect(b[2]).toBeGreaterThan(-123.1 + 0.17)
  })

  it('falls back to the reported location without a bundle', () => {
    const b = incidentAreaBbox({ lat: 34.092387, lon: -118.840668 }, null, 5)!
    expect((b[3] - b[1]) * 111.32).toBeCloseTo(30, 6)
    expect(incidentAreaBbox(null, null, 5)).toBeNull()
  })

  it('clamps to valid coordinates', () => {
    expect(expandBbox([179.9, 84.9, 179.95, 84.95], 50)).toEqual([expect.any(Number), expect.any(Number), 180, 85])
  })
})
