import { describe, expect, it } from 'vitest'
import { IMAGERY_SAMPLE } from './__fixtures__/samples'
import {
  cloudText,
  coverageText,
  IMAGERY_LAYER,
  IMAGERY_SOURCE,
  imageryAttribution,
  imageryFeedItems,
  imageryLayerGroup,
  imageryLegend,
  imagerySource,
  imageryTiming,
  pickDefaultImagery,
  productsByFamily,
  resolutionText,
  withGroupHeadings,
  platformText,
} from './imagery'
import type { ImageryProduct, ImageryResponse } from './types'
import { setCaliforniaCommandClock } from './__fixtures__/clock.testutil'

setCaliforniaCommandClock()

const byId = (id: string) => IMAGERY_SAMPLE.products.find((p) => p.id.startsWith(id))!
const S2 = 'sentinel-2:S2C_10SDJ_20261013'
const COOLEY_START = 1792195539000 // CAL FIRE "Started" of the Cooley Fire

describe('imagery sources for MapLibre', () => {
  it('uses the backend render as an image source at the bbox corners', () => {
    const src = imagerySource(byId(S2)) as { type: string; url: string; coordinates: number[][] }
    expect(src.type).toBe('image')
    expect(src.url).toMatch(/^\/api\/extras\/imagery\/sentinel2\.webp\?items=S2C_10SDJ_20261013_0_L2A,S2C_10SDH_20261013_0_L2A&bbox=/)
    expect(src.coordinates).toEqual([
      [-123.3528, 38.9559],
      [-123.0412, 38.9559],
      [-123.0412, 38.7125],
      [-123.3528, 38.7125],
    ])
  })

  it('uses GIBS tiles as a raster source limited to the area', () => {
    const src = imagerySource(byId('viirs:noaa20:true_color')) as { type: string; tiles: string[]; maxzoom: number; bounds: number[]; tileSize: number }
    expect(src).toMatchObject({ type: 'raster', maxzoom: 9, tileSize: 256, bounds: [-123.3528, 38.7125, -123.0412, 38.9559] })
    expect(src.tiles[0]).toBe('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-16/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg')
  })

  it('never displays a product that is not available yet', () => {
    const p: ImageryProduct = { ...byId('landsat:'), available: false, display: null, unavailable_reason: 'NASA GIBS has not published imagery for this date yet' }
    expect(imagerySource(p)).toBeNull()
    expect(imageryLayerGroup(p, 0.9)).toBeNull()
    expect(imageryLegend(p, IMAGERY_SAMPLE.reference_ms)).toEqual([])
  })

  it('puts the raster below the labels with the requested opacity', () => {
    const g = imageryLayerGroup(byId(S2), 0.7)!
    expect(Object.keys(g.sources)).toEqual([IMAGERY_SOURCE])
    expect(g.layers).toHaveLength(1)
    expect(g.layers[0].placement).toBe('below-labels')
    expect(g.layers[0].spec).toMatchObject({ id: IMAGERY_LAYER, type: 'raster', paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 } })
  })
})

