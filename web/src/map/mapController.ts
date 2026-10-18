// The Public/Command map engine (owner: map-core; CONTRACT §4). One MapLibre map serves 2D (top-down, north-up by
// default) and 3D (Mapterhorn terrain + oblique camera). MapLibre owns the camera, terrain, navigation and tile
// streaming; this class only reacts to state:
//   useWorkspace  basemap, perspective, selection, mapFlyTo, mapLayers, safeInsets   -> style / camera / pin / layers
//   useStore      incident + manifest, forecast run, timeMs, bundle JSON, flyTo (x/z) -> overlays / camera
//   useMapRuntime forecastView                                                        -> forecast overlay
// Overlays are recomputed only when one of their inputs changes (coalesced to <= ~9 updates/s while playing, and
// skipped when the shown pixel sets are unchanged), never per frame. Basemap switches reload the style and re-add
// every overlay from the cached data, so overlays, timeline, selection and credits survive them.
import { Map as MapLibreMap, Popup, type GeoJSONSource, type MapGeoJSONFeature, type MapMouseEvent, type MapSourceDataEvent, type StyleSpecification } from 'maplibre-gl'
import type { ForecastLayerName, ForecastManifest, IncidentManifest, IncidentSummary } from '../api/types'
import { HOUR_MS, loadRasterSet, type LoadedLayer, type RasterSet } from '../data/rasters'
import { aoiCornersLonLat, localToLonLat, overlayMapping } from '../lib/reproject'
import { fmtDateTimeTz } from '../lib/time'
import { useAnnotations } from '../state/annotations'
import { useStore } from '../state/store'
import { incidentFlyTo, useWorkspace, type Basemap, type MapFlyTo, type MapLayerKey, type Perspective, type SafeInsets } from '../state/workspace'
import { buildFeedItems, selectFeedItem } from '../ui/feed/feedModel'
import type { FeedItem } from '../ui/feed/types'
import { HILLSHADE_SOURCE, IMAGERY_SOURCE, loadBasemap, TERRAIN_SOURCE, VECTOR_SOURCE, type DerivedStyle } from './basemapStyle'
import { maskGeometry } from './contours'
import { drapedLayers, HATCH_IMAGE, hatchImage, LAYER_GROUPS, LYR, SRC, topLayers, type MapTheme } from './layers'
import { fmtLatLon, SelectionPin } from './markers'
import { EMPTY_OVERLAYS, motionMs, patchOverlays, setProvider, useMapRuntime } from './mapStore'
import {
  aoiFeatures,
  burnedByMask,
  classMask,
  detectionFeatures,
  EMPTY,
  eventFeatures,
  footprintM,
  forecastClasses,
  forecastFrame,
  forecastPixels,
  lines,
  observedPixels,
  perimeterFeatures,
  polygons,
  type FeatureCollection,
  type ForecastArrays,
  type MapEvent,
} from './overlayModel'
import { BASEMAP_STYLE, devProviderFailures, OPENFREEMAP_GLYPHS, UNREACHABLE } from './providers'
import { RasterOverlay } from './rasterOverlay'
import { bindExtrasLayers, EXTRAS_HOVER_LAYERS, type ExtrasLayers } from './extrasLayers'
import { cameraViewText } from '../extras/cameras'
import { zoneDetail } from '../extras/evacuation'
import { useExtrasRuntime } from '../extras/runtime'
import { KIND_META } from '../ui/feed/feedMeta'

const CALIFORNIA: [number, number] = [-119.4, 37.2]
const MAX_PITCH_3D = 80
const PITCH_3D = 58
const MIN_INTERVAL_MS = 110
const FORECAST_LAYERS: ForecastLayerName[] = ['arrival_p10', 'arrival_p50', 'arrival_p90', 'burn_probability']
/** Tile errors with no successful tile before a provider counts as unavailable (single 404s at coverage edges are
 *  normal for terrain). */
const FAIL_AFTER = 4

/** Update counters for verification (window.__mapStats): how often overlays were recomputed and how long it took.
 *  Development builds only: every use sits behind import.meta.env.DEV, which production builds compile out. */
const mapStats = { runs: 0, rasterDraws: 0, vectorSets: 0, lastRunMs: 0, maxRunMs: 0, totalRunMs: 0 }
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __mapStats: typeof mapStats }).__mapStats = mapStats

interface Buffers {
  n: number
  obsColors: Uint32Array
  obsMask: Uint8Array
  classes: Uint8Array
  fcColors: Uint32Array
  startBurned: Uint8Array
  tmp: Uint8Array
}

type ProviderKey = 'vector' | 'imagery' | 'terrain'

const readyManifest = (m: IncidentManifest | null): IncidentManifest | null => (m && m.status === 'ready' ? m : null)

