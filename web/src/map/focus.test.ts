import { describe, expect, it } from 'vitest'
import type { LonLatBox } from '../lib/fireBounds'
import type { IncidentSummary } from '../api/types'
import { overviewFires } from '../state/overview'
import {
  allFocusCandidates,
  boxesIntersect,
  boxContains,
  centralBox,
  CHIP_MAX,
  CHIP_ZOOM,
  chipTargets,
  distanceToBoxKm,
  focusCandidates,
  FocusHold,
  focusTarget,
  focusUnlessHeld,
  FOCUS_IN_ZOOM,
  FOCUS_OUT_ZOOM,
  nearestCentral,
  type FocusFire,
  type FocusView,
} from './focus'

// Two real prepared fires' areas (list rows' bbox_lonlat): Eaton and Palisades, about 40 km apart.
const EATON: FocusFire = { id: 'eaton', bbox: [-118.215, 34.095, -117.962, 34.305] }
const PAL: FocusFire = { id: 'palisades', bbox: [-118.757, 33.946, -118.426, 34.221] }
const FIRES = [EATON, PAL]

/** A 2D view of `spanDeg` longitude around a centre (aspect 1.6), with its central half. */
function view(lon: number, lat: number, zoom: number, spanDeg = 360 / Math.pow(2, zoom) * 2.8): FocusView {
  const hw = spanDeg / 2
  const hh = hw / 1.6
  const v: LonLatBox = [lon - hw, lat - hh, lon + hw, lat + hh]
  return { zoom, center: [lon, lat], view: v, central: centralBox(v, [lon, lat]) }
}

const cur = (f: FocusFire | null) => (f ? { id: f.id, bbox: f.bbox, point: null } : null)

describe('focus geometry', () => {
  it('boxes, containment, distances and the central part', () => {
    expect(boxesIntersect(EATON.bbox, PAL.bbox)).toBe(false)
    expect(boxesIntersect(EATON.bbox, [-118.1, 34.2, -118.0, 34.4])).toBe(true)
    expect(boxContains(EATON.bbox, [-118.1, 34.2])).toBe(true)
    expect(distanceToBoxKm([-118.1, 34.2], EATON.bbox)).toBe(0)
    // about 20 km west of Eaton's west edge
    expect(distanceToBoxKm([-118.43, 34.2], EATON.bbox)).toBeGreaterThan(18)
    expect(distanceToBoxKm([-118.43, 34.2], EATON.bbox)).toBeLessThan(22)
    expect(centralBox([0, 0, 4, 2], [2, 1])).toEqual([1, 0.5, 3, 1.5])
  })

  it('candidates: ready bundles with a valid area only, once each', () => {
    const rows = [
      { id: 'a', bundle_status: 'ready' as const, bbox_lonlat: [-118, 34, -117.9, 34.1] as LonLatBox },
      { id: 'a', bundle_status: 'ready' as const, bbox_lonlat: [-118, 34, -117.9, 34.1] as LonLatBox },
      { id: 'b', bundle_status: 'none' as const, bbox_lonlat: null },
      { id: 'c', bundle_status: 'building' as const, bbox_lonlat: [-119, 34, -118.9, 34.1] as LonLatBox },
      { id: 'd', bundle_status: 'ready' as const, bbox_lonlat: null },
      { id: 'e', bundle_status: 'ready' as const, bbox_lonlat: [-118, 34, -118, 34.1] as LonLatBox },
    ]
    expect(focusCandidates(rows).map((f) => f.id)).toEqual(['a'])
  })
})