describe('choosing and describing images', () => {
  it('prefers the newest clear high-resolution scene', () => {
    expect(pickDefaultImagery(IMAGERY_SAMPLE)?.id).toMatch(/^sentinel-2:S2C_10SDJ_20261013/)
    // Landsat 2026-10-04 is 100 % cloudy and S2 10-08 46 % cloudy: without the clear S2 pass, VIIRS true colour wins
    const noClear: ImageryResponse = { ...IMAGERY_SAMPLE, products: IMAGERY_SAMPLE.products.filter((p) => !p.id.startsWith(S2)) }
    expect(pickDefaultImagery(noClear)?.id).toBe('viirs:noaa20:true_color:2026-10-16')
    const goesOnly: ImageryResponse = { ...IMAGERY_SAMPLE, products: IMAGERY_SAMPLE.products.filter((p) => p.family === 'goes') }
    expect(pickDefaultImagery(goesOnly)?.family).toBe('goes')
    expect(pickDefaultImagery({ ...IMAGERY_SAMPLE, products: [] })).toBeNull()
  })

  it('prefers images of the fire (after its start), then full-coverage context from before it', () => {
    // Cooley started Oct 16, 17:05 PDT: every image in the sample is older -> full-coverage clear context scene
    expect(pickDefaultImagery(IMAGERY_SAMPLE, COOLEY_START)?.id).toMatch(/^sentinel-2:S2C_10SDJ_20261013/)
    // a start before the Oct 16 VIIRS passes but after the S2 scene: the VIIRS image shows the fire
    expect(pickDefaultImagery(IMAGERY_SAMPLE, Date.UTC(2026, 9, 16, 12))?.id).toBe('viirs:noaa20:true_color:2026-10-16')
    // a start before the clear S2 scene: that scene
    expect(pickDefaultImagery(IMAGERY_SAMPLE, Date.UTC(2026, 9, 12))?.id).toMatch(/^sentinel-2:S2C_10SDJ_20261013/)
    // context before the fire prefers covering the area over two days of recency; without a start, recency wins
    const full = byId(S2)
    const partial: ImageryProduct = { ...full, id: 'sentinel-2:partial', acquired_ms: full.acquired_ms + 2 * 86_400_000, acquired_end_ms: null, coverage_pct: 56 }
    const two: ImageryResponse = { ...IMAGERY_SAMPLE, products: [full, partial] }
    expect(pickDefaultImagery(two, full.acquired_ms + 5 * 86_400_000)?.id).toBe(full.id)
    expect(pickDefaultImagery(two)?.id).toBe('sentinel-2:partial')
    expect(pickDefaultImagery(two, full.acquired_ms + 86_400_000)?.id).toBe('sentinel-2:partial') // after the start
  })

  it('groups by sensor, newest first', () => {
    const g = productsByFamily(IMAGERY_SAMPLE)
    expect(g['sentinel-2'].map((p) => p.acquired_ms)).toEqual([...g['sentinel-2'].map((p) => p.acquired_ms)].sort((a, b) => b - a))
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length]))).toEqual({ 'sentinel-2': 2, landsat: 1, viirs: 1, goes: 1 })
  })

  it('states acquisition, relative time, before-the-fire and latency', () => {
    const ref = IMAGERY_SAMPLE.reference_ms
    const s2 = imageryTiming(byId(S2), ref, COOLEY_START, true)
    expect(s2.acquired).toBe('Acquired Oct 13, 12:13 PDT')
    expect(s2.relative).toBe('4 days ago')
    expect(s2.beforeFire).toBe(true)
    expect(s2.latency).toBe('Listed 3.8 h after acquisition')
    const replay = imageryTiming(byId(S2), ref, COOLEY_START, false)
    expect(replay.relative).toBe('4 days before the selected time')
    const viirs = imageryTiming(byId('viirs:noaa20:true_color'), ref, COOLEY_START, true)
    expect(viirs.acquired).toBe('Satellite passes Oct 16, 14:00 PDT and Oct 16, 14:06 PDT (combined daily image)')
    expect(viirs.beforeFire).toBe(true) // CAL FIRE start Oct 16, 17:05 PDT
    expect(imageryTiming(byId('viirs:noaa20:true_color'), ref, Date.UTC(2026, 9, 16, 12), true).beforeFire).toBe(false)
    expect(viirs.latency).toBe('Daily images appear about 3 hours after the satellite pass')
    const goes = imageryTiming(byId('goes-west'), ref, COOLEY_START, true)
    expect(goes.latency).toMatch(/^Newest frame was \d+ min old when checked$/)
    expect(imageryTiming(byId('landsat:'), ref, null, true).latency).toBe('Catalogued 30 h after acquisition')
  })

  it('does not present a re-processed catalogue entry as the first availability', () => {
    const p = byId(S2)
    const late: ImageryProduct = { ...p, published_ms: p.acquired_ms + 611 * 86_400_000, latency_ms: 611 * 86_400_000 }
    const t = imageryTiming(late, late.published_ms! + 86_400_000, null, false)
    expect(t.latency).toMatch(/^Catalogue entry created .+ \(611 days after acquisition\); an earlier version may have been available sooner$/)
    expect(t.listedAfterRef).toBe(false)
  })

  it('flags replay images that the source listed only after the selected time', () => {
    const p = byId(S2) // listed 3.8 h after acquisition
    const oneHourAfter = p.acquired_ms + 3_600_000
    expect(imageryTiming(p, oneHourAfter, null, false).listedAfterRef).toBe(true)
    expect(imageryTiming(p, p.published_ms! + 60_000, null, false).listedAfterRef).toBe(false)
    // live lists are for now: everything shown is already published
    expect(imageryTiming(p, oneHourAfter, null, true).listedAfterRef).toBe(false)
    // GOES frame age is not a listing time
    const goes = byId('goes-west')
    expect(imageryTiming({ ...goes, published_ms: goes.acquired_ms + 3_600_000 }, goes.acquired_ms + 60_000, null, false).listedAfterRef).toBe(false)
  })

  it('explains cloud, coverage and resolution limits', () => {
    expect(cloudText(byId('landsat:'))).toBe('100 % cloud cover (whole scene, not just this area)')
    expect(cloudText(byId('goes-west'))).toBe('Cloud cover not reported (clouds and smoke are visible in the image)')
    expect(coverageText(byId(S2))).toBe('Covers the whole area')
    expect(coverageText({ ...byId(S2), coverage_pct: 58.7 })).toBe('Covers 59 % of the area')
    expect(resolutionText(byId(S2))).toBe('10 m pixels')
    expect(resolutionText(byId('goes-west'))).toBe('About 1-2 km pixels')
    // a large area is rendered coarser than the sensor: say how it is shown
    const s2 = byId(S2)
    const coarse: ImageryProduct = { ...s2, display: { ...(s2.display as Extract<ImageryProduct['display'], { type: 'image' }>), pixel_m: 13.2 } }
    expect(resolutionText(coarse)).toBe('10 m pixels (shown at about 13 m over this area)')
    expect(resolutionText({ ...coarse, display: { ...(coarse.display as Extract<ImageryProduct['display'], { type: 'image' }>), pixel_m: 10 } })).toBe('10 m pixels')
  })
})

