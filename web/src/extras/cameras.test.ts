import { describe, expect, it } from 'vitest'
import { CAMERAS_SAMPLE } from './__fixtures__/samples'
import {
  azimuthLine,
  CAMERA_ICON_IDS,
  CAMERA_LAYERS,
  cameraDirections,
  cameraFeedItems,
  cameraLayerGroup,
  cameraLegend,
  cameraServiceText,
  cameraViewText,
  compassWord,
  distanceBearing,
  frameTimeText,
  sortCameras,
} from './cameras'
import type { CamerasResponse } from './types'

const COOLEY: [number, number] = [-123.192868, 38.827218]

describe('camera geometry', () => {
  it('draws a direction tick of the requested length and bearing', () => {
    for (const deg of [0, 74.6, 169.7, 292.4]) {
      const [a, b] = azimuthLine(-123.2174, 38.948601, deg, 2500)
      const { distanceM, bearingDeg } = distanceBearing(a, b)
      expect(distanceM).toBeCloseTo(2500, 0)
      expect(Math.abs(((bearingDeg - deg + 540) % 360) - 180)).toBeLessThan(0.05)
    }
  })

  it('names compass directions', () => {
    expect(compassWord(0)).toBe('N')
    expect(compassWord(169.7)).toBe('S')
    expect(compassWord(292.4)).toBe('WNW')
    expect(compassWord(-10)).toBe('N')
    expect(compassWord(359)).toBe('N')
  })

  it('only pan-tilt-zoom cameras that report a direction get a tick', () => {
    const fc = cameraDirections(CAMERAS_SAMPLE)
    expect(fc.features.map((f) => f.properties?.id).sort()).toEqual(['alertca:Axis-Hopland1', 'alertca:Axis-Sanel1'])
  })
})

describe('camera list, legend and feed', () => {
  it('lists wildfire cameras first, nearest first', () => {
    const items = sortCameras(CAMERAS_SAMPLE, COOLEY)
    expect(items.map((i) => i.feature.properties.id)).toEqual(['alertca:Axis-Sanel1', 'alertca:Axis-Hopland1', 'caltrans:d1:us101sofhoplandlookings'])
    expect(items[0].distanceM! / 1000).toBeGreaterThan(13)
    expect(items[0].distanceM! / 1000).toBeLessThan(15)
    expect(compassWord(items[0].bearingDeg!)).toBe('N')
  })

  it('shows nothing for past dates', () => {
    const past: CamerasResponse = { ...CAMERAS_SAMPLE, status: 'not_available_for_past_dates' }
    expect(sortCameras(past, COOLEY)).toEqual([])
    expect(cameraLayerGroup(past, null)).toBeNull()
    expect(cameraLegend(past)).toEqual([])
    expect(cameraFeedItems(past)).toEqual([])
  })

  it('builds icon, selection ring and direction layers', () => {
    const g = cameraLayerGroup(CAMERAS_SAMPLE, 'alertca:Axis-Sanel1')!
    expect(g.layers.map((l) => l.spec.id)).toEqual([CAMERA_LAYERS.dir, CAMERA_LAYERS.ring, CAMERA_LAYERS.icon])
    expect(g.layers.every((l) => l.placement === 'top')).toBe(true)
    expect(Object.keys(g.images ?? {}).sort()).toEqual(Object.values(CAMERA_ICON_IDS).sort())
    expect((g.layers[1].spec as { filter: unknown }).filter).toEqual(['==', ['get', 'id'], 'alertca:Axis-Sanel1'])
  })

  it('legend and the single summary feed item name both networks', () => {
    expect(cameraLegend(CAMERAS_SAMPLE).map((e) => e.label)).toEqual(['Wildfire camera (ALERTCalifornia)', 'Traffic camera (Caltrans)', 'Camera pointing direction'])
    const [item] = cameraFeedItems(CAMERAS_SAMPLE)
    expect(item).toMatchObject({ topic: 'camera', kind: 'observation', automated: true, seekable: false, location: null })
    expect(item.detail).toBe('2 wildfire cameras (ALERTCalifornia) and 1 traffic camera (Caltrans) in this area. Live images open only when you ask for one.')
  })
})

describe('camera texts', () => {
  const [sanel, , hopland101] = sortCameras(CAMERAS_SAMPLE, COOLEY).map((i) => i.feature)

  it('describes view and service state from the sources only', () => {
    expect(cameraViewText(sanel)).toBe('Pan-tilt-zoom; pointing S (170°) as last reported')
    expect(cameraViewText(hopland101)).toBe('Fixed view looking south')
    expect(cameraServiceText(hopland101)).toBe('In service · new image about every 10 min')
    expect(cameraServiceText(sanel)).toBeNull()
    expect(cameraServiceText({ ...hopland101, properties: { ...hopland101.properties, in_service: false } })).toBe('Out of service (Caltrans)')
  })

  it('labels the image time as the server clock and admits when it is missing', () => {
    const now = 1792268904262
    expect(frameTimeText({ image_time_ms: 1792268901000, retrieved_ms: now }, now)).toBe("Image updated Oct 17, 13:28 PDT (just now) by the camera server's clock")
    expect(frameTimeText({ image_time_ms: null, retrieved_ms: now - 120_000 }, now)).toBe('Image time not reported by the camera server (fetched 2 min ago)')
  })
})