describe('focusTarget', () => {
  it('below FOCUS_OUT_ZOOM the map is the overview, even centred on a fire', () => {
    expect(focusTarget(view(-118.1, 34.2, 6.9), FIRES, cur(EATON))).toBeNull()
    expect(focusTarget(view(-118.1, 34.2, 5.2), FIRES, null)).toBeNull()
  })

  it('from FOCUS_IN_ZOOM the prepared fire meeting the central part, nearest the centre, is focused', () => {
    expect(focusTarget(view(-118.1, 34.2, FOCUS_IN_ZOOM), FIRES, null)).toBe('eaton')
    expect(focusTarget(view(-118.6, 34.08, 9.5), FIRES, null)).toBe('palisades')
    // between the two fires at a zoom wide enough to see both: the one nearer the centre
    const between = view(-118.36, 34.15, 8.6, 1.4)
    expect(nearestCentral(between, FIRES)?.id).toBe('palisades')
    expect(focusTarget(view(-118.25, 34.15, 8.6, 1.4), FIRES, null)).toBe('eaton')
    // a fire only at the edge of the view (not in its central part) is not focused
    const edge = view(-118.75, 34.2, 9.5)
    expect(boxesIntersect(EATON.bbox, edge.view)).toBe(true)
    expect(focusTarget(edge, [EATON], null)).toBeNull()
  })

  it('between the thresholds nothing new is focused, but the open fire stays', () => {
    const v = view(-118.1, 34.2, 8.0)
    expect(focusTarget(v, FIRES, null)).toBeNull()
    expect(focusTarget(v, FIRES, cur(EATON))).toBe('eaton')
  })

  it('hysteresis: zooming in and out around the thresholds never flaps', () => {
    let open: string | null = null
    const seq: [number, string | null][] = [
      [5.2, null],
      [8.0, null], // not yet: below FOCUS_IN_ZOOM
      [8.6, 'eaton'], // enter
      [8.2, 'eaton'], // stays above FOCUS_OUT_ZOOM
      [7.1, 'eaton'],
      [8.6, 'eaton'],
      [6.9, null], // leave
      [7.5, null], // no re-entry until FOCUS_IN_ZOOM
      [8.49, null],
      [8.5, 'eaton'],
    ]
    for (const [z, want] of seq) {
      open = focusTarget(view(-118.1, 34.2, z), FIRES, open ? cur(FIRES.find((f) => f.id === open) ?? null) : null)
      expect([z, open]).toEqual([z, want])
    }
    expect(FOCUS_OUT_ZOOM).toBeLessThan(FOCUS_IN_ZOOM)
  })

  it('panning: the open fire stays while in view; another prepared fire takes over only once the open one leaves the central part', () => {
    // Eaton open; a small pan west keeps it central
    expect(focusTarget(view(-118.35, 34.2, 9.0), FIRES, cur(EATON))).toBe('eaton')
    // Eaton only at the east edge of a narrow view, nothing else central: it stays while in view
    const edge = view(-118.38, 34.3, 9.0, 0.5)
    expect(boxesIntersect(EATON.bbox, edge.central)).toBe(false)
    expect(focusTarget(edge, FIRES, cur(EATON))).toBe('eaton')
    // further west: Palisades meets the central part, Eaton only the edge -> Palisades
    expect(focusTarget(view(-118.48, 34.15, 9.0, 0.8), FIRES, cur(EATON))).toBe('palisades')
    // the same view at z8 (no entry allowed) keeps Eaton while it is in view
    expect(focusTarget(view(-118.48, 34.15, 8.0, 0.8), FIRES, cur(EATON))).toBe('eaton')
    // Eaton out of view entirely, nothing central: back to the overview
    expect(focusTarget(view(-119.5, 35.5, 9.0), FIRES, cur(EATON))).toBeNull()
  })

  it('an open fire without an area (no bundle yet) stays while its reported point is in view', () => {
    const unbuilt = { id: 'cooley', bbox: null, point: [-123.2, 39.4] as [number, number] }
    expect(focusTarget(view(-123.21, 39.41, 10), FIRES, unbuilt)).toBe('cooley')
    expect(focusTarget(view(-122.0, 39.41, 10), FIRES, unbuilt)).toBeNull()
    // a prepared fire central in the view wins over an off-centre open point
    const near = { id: 'x', bbox: null, point: [-118.0, 34.1] as [number, number] }
    expect(focusTarget(view(-118.1, 34.2, 9.0, 0.4), FIRES, near)).toBe('eaton')
  })

  it('ties are deterministic', () => {
    const a: FocusFire = { id: 'b-fire', bbox: [-118.2, 34.1, -118.0, 34.3] }
    const b: FocusFire = { id: 'a-fire', bbox: [-118.2, 34.1, -118.0, 34.3] }
    expect(focusTarget(view(-118.1, 34.2, 10), [a, b], null)).toBe('a-fire')
    expect(focusTarget(view(-118.1, 34.2, 10), [b, a], null)).toBe('a-fire')
  })
})