describe('legend, credits and feed', () => {
  it('labels the map layer as a satellite image with its acquisition time', () => {
    const [e] = imageryLegend(byId(S2), IMAGERY_SAMPLE.reference_ms)
    expect(e).toMatchObject({ layer: 'recentImagery', label: 'Satellite image · Sentinel-2C', swatch: { kind: 'raster' } })
    expect(e.detail).toBe('acquired Oct 13, 12:13 PDT · 10 m pixels · not live')
    expect(e.compact).toBe(`Satellite image · ${byId(S2).platform} · Oct 13, 12:13`)
  })

  it('credits Copernicus for Sentinel-2 and NASA GIBS for NASA imagery', () => {
    expect(imageryAttribution(byId(S2), IMAGERY_SAMPLE.sources).map((c) => c.text)).toEqual([
      'Contains modified Copernicus Sentinel data 2026 (Earth Search by Element 84)',
    ])
    expect(imageryAttribution(byId('viirs:'), IMAGERY_SAMPLE.sources).map((c) => c.id)).toEqual(['imagery-nasa_viirs', 'imagery-gibs'])
    expect(imageryAttribution(null, IMAGERY_SAMPLE.sources)).toEqual([])
  })

  it('feed items are satellite observations, seekable only on the incident timeline', () => {
    const range: [number, number] = [COOLEY_START - 3_600_000, IMAGERY_SAMPLE.reference_ms]
    const items = imageryFeedItems(IMAGERY_SAMPLE, range)
    expect(items.map((i) => i.title)).toEqual([
      'Satellite image acquired: Sentinel-2C (10 m)',
      'Satellite image acquired: Sentinel-2B (10 m)',
      'Satellite image acquired: Landsat 8/9 (30 m)',
    ])
    expect(items.every((i) => i.topic === 'imagery' && i.kind === 'observation' && i.automated && i.location === null)).toBe(true)
    expect(items.every((i) => !i.seekable)).toBe(true) // all acquired before the fire's timeline
    const wide = imageryFeedItems(IMAGERY_SAMPLE, [0, Date.UTC(2030, 0)])
    expect(wide.every((i) => i.seekable)).toBe(true)
    expect(imageryFeedItems({ ...IMAGERY_SAMPLE, status: 'unavailable' }, range)).toEqual([])
    // with the fire start known, scenes from before the fire are context, not updates
    expect(imageryFeedItems(IMAGERY_SAMPLE, range, COOLEY_START)).toEqual([])
    expect(imageryFeedItems(IMAGERY_SAMPLE, range, Date.UTC(2026, 9, 9)).map((i) => i.title)).toEqual(['Satellite image acquired: Sentinel-2C (10 m)'])
  })
})

describe('imagery labels from each product\'s platform (brief 3, W13)', () => {
  it('a GOES product is named by its own platform, never a fixed GOES-West', () => {
    const goes = IMAGERY_SAMPLE.products.find((p) => p.family === 'goes')!
    const east = { ...goes, id: 'goes-east-x', platform: 'GOES-East' }
    const rows = withGroupHeadings([east], east.acquired_ms + 3_600_000, null, true)
    expect(rows[0].heading).toBe('GOES-East: every 10 min, 1-2 km pixels')
    expect(platformText(east)).toBe('GOES-East')
  })
})