function initialStyle(): StyleSpecification {
  return { version: 8, glyphs: OPENFREEMAP_GLYPHS, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1119' } }] }
}

/** Point the providers listed in the dev-only ?mapfail= at an unreachable host (compiled out of production). */
function applyDevFailures(d: DerivedStyle, fail: Set<string>): DerivedStyle {
  if (!import.meta.env.DEV || !fail.size) return d
  const s = d.style
  for (const [id, src] of Object.entries(s.sources)) {
    const bad = (fail.has('vector') && id === VECTOR_SOURCE) || (fail.has('imagery') && id === IMAGERY_SOURCE) || (fail.has('terrain') && (id === TERRAIN_SOURCE || id === HILLSHADE_SOURCE))
    if (!bad) continue
    const o = src as { url?: string; tiles?: string[] }
    if (o.url) o.url = `${UNREACHABLE}/tiles.json`
    if (o.tiles) o.tiles = [`${UNREACHABLE}/{z}/{x}/{y}`]
  }
  return d
}

export class MapController {
  readonly map: MapLibreMap
  private readonly unsubs: Array<() => void> = []
  private readonly observed = new RasterOverlay(SRC.observedRaster, LYR.observedRaster)
  private readonly forecast = new RasterOverlay(SRC.forecastRaster, LYR.forecastRaster)
  private readonly pin = new SelectionPin()
  private readonly popup: Popup
  private readonly devFail = devProviderFailures()
  private derived: DerivedStyle | null = null
  private basemapSeq = 0
  private styleReady = false
  private rasters: RasterSet | null = null
  private rasterKey = ''
  private bufs: Buffers | null = null
  private flyNonce: number
  private localNonce: number
  private framed: boolean
  private timer: number | undefined
  private lastRun = 0
  private dirty = { observed: true, forecast: true, vectors: true, statics: true }
  private keys = { obs: '', fc: '', det: '', perim: '', ev: '' }
  private feed = new Map<string, FeedItem>()
  private tiles: Record<ProviderKey, { ok: number; err: number }> = { vector: { ok: 0, err: 0 }, imagery: { ok: 0, err: 0 }, terrain: { ok: 0, err: 0 } }
  private terrainBroken = false
  private destroyed = false
  private moveRaf = 0
  /** The programmatic camera move in progress (restarted when the safe area changes mid-flight). */
  private activeFly: { req: Omit<MapFlyTo, 'nonce'>; animate: boolean } | null = null
  private pendingPadding = false
  private hoverRaf = 0
  private lastHover: { x: number; y: number } | null = null
  /** Optional sources (imagery, evacuation zones, cameras): mounted after map-core's own style handling. */
  private readonly extras: ExtrasLayers

  constructor(container: HTMLElement) {
    const ws = useWorkspace.getState()
    const st = useStore.getState()
    const v = ws.view
    const is3d = ws.perspective === '3d'
    this.map = new MapLibreMap({
      container,
      style: initialStyle(),
      center: v ? [v.centerLon, v.centerLat] : st.summary ? [st.summary.lon, st.summary.lat] : CALIFORNIA,
      zoom: v ? v.zoom : st.summary ? 11 : 5,
      bearing: v?.bearing ?? 0,
      pitch: is3d ? (v && v.pitch > 0 ? v.pitch : PITCH_3D) : 0,
      maxPitch: is3d ? MAX_PITCH_3D : 0,
      maxZoom: 18.5,
      attributionControl: false,
      fadeDuration: 120,
      validateStyle: import.meta.env.DEV,
      canvasContextAttributes: { antialias: true },
    })
    this.map.getCanvas().setAttribute('aria-label', 'Map. Arrow keys pan, plus and minus zoom; click to select a location.')
    this.popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fxm-popup', maxWidth: '300px', offset: 12 })
    this.flyNonce = ws.mapFlyTo?.nonce ?? 0
    this.localNonce = st.flyTo?.nonce ?? 0
    this.framed = v != null
    useMapRuntime.setState({ map: this.map, overlays: EMPTY_OVERLAYS, aoiInView: null, terrainOn: false })

    this.bindMapEvents()
    this.subscribe()
    this.extras = bindExtrasLayers(this.map)
    // the safe area is the map's persistent padding: centring and framing use the visible part of the map
    this.applySafeInsets(false)
    if (!this.framed) this.frameIncident(false)
    void this.applyBasemap(ws.basemap)
    this.loadRasters()
    this.updateCamera()
  }

  destroy(): void {
    this.destroyed = true
    for (const u of this.unsubs) u()
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    cancelAnimationFrame(this.moveRaf)
    cancelAnimationFrame(this.hoverRaf)
    this.popup.remove()
    this.pin.remove()
    this.extras.destroy()
    this.map.remove()
    useMapRuntime.setState({ map: null, camera: null, terrainOn: false, aoiInView: null })
  }

  // ------------------------------------------------------------------------------------------------ subscriptions
  private subscribe(): void {
    this.unsubs.push(
      useWorkspace.subscribe((s, p) => {
        if (s.basemap !== p.basemap) void this.applyBasemap(s.basemap)
        if (s.perspective !== p.perspective) this.applyPerspective(s.perspective, true)
        if (s.selection !== p.selection || s.mapLayers.selection !== p.mapLayers.selection) this.updatePin()
        if (s.mapFlyTo && s.mapFlyTo.nonce !== this.flyNonce) {
          this.flyNonce = s.mapFlyTo.nonce
          // a requested target (search, return to incident) is the user's choice: data arriving later keeps it
          this.framed = true
          this.fly(s.mapFlyTo)
        }
        if (s.mapLayers !== p.mapLayers) this.applyLayerVisibility(p.mapLayers)
        if (s.safeInsets !== p.safeInsets) this.applySafeInsets(true)
      }),
    )
    this.unsubs.push(
      useStore.subscribe((s, p) => {
        if (s.flyTo && s.flyTo.nonce !== this.localNonce) {
          this.localNonce = s.flyTo.nonce
          if (s.manifest) {
            const [lon, lat] = localToLonLat(s.flyTo.x, s.flyTo.z, s.manifest.grid)
            this.framed = true
            this.fly({ lon, lat })
          }
        }
        const newIncident = s.incidentId !== p.incidentId
        if (newIncident) {
          this.framed = false
          this.feed.clear()
        }
        const manifestChanged = s.manifest !== p.manifest
        if (newIncident || manifestChanged || (s.summary !== p.summary && !this.framed)) {
          if (!this.framed) this.frameIncident(true)
        }
        if (manifestChanged || s.forecast !== p.forecast) this.loadRasters()
        if (manifestChanged || s.summary !== p.summary) this.markDirty('statics')
        if (s.timeMs !== p.timeMs) this.markDirty('observed', 'forecast', 'vectors')
        if (s.perimeters !== p.perimeters || s.detections !== p.detections || s.events !== p.events || s.selectedEventId !== p.selectedEventId) {
          this.keys.det = this.keys.perim = this.keys.ev = ''
          this.markDirty('vectors')
        }
      }),
    )
    this.unsubs.push(
      useMapRuntime.subscribe((s, p) => {
        if (s.forecastView !== p.forecastView) {
          this.keys.fc = ''
          this.markDirty('forecast')
        }
      }),
    )
    this.unsubs.push(
      useAnnotations.subscribe((s, p) => {
        if (s.byIncident !== p.byIncident) {
          this.keys.ev = ''
          this.markDirty('vectors')
        }
      }),
    )
  }

  // ------------------------------------------------------------------------------------------------ style
  private async applyBasemap(basemap: Basemap): Promise<void> {
    const seq = ++this.basemapSeq
    const url = import.meta.env.DEV && this.devFail.has('basemap') ? `${UNREACHABLE}/style.json` : BASEMAP_STYLE[basemap]
    const derived = applyDevFailures(await loadBasemap(basemap, url), this.devFail)
    if (this.destroyed || seq !== this.basemapSeq) return
    this.derived = derived
    setProvider('basemap', derived.vector ? 'ok' : 'failed', derived.vector ? null : 'OpenFreeMap style did not load')
    setProvider('imagery', 'idle')
    this.tiles = { vector: { ok: 0, err: 0 }, imagery: { ok: 0, err: 0 }, terrain: { ok: 0, err: 0 } }
    setProvider('vector', 'idle')
    if (!this.terrainBroken) setProvider('terrain', 'idle')
    this.styleReady = false
    // MapLibre draws terrain depth against the incoming style before that style has its projection, which throws when
    // the camera moves during the swap (a pan, or the 2D pitch-down). Drop terrain for the swap; onStyleLoad turns it
    // back on in 3D.
    if (this.map.getTerrain()) this.map.setTerrain(null)
    this.map.setStyle(derived.style, { diff: false })
  }

  private onStyleLoad(): void {
    const map = this.map
    if (!this.derived) {
      // the initial placeholder style: nothing to add yet
      return
    }
    this.styleReady = true
    if (!map.hasImage(HATCH_IMAGE)) map.addImage(HATCH_IMAGE, hatchImage(), { pixelRatio: 2 })
    const empty = (id: string) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY as never, tolerance: 0.2 })
    }
    for (const id of [SRC.observedEdge, SRC.forecastLines, SRC.forecastHatch, SRC.perimeters, SRC.detections, SRC.detectionPoints, SRC.aoi, SRC.aoiLabels, SRC.events, SRC.incident]) empty(id)
    const before = this.derived.labelLayerId ?? undefined
    const theme = this.theme()
    // rasters (only with a placement), then the other draped layers, all below the labels
    this.observed.addSource(map)
    this.forecast.addSource(map)
    for (const layer of drapedLayers(theme)) {
      if ((layer.id === LYR.observedRaster && !map.getSource(SRC.observedRaster)) || (layer.id === LYR.forecastRaster && !map.getSource(SRC.forecastRaster))) continue
      map.addLayer(layer, before)
    }
    for (const layer of topLayers(theme)) map.addLayer(layer)
    this.applyLayerVisibility(null)
    if (useWorkspace.getState().perspective === '3d') this.enableTerrain()
    else useMapRuntime.setState({ terrainOn: false })
    // everything is re-pushed from the cached data
    this.keys = { obs: '', fc: '', det: '', perim: '', ev: '' }
    this.markDirty('observed', 'forecast', 'vectors', 'statics')
    this.updatePin()
  }

  /** Our labels and lines use dark ink on the light road map, light ink on the dark and aerial basemaps. */
  private theme(): MapTheme {
    return useWorkspace.getState().basemap === 'roads' && this.derived?.vector !== false ? 'light' : 'dark'
  }

  /** Re-create the raster sources after the incident grid (placement) changed. */
  private reattachRaster(o: RasterOverlay): void {
    if (!this.styleReady || !this.derived) return
    const map = this.map
    o.removeFrom(map)
    if (!o.addSource(map)) return
    const order = drapedLayers(this.theme())
    const i = order.findIndex((l) => l.id === o.layerId)
    if (i < 0) return
    // keep the declared stacking order: insert below the next draped layer that exists, else below the labels
    const next = order.slice(i + 1).find((l) => map.getLayer(l.id))
    map.addLayer(order[i], next?.id ?? this.derived.labelLayerId ?? undefined)
    this.applyLayerVisibility(null)
  }

  private setData(id: string, fc: FeatureCollection): void {
    const src = this.map.getSource(id) as GeoJSONSource | undefined
    src?.setData(fc as never)
    if (import.meta.env.DEV) mapStats.vectorSets++
  }

  private applyLayerVisibility(prev: Record<MapLayerKey, boolean> | null): void {
    if (!this.styleReady) return
    const layers = useWorkspace.getState().mapLayers
    for (const [key, ids] of Object.entries(LAYER_GROUPS) as [keyof typeof LAYER_GROUPS, readonly string[]][]) {
      if (prev && prev[key] === layers[key]) continue
      for (const id of ids) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', layers[key] ? 'visible' : 'none')
      if (!prev) continue
      // the forecast leaves out what the observed layer shows, so it follows the observed layer both ways
      if (key === 'observed') this.markDirty('observed', 'forecast')
      else if (layers[key]) this.markDirty(key === 'forecast' ? 'forecast' : 'vectors')
    }
    if (prev && prev.selection !== layers.selection) this.updatePin()
  }

  // ------------------------------------------------------------------------------------------------ camera
  private frameIncident(animate: boolean): void {
    const s = useStore.getState()
    const req = incidentFlyTo(s.summary, readyManifest(s.manifest))
    if (!req) return
    // set first: an instant move ends synchronously and its view is then worth keeping
    this.framed = req.bounds != null
    this.fly(req, animate)
  }

  private padding(): SafeInsets {
    const i = useWorkspace.getState().safeInsets
    const c = this.map.getContainer()
    // never let the chrome padding swallow the whole map (narrow screens)
    const maxH = Math.max(0, c.clientWidth - 120)
    const maxV = Math.max(0, c.clientHeight - 120)
    const h = i.left + i.right > maxH ? maxH / Math.max(1, i.left + i.right) : 1
    const v = i.top + i.bottom > maxV ? maxV / Math.max(1, i.top + i.bottom) : 1
    return { top: i.top * v, bottom: i.bottom * v, left: i.left * h, right: i.right * h }
  }

  /** Fly to bounds (fitted inside the safe area plus a margin) or to a point (centred in the safe area). */
  private fly(f: Omit<MapFlyTo, 'nonce'>, animate = true): void {
    const duration = animate ? motionMs(1100) : 0
    if (f.bounds) {
      const [w, s, e, n] = f.bounds
      // the persistent padding (safe insets) already applies; this only adds a margin around the bounds
      this.map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 28, duration, maxZoom: 15, bearing: this.map.getBearing() },
      )
    } else {
      const zoom = f.zoom ?? Math.max(this.map.getZoom(), 13)
      this.map.easeTo({ center: [f.lon, f.lat], zoom, duration })
    }
    // remembered after the call: starting a move ends the previous one, whose moveend clears activeFly
    this.activeFly = duration > 0 && this.map.isMoving() ? { req: f, animate } : null
  }

  /** Keep the map padding equal to the safe area. A programmatic flight in progress restarts toward the same target
   *  with the new padding; during a user gesture the change waits for the gesture to end. */
  private applySafeInsets(animate: boolean): void {
    const padding = this.padding()
    if (this.map.isMoving()) {
      const f = this.activeFly
      if (f) {
        this.map.setPadding(padding)
        this.fly(f.req, f.animate)
      } else this.pendingPadding = true
      return
    }
    this.map.easeTo({ padding, duration: animate ? motionMs(250) : 0 })
  }

  private applyPerspective(p: Perspective, animate: boolean): void {
    const map = this.map
    const duration = animate ? motionMs(900) : 0
    if (p === '3d') {
      map.setMaxPitch(MAX_PITCH_3D)
      this.enableTerrain()
      map.easeTo({ pitch: Math.max(map.getPitch(), PITCH_3D), duration })
    } else {
      map.easeTo({ pitch: 0, bearing: 0, duration })
      const done = () => {
        if (useWorkspace.getState().perspective !== '2d' || this.destroyed) return
        map.setTerrain(null)
        map.setMaxPitch(0)
        useMapRuntime.setState({ terrainOn: false })
      }
      if (duration === 0) done()
      else map.once('moveend', done)
    }
  }

  private enableTerrain(): void {
    if (this.terrainBroken || !this.styleReady || !this.map.getSource(TERRAIN_SOURCE)) {
      useMapRuntime.setState({ terrainOn: false })
      return
    }
    this.map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 })
    useMapRuntime.setState({ terrainOn: true })
  }

  private updateCamera(): void {
    const c = this.map.getCenter()
    useMapRuntime.setState({ camera: { lon: c.lng, lat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() } })
  }

  private onMoveEnd(byUser: boolean): void {
    this.activeFly = null
    // the user took the camera: never re-frame the incident over their view
    if (byUser) this.framed = true
    if (this.pendingPadding) {
      this.pendingPadding = false
      this.applySafeInsets(false)
    }
    // Keep only views worth restoring (incident framed, view restored, user moves). The placeholder view before the
    // incident data arrives is not one: restored on the next mount it would stop the incident from being framed.
    if (this.framed) {
      const c = this.map.getCenter()
      useWorkspace.getState().setView({ centerLon: c.lng, centerLat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() })
    }
    this.updateCamera()
    this.updateAoiInView()
  }

  private updateAoiInView(): void {
    const m = readyManifest(useStore.getState().manifest)
    if (!m) {
      if (useMapRuntime.getState().aoiInView !== null) useMapRuntime.setState({ aoiInView: null })
      return
    }
    const b = this.map.getBounds()
    const corners = aoiCornersLonLat(m.grid)
    const lons = corners.map((p) => p[0])
    const lats = corners.map((p) => p[1])
    const inView = !(Math.max(...lons) < b.getWest() || Math.min(...lons) > b.getEast() || Math.max(...lats) < b.getSouth() || Math.min(...lats) > b.getNorth())
    if (useMapRuntime.getState().aoiInView !== inView) useMapRuntime.setState({ aoiInView: inView })
  }

  // ------------------------------------------------------------------------------------------------ map events
  private bindMapEvents(): void {
    const map = this.map
    map.on('style.load', () => this.onStyleLoad())
    map.on('move', () => {
      if (this.moveRaf) return
      this.moveRaf = requestAnimationFrame(() => {
        this.moveRaf = 0
        this.updateCamera()
      })
    })
    map.on('moveend', (e: { originalEvent?: unknown }) => this.onMoveEnd(e.originalEvent != null))
    map.on('click', (e) => this.onClick(e))
    map.on('mousemove', (e) => this.onHover(e))
    map.on('mouseout', () => this.hideHover())
    map.on('styleimagemissing', (e: { id: string }) => {
      if (map.hasImage(e.id)) return
      // OpenFreeMap's styles reference a few images their sprite lacks ('circle-11' for town dots)
      if (e.id === 'circle-11') {
        const s = 11
        const data = new Uint8Array(s * s * 4)
        for (let y = 0; y < s; y++)
          for (let x = 0; x < s; x++) {
            const d = Math.hypot(x - 5, y - 5)
            const i = (y * s + x) * 4
            const inner = d <= 3.2
            const a = d <= 4.6 ? 1 : Math.max(0, 5.4 - d)
            data[i] = data[i + 1] = data[i + 2] = inner ? 215 : 12
            data[i + 3] = Math.round(a * 230)
          }
        map.addImage(e.id, { width: s, height: s, data })
      } else map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
    })
    map.on('sourcedata', (e: MapSourceDataEvent) => {
      if (!e.tile || !e.sourceId) return
      const k = this.providerOf(e.sourceId)
      if (!k) return
      this.tiles[k].ok++
      if (k !== 'terrain' || !this.terrainBroken) setProvider(k, 'ok')
    })
    map.on('error', (e: { error?: Error; sourceId?: string; tile?: unknown }) => {
      const k = e.sourceId ? this.providerOf(e.sourceId) : null
      if (!k) {
        // style / layer / overlay errors are bugs: keep them visible (a listener stops MapLibre's own logging)
        console.error(e.error ?? e)
        return
      }
      // a source error without a tile is its TileJSON failing: the provider is unavailable as a whole
      if (!e.tile) {
        this.providerFailed(k)
        return
      }
      const t = this.tiles[k]
      t.err++
      if (t.ok === 0 && t.err >= FAIL_AFTER) this.providerFailed(k)
    })
  }

  private providerOf(sourceId: string): ProviderKey | null {
    if (sourceId === VECTOR_SOURCE) return 'vector'
    if (sourceId === IMAGERY_SOURCE) return 'imagery'
    if (sourceId === TERRAIN_SOURCE || sourceId === HILLSHADE_SOURCE) return 'terrain'
    return null
  }

  private providerFailed(k: ProviderKey): void {
    if (k === 'vector') setProvider('vector', 'failed', 'OpenFreeMap vector tiles are not loading')
    else if (k === 'imagery') setProvider('imagery', 'failed', 'USGS imagery tiles are not loading')
    else {
      setProvider('terrain', 'failed', 'Mapterhorn terrain tiles are not loading')
      if (!this.terrainBroken) {
        this.terrainBroken = true
        // keep a usable flat map: drop terrain (the camera keeps its pitch in 3D) and the shading layer
        this.map.setTerrain(null)
        useMapRuntime.setState({ terrainOn: false })
      }
    }
  }

  private onClick(e: MapMouseEvent): void {
    const map = this.map
    const present = (ids: readonly string[]) => ids.filter((id) => map.getLayer(id))
    // a camera icon opens that camera (extras/cameras.ts handles the click); it never selects a location
    const camLayers = present(EXTRAS_HOVER_LAYERS.cameras)
    if (camLayers.length && map.queryRenderedFeatures(e.point, { layers: camLayers }).length) return
    const evLayers = present([LYR.eventsCircle])
    const hit = evLayers.length ? map.queryRenderedFeatures(e.point, { layers: evLayers }) : []
    const eid = hit[0]?.properties?.eid as string | undefined
    const item = eid ? this.feed.get(eid) : undefined
    if (item) {
      selectFeedItem(item)
      return
    }
    // inside an official zone the point is selected as usual (the card lists the zone) and the zone is highlighted
    const zoneLayers = present(EXTRAS_HOVER_LAYERS.zones)
    const zid = zoneLayers.length ? map.queryRenderedFeatures(e.point, { layers: zoneLayers })[0]?.properties?.id : undefined
    useExtrasRuntime.getState().setZoneId(typeof zid === 'string' ? zid : null)
    useWorkspace.getState().selectLocation({ lat: e.lngLat.lat, lon: e.lngLat.lng, source: 'click' })
  }

  private hideHover(): void {
    this.popup.remove()
    this.map.getCanvas().style.cursor = ''
  }

  private onHover(e: MapMouseEvent): void {
    this.lastHover = { x: e.point.x, y: e.point.y }
    if (this.hoverRaf) return
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0
      const p = this.lastHover
      if (!p || this.destroyed || !this.styleReady) return
      const map = this.map
      const cams = EXTRAS_HOVER_LAYERS.cameras
      const zones = EXTRAS_HOVER_LAYERS.zones
      const ids = [
        LYR.eventsCircle,
        ...cams,
        LYR.incidentCircle,
        LYR.detectionsFill,
        LYR.detectionsLine,
        LYR.detectionsGoes,
        LYR.detectionsDot,
        LYR.perimetersLatest,
        LYR.perimetersOld,
        ...zones,
      ].filter((id) => map.getLayer(id))
      const feats = map.queryRenderedFeatures([p.x, p.y], { layers: ids })
      // an event marker wins over what lies beneath it, as for clicks (onClick selects the event); then a camera
      // icon; an evacuation zone (a large area) only when nothing else is under the pointer
      const f =
        feats.find((x) => x.layer.id === LYR.eventsCircle) ?? feats.find((x) => cams.includes(x.layer.id)) ?? feats.find((x) => !zones.includes(x.layer.id)) ?? feats[0]
      if (!f) {
        this.hideHover()
        return
      }
      map.getCanvas().style.cursor = f.layer.id === LYR.eventsCircle || cams.includes(f.layer.id) ? 'pointer' : ''
      const content = this.hoverContent(f)
      if (!content) {
        this.hideHover()
        return
      }
      this.popup.setDOMContent(content).setLngLat(map.unproject([p.x, p.y]))
      if (!this.popup.isOpen()) this.popup.addTo(map)
    })
  }

  private hoverContent(f: MapGeoJSONFeature): HTMLElement | null {
    const p = f.properties ?? {}
    const units = useWorkspace.getState().units
    const tMs = useStore.getState().timeMs
    const el = document.createElement('div')
    el.className = 'fxm-tip'
    const line = (text: string, cls?: string) => {
      const d = document.createElement('div')
      if (cls) d.className = cls
      d.textContent = text
      el.append(d)
    }
    if (EXTRAS_HOVER_LAYERS.cameras.includes(f.layer.id)) {
      const cam = useExtrasRuntime.getState().cams.data?.cameras.features.find((c) => c.properties.id === p.id)
      line(String(p.name ?? 'Public camera'), 'fxm-tip-title')
      line(p.kind === 'traffic' ? 'Traffic camera (Caltrans)' : 'Wildfire camera (ALERTCalifornia | UC San Diego)')
      if (cam) line(cameraViewText(cam))
      if (p.out === true || p.out === 'true') line('Out of service (Caltrans)')
      line('Click to open it; an image loads only when you ask', 'fxm-tip-hint')
      return el
    }
    if (EXTRAS_HOVER_LAYERS.zones.includes(f.layer.id)) {
      const zone = useExtrasRuntime.getState().evac.data?.zones.features.find((z) => z.id === p.id)
      if (!zone) return null
      const d = zoneDetail(zone, Date.now())
      line(d.status, 'fxm-tip-title')
      line(d.title)
      line(`${d.jurisdiction} · ${d.updatedText}`)
      line('Official status from local officials via Cal OES. Fire-3d forecasts are not evacuation instructions.', 'fxm-tip-hint')
      return el
    }
    switch (f.layer.id) {
      case LYR.eventsCircle: {
        const item = this.feed.get(String(p.eid))
        line(String(p.title ?? 'Event'), 'fxm-tip-title')
        if (item) line(`${fmtDateTimeTz(item.tMs)} · ${KIND_META[item.kind].label.toLowerCase()} · ${item.source}`)
        line('Click to select this update', 'fxm-tip-hint')
        break
      }
      case LYR.incidentCircle: {
        line(String(p.name ?? 'Incident'), 'fxm-tip-title')
        line('Reported incident location (not the exact ignition point)')
        line(fmtLatLon(Number(p.lat), Number(p.lon)), 'fxm-tip-mono')
        break
      }
      case LYR.detectionsFill:
      case LYR.detectionsLine:
      case LYR.detectionsGoes:
      case LYR.detectionsDot: {
        const t = Number(p.t)
        const ageH = (tMs - t) / HOUR_MS
        line(`${String(p.inst)} heat detection (${String(p.sat)})`, 'fxm-tip-title')
        line(`${fmtDateTimeTz(t)} · ${ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min` : `${ageH.toFixed(ageH < 10 ? 1 : 0)} h`} before the timeline time`)
        const fp = Number(p.fp) || footprintM({ footprint_m: 0, instrument: String(p.inst) as never })
        line(
          `Sensor pixel about ${units === 'us' ? `${Math.round((fp * 3.28084) / 10) * 10} ft` : `${Math.round(fp)} m`} across: heat was detected somewhere inside it. It is not an exact fire edge.`,
        )
        const frp = p.frp == null || p.frp === 'null' ? null : Number(p.frp)
        line(`${frp != null && Number.isFinite(frp) ? `Fire radiative power ${frp.toFixed(1)} MW · ` : ''}confidence ${String(p.conf)} · ${p.dn === 'N' ? 'night' : 'day'} pass`, 'fxm-tip-hint')
        break
      }
      case LYR.perimetersLatest:
      case LYR.perimetersOld: {
        line(String(p.label ?? 'Perimeter'), 'fxm-tip-title')
        line(f.layer.id === LYR.perimetersLatest ? 'Latest agency perimeter as of the timeline time' : 'Earlier agency perimeter')
        line(`Source: ${String(p.source)}`, 'fxm-tip-hint')
        break
      }
      default:
        return null
    }
    return el
  }

  private updatePin(): void {
    const ws = useWorkspace.getState()
    this.pin.update(this.map, ws.selection, ws.mapLayers.selection, (lat, lon) => useWorkspace.getState().moveSelection(lat, lon))
  }

  // ------------------------------------------------------------------------------------------------ data
  private loadRasters(): void {
    const s = useStore.getState()
    const m = readyManifest(s.manifest)
    const f: ForecastManifest | null = m && s.forecast && s.forecast.incident_id === m.id && s.forecast.status === 'ready' ? s.forecast : null
    const key = `${m ? `${m.id}@${m.built_ms}` : '-'}|${f ? `${f.run_id}@${f.issued_ms}` : '-'}`
    if (key === this.rasterKey) return
    this.rasterKey = key
    patchOverlays({
      observed: { ...useMapRuntime.getState().overlays.observed, status: m ? (m.layers.observed_arrival ? 'loading' : 'missing') : 'none', error: null },
      forecast: {
        status: !m ? 'none' : f ? 'loading' : 'missing',
        runId: f?.run_id ?? null,
        members: f?.weather.members ?? null,
        issuedMs: f?.issued_ms ?? null,
        frame: null,
        counts: null,
        error: null,
      },
    })
    this.rasters = null
    this.keys.obs = this.keys.fc = ''
    this.markDirty('observed', 'forecast')
    if (!m) {
      this.setPlacement(null)
      return
    }
    void loadRasterSet(m, f, { incident: ['observed_arrival'], forecast: f ? FORECAST_LAYERS : [] }).then((set) => {
      if (this.destroyed || key !== this.rasterKey) return
      this.rasters = set
      const obs = set.incident.observed_arrival
      const anyLayer = obs?.layer ?? Object.values(set.forecastLayers).find((x) => x?.layer)?.layer ?? null
      this.setPlacement(anyLayer ? { manifest: m, w: anyLayer.width, h: anyLayer.height } : null)
      const fcErr = Object.values(set.forecastLayers).find((x) => x?.status === 'error')?.error ?? null
      patchOverlays({
        observed: { ...useMapRuntime.getState().overlays.observed, status: obs?.status === 'ready' ? 'ready' : obs?.status === 'error' ? 'error' : 'missing', error: obs?.error ?? null },
        forecast: { ...useMapRuntime.getState().overlays.forecast, status: !f ? 'missing' : fcErr ? 'error' : 'ready', error: fcErr },
      })
      this.markDirty('observed', 'forecast')
    })
  }

  private setPlacement(p: { manifest: IncidentManifest; w: number; h: number } | null): void {
    const mapping = p ? overlayMapping(p.manifest.grid, p.w, p.h) : null
    for (const o of [this.observed, this.forecast]) {
      if (o.setMapping(mapping)) {
        if (mapping) this.reattachRaster(o)
        else if (this.styleReady) o.removeFrom(this.map)
      }
    }
    const n = p ? p.w * p.h : 0
    if (n && (!this.bufs || this.bufs.n !== n)) {
      this.bufs = { n, obsColors: new Uint32Array(n), obsMask: new Uint8Array(n), classes: new Uint8Array(n), fcColors: new Uint32Array(n), startBurned: new Uint8Array(n), tmp: new Uint8Array(n) }
    }
  }

  private markDirty(...what: Array<keyof MapController['dirty']>): void {
    for (const w of what) this.dirty[w] = true
    if (this.timer !== undefined || this.destroyed) return
    const wait = Math.max(0, this.lastRun + MIN_INTERVAL_MS - performance.now())
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      this.lastRun = performance.now()
      this.run()
    }, wait)
  }

  /** Apply every dirty part (called at most every MIN_INTERVAL_MS). */
  private run(): void {
    if (this.destroyed || !this.styleReady) return
    const t0 = import.meta.env.DEV ? performance.now() : 0
    const d = this.dirty
    this.dirty = { observed: false, forecast: false, vectors: false, statics: false }
    if (d.statics) this.updateStatics()
    if (d.observed || d.forecast) this.updateRasters(d.observed, d.forecast)
    if (d.vectors) this.updateVectors()
    if (import.meta.env.DEV) {
      const ms = performance.now() - t0
      mapStats.runs++
      mapStats.lastRunMs = ms
      mapStats.totalRunMs += ms
      mapStats.maxRunMs = Math.max(mapStats.maxRunMs, ms)
    }
  }

  private updateStatics(): void {
    const s = useStore.getState()
    const m = readyManifest(s.manifest)
    if (m) {
      const a = aoiFeatures(m)
      this.setData(SRC.aoi, a.outline)
      this.setData(SRC.aoiLabels, a.labels)
    } else {
      this.setData(SRC.aoi, EMPTY)
      this.setData(SRC.aoiLabels, EMPTY)
    }
    const sum: IncidentSummary | null = s.summary
    this.setData(
      SRC.incident,
      sum && Number.isFinite(sum.lat) && Number.isFinite(sum.lon)
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [sum.lon, sum.lat] }, properties: { name: sum.name, lat: sum.lat, lon: sum.lon } }] }
        : EMPTY,
    )
    this.updateAoiInView()
  }

  private layer(name: string): LoadedLayer | null {
    const set = this.rasters
    if (!set) return null
    const slot = name === 'observed_arrival' ? set.incident.observed_arrival : set.forecastLayers[name as ForecastLayerName]
    return slot?.status === 'ready' ? slot.layer : null
  }

  private updateRasters(doObserved: boolean, doForecast: boolean): void {
    const s = useStore.getState()
    const m = readyManifest(s.manifest)
    const b = this.bufs
    const layers = useWorkspace.getState().mapLayers
    const obs = this.layer('observed_arrival')
    const map = this.map
    if (!m || !b) {
      patchOverlays({ observed: { ...useMapRuntime.getState().overlays.observed, asOfMs: null, burnedPx: 0, recentPx: 0 } })
      return
    }
    const geo = m.grid
    // ---- observed fire
    let obsChanged = false
    if (doObserved) {
      if (obs && obs.data.length === b.n && layers.observed) {
        const tH = (s.timeMs - m.time_origin_ms) / HOUR_MS
        const c = observedPixels(obs.data, obs.info.nodata, tH, b.obsColors, b.obsMask)
        const key = `${obs.url}|${c.burned}|${c.recent}`
        patchOverlays({ observed: { ...useMapRuntime.getState().overlays.observed, asOfMs: s.timeMs, burnedPx: c.burned, recentPx: c.recent } })
        if (key !== this.keys.obs) {
          this.keys.obs = key
          obsChanged = true
          this.observed.draw(b.obsColors)
          this.observed.push(map)
          if (import.meta.env.DEV) mapStats.rasterDraws++
          const g = maskGeometry(b.obsMask, obs.width, obs.height, geo, 1)
          this.setData(SRC.observedEdge, lines(g.lines))
        }
      } else if (this.keys.obs !== 'off') {
        this.keys.obs = 'off'
        b.obsMask.fill(0)
        this.observed.draw(null)
        this.observed.push(map)
        this.setData(SRC.observedEdge, EMPTY)
      }
    }
    // ---- forecast
    if (doForecast || obsChanged) {
      const f = s.forecast && s.forecast.incident_id === m.id && s.forecast.status === 'ready' ? s.forecast : null
      const arrays: ForecastArrays = {
        p10: this.layer('arrival_p10'),
        p50: this.layer('arrival_p50'),
        p90: this.layer('arrival_p90'),
        prob: this.layer('burn_probability'),
      }
      const view = useMapRuntime.getState().forecastView
      const sized = [arrays.p10, arrays.p50, arrays.p90, arrays.prob].every((x) => !x || (x as LoadedLayer).data.length === b.n)
      if (f && layers.forecast && sized && (arrays.prob || arrays.p50)) {
        const frame = forecastFrame(f, s.timeMs, view)
        const counts = forecastClasses(frame, arrays, f.time_origin_ms, b.classes)
        // The model starts from the area observed burned at the forecast start: where the observed layer shows that
        // area (burned by the forecast start, or by the timeline time when earlier), it stays the observed fill and
        // is not drawn as a prediction. Elsewhere every class is drawn, so no band between the two is left blank.
        const haveObs = !!obs && obs.data.length === b.n && layers.observed
        const startH = (Math.min(f.start_ms, s.timeMs) - m.time_origin_ms) / HOUR_MS
        const excluded = haveObs ? burnedByMask(obs.data, obs.info.nodata, startH, b.startBurned) : 0
        const key = `${f.run_id}@${f.issued_ms}|${frame.kind}|${counts ? counts.join(',') : 'x'}|${excluded}`
        patchOverlays({ forecast: { ...useMapRuntime.getState().overlays.forecast, frame, counts } })
        if (key !== this.keys.fc && counts) {
          this.keys.fc = key
          forecastPixels(b.classes, haveObs ? b.startBurned : null, b.fcColors)
          this.forecast.draw(b.fcColors)
          this.forecast.push(map)
          if (import.meta.env.DEV) mapStats.rasterDraws++
          const w = (arrays.prob ?? arrays.p50) as LoadedLayer
          classMask(b.classes, 1, null, b.tmp)
          const l10 = maskGeometry(b.tmp, w.width, w.height, geo, 2).lines
          classMask(b.classes, 2, null, b.tmp)
          const g50 = maskGeometry(b.tmp, w.width, w.height, geo, 2)
          this.setData(SRC.forecastLines, {
            type: 'FeatureCollection',
            features: [...lines(l10, { k: 10 }).features, ...lines(g50.lines, { k: 50 }).features],
          })
          classMask(b.classes, 2, haveObs ? b.startBurned : null, b.tmp)
          this.setData(SRC.forecastHatch, polygons(maskGeometry(b.tmp, w.width, w.height, geo, 2).polygons))
        }
      } else if (this.keys.fc !== 'off') {
        this.keys.fc = 'off'
        patchOverlays({ forecast: { ...useMapRuntime.getState().overlays.forecast, frame: f ? forecastFrame(f, s.timeMs, view) : null, counts: null } })
        this.forecast.draw(null)
        this.forecast.push(map)
        this.setData(SRC.forecastLines, EMPTY)
        this.setData(SRC.forecastHatch, EMPTY)
      }
    }
  }

  private updateVectors(): void {
    const s = useStore.getState()
    const m = readyManifest(s.manifest)
    const layers = useWorkspace.getState().mapLayers
    const t = s.timeMs
    // perimeters
    const per = m && layers.perimeters ? (s.perimeters?.perimeters ?? []) : []
    const shownPer = per.filter((p) => p.t_ms <= t).length
    const perKey = `${m?.id}|${per.length}|${shownPer}`
    if (perKey !== this.keys.perim) {
      this.keys.perim = perKey
      const { fc, latest } = m ? perimeterFeatures(per, m.grid, t) : { fc: EMPTY, latest: null }
      this.setData(SRC.perimeters, fc)
      patchOverlays({ perimeter: { latestMs: latest?.t_ms ?? null, count: fc.features.length } })
    }
    // detections
    const det = m && layers.detections ? (s.detections?.detections ?? []) : []
    const { fc: detFc, points: detPts, counts } = m ? detectionFeatures(det, m.grid, t) : { fc: EMPTY, points: EMPTY, counts: [0, 0, 0] as [number, number, number] }
    const detKey = `${m?.id}|${det.length}|${detFc.features.length}|${counts.join(',')}|${detFc.features[0]?.id ?? ''}|${detFc.features[detFc.features.length - 1]?.id ?? ''}`
    if (detKey !== this.keys.det) {
      this.keys.det = detKey
      this.setData(SRC.detections, detFc)
      this.setData(SRC.detectionPoints, detPts)
      patchOverlays({ detections: { counts, total: detFc.features.length } })
    }
    // events (events.json + the user's notes with a location)
    const evs = this.mapEvents(m)
    const shownEv = layers.events ? evs.filter((e) => e.tMs <= t) : []
    const evKey = `${m?.id}|${evs.length}|${shownEv.length}|${s.selectedEventId ?? ''}|${layers.events}`
    if (evKey !== this.keys.ev) {
      this.keys.ev = evKey
      this.setData(SRC.events, layers.events ? eventFeatures(evs, t, s.selectedEventId) : EMPTY)
      patchOverlays({ events: shownEv.length })
    }
  }

  private mapEvents(m: IncidentManifest | null): MapEvent[] {
    const s = useStore.getState()
    if (!m) {
      this.feed.clear()
      return []
    }
    const annotations = useAnnotations.getState().byIncident[m.id] ?? useAnnotations.getState().ensure(m.id)
    const items = buildFeedItems({ manifest: m, events: s.events?.events ?? [], annotations })
    this.feed.clear()
    const out: MapEvent[] = []
    for (const it of items) {
      if (!it.location) continue
      const id = it.eventId ?? it.id
      this.feed.set(id, it)
      out.push({ id, title: it.title, tMs: it.tMs, lon: it.location.lon, lat: it.location.lat, kind: it.kind, confidence: it.confidence })
    }
    return out
  }
}