describe('chipTargets (the "Spread not prepared yet" prompt)', () => {
  const rows = [
    { id: 'near', bundle_status: 'none' as const, lon: -121.73, lat: 36.22 },
    { id: 'near2', bundle_status: 'error' as const, lon: -121.70, lat: 36.24 },
    { id: 'near3', bundle_status: 'building' as const, lon: -121.75, lat: 36.21 },
    { id: 'edge', bundle_status: 'none' as const, lon: -121.2, lat: 36.22 },
    { id: 'ready', bundle_status: 'ready' as const, lon: -121.73, lat: 36.22 },
  ]
  it('only unprepared fires near the view centre, from CHIP_ZOOM, nearest first, at most CHIP_MAX', () => {
    expect(chipTargets(view(-121.73, 36.22, CHIP_ZOOM - 0.1), rows)).toEqual([])
    const ids = chipTargets(view(-121.73, 36.22, 10), rows)
    expect(ids).toHaveLength(CHIP_MAX)
    expect(ids[0]).toBe('near')
    expect(ids).not.toContain('ready')
    expect(ids).not.toContain('edge')
    expect(chipTargets(view(-121.73, 36.22, 10), rows, ['near'])).not.toContain('near')
  })
})

describe('focus candidates follow every list, not the overview filter', () => {
  const row = (over: Partial<IncidentSummary>): IncidentSummary => ({
    id: 'x',
    name: 'X Fire',
    mode: 'historical',
    year: 2026,
    calfire_uid: 'u',
    started_ms: 0,
    updated_ms: null,
    contained_ms: null,
    acres: 1000,
    percent_contained: 100,
    is_active: false,
    county: null,
    location: null,
    admin_unit: null,
    url: null,
    lat: 34.2,
    lon: -118.1,
    detections_24h: null,
    bundle_status: 'none',
    bundle_built_ms: null,
    bbox_lonlat: null,
    ...over,
  })
  // the real Eaton row: a prepared 2025 fire (only in the 2025 list)
  const eaton = row({ id: '2025-eaton-fire-dbfa57', name: 'Eaton Fire', year: 2025, lat: 34.20348, lon: -118.06915, bundle_status: 'ready', bundle_built_ms: 1, bbox_lonlat: EATON.bbox })
  const catalog = {
    live: [row({ id: '2026-henderson', mode: 'live', is_active: true, lat: 33.34, lon: -117.41, bundle_status: 'ready', bbox_lonlat: [-117.5, 33.27, -117.33, 33.42] })],
    season: [row({ id: '2026-other', lat: 36.2, lon: -121.7 })],
    historical: [eaton, row({ id: '2025-unbuilt', year: 2025, lat: 34.3, lon: -118.0 })],
  }

  it('filter = 2026 season, view over Altadena at z10: Eaton (a 2025 fire) is focused', () => {
    // the 2026 season markers do not include Eaton ...
    expect(overviewFires(catalog, 'season').map((s) => s.id)).not.toContain(eaton.id)
    // ... but every prepared fire can be focused
    const candidates = allFocusCandidates(catalog)
    expect(candidates.map((f) => f.id).sort()).toEqual(['2025-eaton-fire-dbfa57', '2026-henderson'])
    expect(focusTarget(view(-118.13, 34.19, 10), candidates, null)).toBe(eaton.id)
  })

  it('a fire in two lists counts once; unprepared fires and rows without an area are not candidates', () => {
    const dup = { ...catalog, season: [...catalog.season, catalog.live[0]] }
    expect(allFocusCandidates(dup).filter((f) => f.id === '2026-henderson')).toHaveLength(1)
    expect(allFocusCandidates(catalog).map((f) => f.id)).not.toContain('2025-unbuilt')
  })
})

