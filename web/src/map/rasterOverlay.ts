// One reprojected raster overlay (observed fire or forecast) as a MapLibre canvas source (owner: map-core).
// Per-source-pixel colours are gathered through the cached per-pixel mapping (lib/reproject.ts) into a canvas covering
// the snapped Mercator rectangle; the canvas source is static (animate: false) and only re-uploaded when the colours
// change: play()/pause() uploads the pixels, and re-setting the same coordinates reloads the source tile so 3D terrain
// re-drapes it (MapLibre caches draped tiles per source revision).
import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl'
import { gatherOverlay, type OverlayMapping } from '../lib/reproject'

export class RasterOverlay {
  readonly sourceId: string
  readonly layerId: string
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private mapping: OverlayMapping | null = null
  private image: ImageData | null = null
  private out32: Uint32Array | null = null

  constructor(sourceId: string, layerId: string) {
    this.sourceId = sourceId
    this.layerId = layerId
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1
    this.canvas.height = 1
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false })
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
  }

  get placement(): OverlayMapping | null {
    return this.mapping
  }

  /** Use a mapping (incident grid); returns true when the placement changed (the source must be re-added). */
  setMapping(m: OverlayMapping | null): boolean {
    if (m === this.mapping) return false
    this.mapping = m
    if (m) {
      this.canvas.width = m.width
      this.canvas.height = m.height
      this.image = this.ctx.createImageData(m.width, m.height)
      this.out32 = new Uint32Array(this.image.data.buffer)
    } else {
      this.canvas.width = 1
      this.canvas.height = 1
      this.image = null
      this.out32 = null
    }
    return true
  }

  /** Draw per-source-pixel RGBA colours (null clears the overlay). */
  draw(srcColors: Uint32Array | null): void {
    const m = this.mapping
    if (!m || !this.image || !this.out32) return
    if (srcColors && srcColors.length === m.srcWidth * m.srcHeight) gatherOverlay(m, srcColors, this.out32)
    else this.out32.fill(0)
    this.ctx.putImageData(this.image, 0, 0)
  }

  /** Add the canvas source to the current style (after every style load); false without a mapping. */
  addSource(map: MapLibreMap): boolean {
    const m = this.mapping
    if (!m) return false
    if (map.getSource(this.sourceId)) return true
    map.addSource(this.sourceId, { type: 'canvas', canvas: this.canvas, coordinates: m.coordinates, animate: false })
    return true
  }

  removeFrom(map: MapLibreMap): void {
    if (map.getLayer(this.layerId)) map.removeLayer(this.layerId)
    if (map.getSource(this.sourceId)) map.removeSource(this.sourceId)
  }

  /** Push the drawn pixels to the map (2D and draped 3D). */
  push(map: MapLibreMap): void {
    const m = this.mapping
    const src = map.getSource(this.sourceId) as CanvasSource | undefined
    if (!m || !src) return
    src.play()
    src.pause()
    src.setCoordinates(m.coordinates)
  }
}