// Showing an official area never changes the open fire (integration of MapFlyTo.source 'official', CONTRACT §13).
describe('official areas hold the focus', () => {
  // the real areas (2026 list rows' bbox_lonlat) and Cal OES's Orange County order listed near the Henderson Fire
  const HENDERSON: FocusFire = { id: '2026-henderson-fire-3e3dfe', bbox: [-117.5666, 33.2254, -117.3292, 33.4247] }
  const NORTE: FocusFire = { id: '2026-norte-fire-87ebb8', bbox: [-117.7447, 33.3962, -117.539, 33.5686] }
  const ZONE_CENTER: [number, number] = [-117.6497, 33.4814]
  const fires = [HENDERSON, NORTE]

  it('without the hold, fitting the Orange County zone (inside Norte) would focus Norte', () => {
    expect(focusTarget(view(ZONE_CENTER[0], ZONE_CENTER[1], 14.5), fires, cur(HENDERSON))).toBe(NORTE.id)
  })

  it('an official flight holds: Henderson stays open; the overview stays the overview', () => {
    const hold = new FocusHold()
    hold.flight('official')
    expect(hold.active).toBe(true)
    expect(focusUnlessHeld(view(ZONE_CENTER[0], ZONE_CENTER[1], 14.5), fires, cur(HENDERSON), hold)).toBe(HENDERSON.id)
    // zoomed far out by the fit (a statewide alert): no return to the overview either
    expect(focusUnlessHeld(view(-119.5, 37, 5.5), fires, cur(HENDERSON), hold)).toBe(HENDERSON.id)
    // on the overview, a zone fit over a prepared fire does not open it
    expect(focusUnlessHeld(view(ZONE_CENTER[0], ZONE_CENTER[1], 14.5), fires, null, hold)).toBe(null)
  })

  it('the next user move, another flight or a release ends the hold', () => {
    const hold = new FocusHold()
    hold.flight('official')
    hold.flight(undefined)
    expect(hold.active).toBe(false)
    expect(focusUnlessHeld(view(ZONE_CENTER[0], ZONE_CENTER[1], 14.5), fires, cur(HENDERSON), hold)).toBe(NORTE.id)
    hold.flight('official')
    hold.release()
    expect(hold.active).toBe(false)
    hold.flight(null)
    expect(hold.active).toBe(false)
  })
})

// Neighbouring fires: Henderson's and Norte's analysis areas overlap (integration check, decision 10 "panning switches
// the focus").
describe('switching between neighbouring prepared fires', () => {
  const HENDERSON: FocusFire = { id: '2026-henderson-fire-3e3dfe', bbox: [-117.5666, 33.2254, -117.3292, 33.4247] }
  const NORTE: FocusFire = { id: '2026-norte-fire-87ebb8', bbox: [-117.7447, 33.3962, -117.539, 33.5686] }
  const fires = [HENDERSON, NORTE]

  it('centring the view on Norte (outside Henderson\'s area) switches, although Henderson still meets the central part', () => {
    // the camera a user ends on after dragging from Henderson to Norte's reported location (z10.4)
    const v = view(-117.64, 33.48, 10.4)
    expect(boxesIntersect(HENDERSON.bbox, v.central)).toBe(true)
    expect(focusTarget(v, fires, cur(HENDERSON))).toBe(NORTE.id)
    // and back
    expect(focusTarget(view(-117.45, 33.33, 10.4), fires, cur(NORTE))).toBe(HENDERSON.id)
  })

  it('no flapping where the areas overlap: the open fire stays while the centre is inside its own area', () => {
    // a centre inside both areas (the overlap strip) keeps whichever is open
    const overlap = view(-117.553, 33.41, 10.4)
    expect(boxContains(HENDERSON.bbox, overlap.center) && boxContains(NORTE.bbox, overlap.center)).toBe(true)
    expect(focusTarget(overlap, fires, cur(HENDERSON))).toBe(HENDERSON.id)
    expect(focusTarget(overlap, fires, cur(NORTE))).toBe(NORTE.id)
    // a centre in neither area, near Henderson's edge: Henderson (open) stays
    expect(focusTarget(view(-117.31, 33.30, 10.4), fires, cur(HENDERSON))).toBe(HENDERSON.id)
  })
})
