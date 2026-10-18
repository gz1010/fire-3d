// The Public/Command map engine (owner: map-core; CONTRACT §4). One MapLibre map serves 2D (top-down, north-up by
// default) and 3D (Mapterhorn terrain + oblique camera). MapLibre owns the camera, terrain, navigation and tile
// streaming; this class only reacts to state:
//   useWorkspace  basemap, perspective, selection, mapFlyTo, mapLayers, safeInsets,  -> style / camera / pin / layers
//                 fireCardId, overviewFilter, units
//   useStore      incident + manifest, forecast run, timeMs, bundle JSON, flyTo (x/z), -> overlays / camera
//                 catalog lists (overview markers)
//   useMapRuntime forecastView                                                        -> forecast overlay
// Overlays are recomputed only when one of their inputs changes (coalesced to <= ~9 updates/s while playing, and
// skipped when the shown pixel sets are unchanged), never per frame. Basemap switches reload the style and re-add
// every overlay from the cached data, so overlays, timeline, selection and credits survive them.
// Brief 2 (CONTRACT §13 map):
//   - the opening camera is a pure state machine (map/framing.ts): one flight per target when its data is ready, a
//     restored or deep-linked view kept on a first load, done only when the fit completes, fits re-issued after
//     non-user interruptions, ended by user gestures and explicit requests; fires are framed on their own extent
//     (lib/fireBounds.ts, I4) and the "Incident" control toggles fire / modeled area;
//   - with no incident open, the California overview: one marker per fire (map/overviewLayers.ts); a click on a
//     marker, or inside a fire on the fire's own marker or label, opens its fire card (I3) instead of selecting a point;
//   - the effective basemap comes from the workspace store; when the USGS photos fail (4 errors and no tile, or no tile
//     within 8 s) the map sets the store's basemapFallback to 'dark', which stops every imagery request;
//   - muted 3D buildings in 3D only, an orbit group's camera actions, and the official layers (I6);
//   - decision 10, one continuous map: once the camera settles, zooming in on a prepared fire focuses it
//     (useStore.focusIncidentFromMap, map/focus.ts) and zooming out returns to the overview, without moving the camera;
//     the markers stay at every zoom (lighter while a fire is open), other prepared fires in view show their latest
//     perimeter (map/nearbyPerimeters.ts), and unprepared fires a "Spread not prepared yet" chip.
import {
  Map as MapLibreMap,
  LngLat,
  Popup,
  type FilterSpecification,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type MapSourceDataEvent,
  type PaddingOptions,
  type StyleSpecification,
} from 'maplibre-gl'
import { bundleUrl, fetchJson } from '../api/client'
import type { ForecastLayerName, ForecastManifest, IncidentManifest, IncidentSummary } from '../api/types'
import { HOUR_MS, loadRasterSet, type LoadedLayer, type RasterSet } from '../data/rasters'
import { aoiBounds, fireBounds, type LonLatBox } from '../lib/fireBounds'
import { area as areaText } from '../lib/plainLanguage'
import { aoiCornersLonLat, localToLonLat, overlayMapping } from '../lib/reproject'
import { fmtDateTimeTz } from '../lib/time'
import { mountOfficialLayers, type OfficialLayersHandle } from '../official/mapLayer'
import { useAnnotations } from '../state/annotations'
import { findFire, fireFlyTo, fireStatus, overviewFires, type OverviewCatalog } from '../state/overview'
import { readUrlParams } from '../state/runtime'
import { useStore } from '../state/store'
import { useWorkspace, type Basemap, type MapFlyTo, type MapLayerKey, type Perspective, type SafeInsets } from '../state/workspace'
import { buildFeedItems, selectFeedItem } from '../ui/feed/feedModel'
import type { FeedItem } from '../ui/feed/types'
import { BUILDINGS_3D_LAYER, HILLSHADE_SOURCE, IMAGERY_SOURCE, loadBasemap, TERRAIN_SOURCE, VECTOR_SOURCE, type DerivedStyle } from './basemapStyle'
import { maskGeometry } from './contours'
import { allFocusCandidates, CENTRAL_FRACTION, chipTargets, FocusHold, focusUnlessHeld, FOCUS_DEBOUNCE_MS, FOCUS_OUT_ZOOM, type FocusCurrent, type FocusView } from './focus'
import { boundsCenter, CALIFORNIA_BOUNDS, Framing, goalFor, latestPerimeter, zoomForBounds, type CameraPose, type FrameGoal } from './framing'
import { drapedLayers, HATCH_IMAGE, hatchImage, LAYER_GROUPS, LYR, SRC, topLayers, type MapTheme } from './layers'
import { fmtLatLon, SelectionPin } from './markers'
import { EMPTY_OVERLAYS, motionMs, patchOverlays, setProvider, useMapRuntime, type MapActions } from './mapStore'
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
import { NearbyLoader, nearbyFires, nearbyPerimeterFeatures, NEARBY_MIN_ZOOM, shownPerimeterIndex, type NearbyFire } from './nearbyPerimeters'
import { CHIP_IMAGE, chipImage, OVERVIEW_HIT_LAYERS, OVERVIEW_SRC, overviewFeatures, overviewFilters, overviewLayers, overviewPaint, OVR, pickFireHit, type FireHit } from './overviewLayers'
import { BASEMAP_STYLE, devProviderFailures, OPENFREEMAP_GLYPHS, UNREACHABLE } from './providers'
import { RasterOverlay } from './rasterOverlay'
import { bindExtrasLayers, EXTRAS_HOVER_LAYERS, type ExtrasLayers } from './extrasLayers'
import { cameraViewText } from '../extras/cameras'
import { EVAC_LAYERS, zoneDetail } from '../extras/evacuation'
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
/** USGS aerial photos: no tile within this time counts as a failure (O-R12). */
const IMAGERY_FIRST_TILE_MS = 8000
/** Margin (px) around fitted bounds, inside the safe-area padding. */
const FIT_MARGIN_PX = 28
const OVERVIEW_MARGIN_PX = 12
const FIT_MAX_ZOOM = 15
const FIT_MS = 1200
/** The opening fit waits this long for the fire rasters, then frames with the vector data alone. */
const RASTER_WAIT_MS = 6000
/** Input on the map within this time before an interruption means the user took the camera. */
const USER_INPUT_MS = 400
/** A safe-area change this soon after a completed fit (the layout still settling as data arrives) fits the goal again,
 *  so an instant fit (reduced motion) ends where an animated one does. */
const SETTLE_MS = 2000
const CANVAS_LABEL = 'Map. Arrow keys pan, plus and minus zoom, Shift + arrow keys rotate (and tilt in 3D); click to select a location or a fire.'

/** Update counters for verification (window.__mapStats): how often overlays were recomputed and how long it took.
 *  Development builds only: every use sits behind import.meta.env.DEV, which production builds compile out. */
const mapStats = { runs: 0, rasterDraws: 0, vectorSets: 0, lastRunMs: 0, maxRunMs: 0, totalRunMs: 0, fits: 0 }
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

const paddingEquals = (a: PaddingOptions, b: SafeInsets) =>
  Math.abs((a.top ?? 0) - b.top) < 0.5 && Math.abs((a.bottom ?? 0) - b.bottom) < 0.5 && Math.abs((a.left ?? 0) - b.left) < 0.5 && Math.abs((a.right ?? 0) - b.right) < 0.5

const catalogOf = (): OverviewCatalog => {
  const c = useStore.getState().catalog
  return { live: c.live, season: c.season, historical: c.historical }
}

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
  private timer: number | undefined
  private lastRun = 0
  private dirty = { observed: true, forecast: true, vectors: true, statics: true }
  private keys = { obs: '', fc: '', det: '', perim: '', ev: '' }
  private feed = new Map<string, FeedItem>()
  private tiles: Record<ProviderKey, { ok: number; err: number }> = { vector: { ok: 0, err: 0 }, imagery: { ok: 0, err: 0 }, terrain: { ok: 0, err: 0 } }
  private terrainBroken = false
  private destroyed = false
  private moveRaf = 0
  /** An explicit camera move in progress (restarted when the safe area changes mid-flight). */
  private activeFly: { req: Omit<MapFlyTo, 'nonce'>; animate: boolean } | null = null
  private pendingPadding = false
  private hoverRaf = 0
  private lastHover: { x: number; y: number } | null = null
  /** Optional sources (imagery, evacuation zones, cameras): mounted after map-core's own style handling. */
  private readonly extras: ExtrasLayers
  /** Official layers (NWS fire weather outlines, highlight of a selected official item; I6). */
  private readonly official: OfficialLayersHandle
  /** Opening camera (map/framing.ts). */
  private readonly framing: Framing
  /** True while issueFit runs: moveends fired inside it belong to the moves it interrupts (or its own instant jump). */
  private issuing = false
  /** The moving animation is our fit (false once any move ends: then another move, if any, interrupted it). */
  private fitMoving = false
  /** When the last fit completed (performance.now()). */
  private framedAt = -Infinity
  private reissueTimer = 0
  private rasterWait: { key: string; timer: number; expired: boolean } = { key: '', timer: 0, expired: false }
  /** The overview as the user last left it (restored by Back / "← All fires"); never a fire's fly-to view. */
  private overviewView: { lon: number; lat: number; zoom: number } | null = null
  /** The last move on the overview was a fly to a fire (marker or list click): not an overview view to remember. */
  private overviewFireFly = false
  private overviewRefs: { live: unknown; season: unknown; historical: unknown; filter: string; units: string } | null = null
  private pointerDown = false
  private lastInputMs = -Infinity
  private imageryTimer = 0
  private readonly domUnsubs: Array<() => void> = []
  /** Decision 10: the debounced focus evaluation after the camera settles. */
  private focusTimer = 0
  /** The focus last asked of the store since the incident last changed (undefined: none). */
  private focusAsked: string | null | undefined = undefined
  /** Showing an official area (MapFlyTo.source 'official') holds the focus until the user moves the map again. */
  private readonly focusHold = new FocusHold()
  /** The overview set shown as markers (shell's overviewFires) and chips; the focus and the other fires' outlines use
   *  all three lists. */
  private overviewSet: IncidentSummary[] = []
  private overviewHidden = ''
  private overviewDim: boolean | null = null
  /** Unprepared fires zoomed in on: they show the "Spread not prepared yet" chip. */
  private chipIds: string[] = []
  /** Other prepared fires in view (their latest perimeter is outlined) and their bundles. */
  private nearbyList: NearbyFire[] = []
  private nearbyKey = ''
  private readonly nearbyLoader = new NearbyLoader(fetchJson, bundleUrl)

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
    this.map.getCanvas().setAttribute('aria-label', CANVAS_LABEL)
    this.popup = new Popup({ closeButton: false, closeOnClick: false, className: 'fxm-popup', maxWidth: '300px', offset: 12 })
    this.flyNonce = ws.mapFlyTo?.nonce ?? 0
    this.localNonce = st.flyTo?.nonce ?? 0
    this.framing = new Framing({ incidentId: st.incidentId, restoredView: v != null, urlIncident: typeof window !== 'undefined' ? readUrlParams().incident : null })
    useMapRuntime.setState({ map: this.map, overlays: EMPTY_OVERLAYS, aoiInView: null, terrainOn: false, actions: this.actions(), framing: this.framing.phase, framedKind: null, fireBounds: null })

    this.bindMapEvents()
    this.bindInputEvents(container)
    this.subscribe()
    this.extras = bindExtrasLayers(this.map)
    // NWS outlines below the evacuation zones and fire layers; their labels and the highlight below map-core's top layers
    this.official = mountOfficialLayers(this.map, { beforeId: [EVAC_LAYERS.tint, ...drapedLayers().map((l) => l.id)], topBeforeId: topLayers().map((l) => l.id) })
    // the safe area is the map's persistent padding: centring and framing use the visible part of the map
    this.applySafeInsets(false)
    void this.applyBasemap(ws.basemap)
    this.loadRasters()
    // whatever is ready now is framed without a flight (the overview, or an incident already loaded)
    this.offerGoal(false)
    this.updateCamera()
  }

  destroy(): void {
    this.destroyed = true
    for (const u of this.unsubs) u()
    for (const u of this.domUnsubs) u()
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    window.clearTimeout(this.reissueTimer)
    window.clearTimeout(this.rasterWait.timer)
    window.clearTimeout(this.imageryTimer)
    window.clearTimeout(this.focusTimer)
    cancelAnimationFrame(this.moveRaf)
    cancelAnimationFrame(this.hoverRaf)
    this.popup.remove()
    this.pin.remove()
    this.official.remove()
    this.extras.destroy()
    this.map.remove()
    useMapRuntime.setState({ map: null, camera: null, terrainOn: false, aoiInView: null, actions: null, framing: 'idle', framedKind: null, fireBounds: null })
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
          // a requested target (search, a fire in the overview list, return to incident) is the user's choice: data
          // arriving later keeps it
          this.framing.explicit()
          if (useStore.getState().incidentId == null) this.overviewFireFly = true
          // showing an official area (an evacuation zone, an NWS alert's zones) never changes the open fire, even when
          // the area touches another prepared fire: the focus rule waits for the user's next move
          this.focusHold.flight(s.mapFlyTo.source)
          if (this.focusHold.active) this.keepShownFocus()
          this.fly(s.mapFlyTo)
          this.publishFraming()
        }
        if (s.mapLayers !== p.mapLayers) this.applyLayerVisibility(p.mapLayers)
        if (s.safeInsets !== p.safeInsets) this.applySafeInsets(true)
        if (s.fireCardId !== p.fireCardId) this.updateFireCardRing()
        if (s.overviewFilter !== p.overviewFilter || s.units !== p.units) {
          this.updateOverview()
          // another set of fires may be in view: focus and outlines follow it
          if (s.overviewFilter !== p.overviewFilter) this.scheduleFocus()
        }
      }),
    )
    this.unsubs.push(
      useStore.subscribe((s, p) => {
        if (s.flyTo && s.flyTo.nonce !== this.localNonce) {
          this.localNonce = s.flyTo.nonce
          if (s.manifest) {
            const [lon, lat] = localToLonLat(s.flyTo.x, s.flyTo.z, s.manifest.grid)
            this.framing.explicit()
            this.focusHold.release()
            this.fly({ lon, lat })
          }
        }
        const newIncident = s.incidentId !== p.incidentId
        if (newIncident) {
          // a fire the map focused by zooming (or the overview reached by zooming out) keeps the camera: the store says
          // so in the same update (incidentSource 'zoom', CONTRACT §13 shell)
          const fromMap = s.incidentSource === 'zoom'
          this.focusAsked = undefined
          this.focusHold.release()
          this.framing.setTarget(s.incidentId, { keepCamera: fromMap })
          if (s.incidentId == null) this.overviewFireFly = false
          this.feed.clear()
          this.resetRasterWait()
          if (useMapRuntime.getState().fireBounds) useMapRuntime.setState({ fireBounds: null })
          this.updateOverview()
          this.keys.ev = ''
          this.nearbyKey = ''
          this.markDirty('vectors')
        }
        const manifestChanged = s.manifest !== p.manifest
        if (manifestChanged || s.forecast !== p.forecast) this.loadRasters()
        if (manifestChanged || s.summary !== p.summary) this.markDirty('statics')
        if (s.timeMs !== p.timeMs) this.markDirty('observed', 'forecast', 'vectors')
        if (s.perimeters !== p.perimeters || s.detections !== p.detections || s.events !== p.events || s.selectedEventId !== p.selectedEventId) {
          this.keys.det = this.keys.perim = this.keys.ev = ''
          this.markDirty('vectors')
        }
        if (s.perimeters !== p.perimeters) this.updateFireBounds()
        if (s.catalog.live !== p.catalog.live || s.catalog.season !== p.catalog.season || s.catalog.historical !== p.catalog.historical) {
          this.updateOverview()
          this.scheduleFocus()
        }
        if (newIncident || manifestChanged || s.summary !== p.summary || s.incidentLoading !== p.incidentLoading || s.perimeters !== p.perimeters) this.offerGoal(true)
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
    window.clearTimeout(this.imageryTimer)
    this.imageryTimer = 0
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
    for (const id of [SRC.observedEdge, SRC.forecastLines, SRC.forecastHatch, SRC.perimeters, SRC.nearby, SRC.detections, SRC.detectionPoints, SRC.aoi, SRC.aoiLabels, SRC.events, SRC.incident, OVERVIEW_SRC])
      empty(id)
    for (const tone of ['dark', 'light'] as const) {
      if (map.hasImage(CHIP_IMAGE[tone])) continue
      const c = chipImage(tone)
      map.addImage(CHIP_IMAGE[tone], c.image, c.options)
    }
    const before = this.derived.overlayBeforeId ?? this.derived.labelLayerId ?? undefined
    const theme = this.theme()
    // rasters (only with a placement), then the other draped layers, all below the 3D buildings and the labels
    this.observed.addSource(map)
    this.forecast.addSource(map)
    for (const layer of drapedLayers(theme)) {
      if ((layer.id === LYR.observedRaster && !map.getSource(SRC.observedRaster)) || (layer.id === LYR.forecastRaster && !map.getSource(SRC.forecastRaster))) continue
      map.addLayer(layer, before)
    }
    // fire markers above the basemap labels, below the open fire's own markers and labels
    for (const layer of overviewLayers(theme)) map.addLayer(layer)
    for (const layer of topLayers(theme)) map.addLayer(layer)
    this.applyLayerVisibility(null)
    if (useWorkspace.getState().perspective === '3d') this.enableTerrain()
    else useMapRuntime.setState({ terrainOn: false })
    this.updateBuildings()
    // everything is re-pushed from the cached data
    this.keys = { obs: '', fc: '', det: '', perim: '', ev: '' }
    this.overviewRefs = null
    this.overviewHidden = ''
    this.overviewDim = null
    this.nearbyKey = ''
    this.markDirty('observed', 'forecast', 'vectors', 'statics')
    this.updateOverview()
    this.updateFireCardRing()
    this.updatePin()
    if (useWorkspace.getState().basemap === 'aerial') this.watchImagery()
    // chips and outlines need the new style's layers: evaluate the view again
    this.scheduleFocus()
  }

  /** Our labels and lines: dark ink on the light road map, light ink on the dark map, plus casings and close-zoom
   *  lightening on the aerial photos. */
  private theme(): MapTheme {
    const b = useWorkspace.getState().basemap
    if (b === 'aerial') return 'aerial'
    return b === 'roads' && this.derived?.vector !== false ? 'light' : 'dark'
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
    // keep the declared stacking order: insert below the next draped layer that exists, else below the buildings / labels
    const next = order.slice(i + 1).find((l) => map.getLayer(l.id))
    map.addLayer(order[i], next?.id ?? this.derived.overlayBeforeId ?? this.derived.labelLayerId ?? undefined)
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

  /** 3D buildings: shown in 3D only (they fade in from z14.5 by their own paint). */
  private updateBuildings(): void {
    if (!this.styleReady || !this.map.getLayer(BUILDINGS_3D_LAYER)) return
    this.map.setLayoutProperty(BUILDINGS_3D_LAYER, 'visibility', useWorkspace.getState().perspective === '3d' ? 'visible' : 'none')
  }

  // ------------------------------------------------------------------------------------------------ overview
  /** Fire markers: the shell's overview set (filter, lists), at every zoom (decision 10); rebuilt only when a list, the
   *  filter or the units change. */
  private updateOverview(): void {
    const c = useStore.getState().catalog
    const ws = useWorkspace.getState()
    const refs = { live: c.live, season: c.season, historical: c.historical, filter: ws.overviewFilter, units: ws.units }
    const o = this.overviewRefs
    if (!(o && o.live === refs.live && o.season === refs.season && o.historical === refs.historical && o.filter === refs.filter && o.units === refs.units)) {
      this.overviewSet = overviewFires(catalogOf(), ws.overviewFilter)
      if (this.styleReady) {
        this.overviewRefs = refs
        this.setData(OVERVIEW_SRC, overviewFeatures(this.overviewSet, ws.units))
      }
    }
    this.applyOverviewState()
  }

  /** While a past fire is open: its timeline time (other fires are shown as they were then); else null. */
  private replayTime(): number | null {
    const s = useStore.getState()
    if (s.incidentId == null) return null
    const mode = (s.summary && s.summary.id === s.incidentId ? s.summary.mode : null) ?? s.manifest?.mode ?? s.mode
    return mode === 'historical' ? s.timeMs : null
  }

  /** Markers while a fire is open: lighter, without the open fire's own marker and, in a replay, without fires that had
   *  not started by the timeline time. Filters change only when that set changes (never per frame). */
  private applyOverviewState(): void {
    if (!this.styleReady) return
    const map = this.map
    const open = useStore.getState().incidentId
    const t = this.replayTime()
    const hidden: string[] = open ? [open] : []
    if (t != null) for (const f of this.overviewSet) if (f.started_ms > t && f.id !== open) hidden.push(f.id)
    const key = `${hidden.join(',')}|${this.chipIds.join(',')}`
    if (key !== this.overviewHidden) {
      this.overviewHidden = key
      for (const [id, f] of Object.entries(overviewFilters(hidden, this.chipIds))) if (map.getLayer(id)) map.setFilter(id, f as FilterSpecification)
    }
    const dim = open != null
    if (dim !== this.overviewDim) {
      this.overviewDim = dim
      for (const [id, props] of Object.entries(overviewPaint(dim))) if (map.getLayer(id)) for (const [k, v] of Object.entries(props)) map.setPaintProperty(id, k, v)
    }
  }

  private updateFireCardRing(): void {
    if (!this.styleReady || !this.map.getLayer(OVR.selected)) return
    this.map.setFilter(OVR.selected, ['==', ['get', 'id'], useWorkspace.getState().fireCardId ?? ''])
  }

  /** The fire a click on the overview means (nearest marker centre; a label when no marker is hit). */
  private fireAt(point: { x: number; y: number }): string | null {
    const map = this.map
    const layers = OVERVIEW_HIT_LAYERS.filter((id) => map.getLayer(id))
    if (!layers.length) return null
    const feats = map.queryRenderedFeatures([point.x, point.y], { layers })
    const hits: FireHit[] = []
    let labelId: string | null = null
    const seen = new Set<string>()
    for (const f of feats) {
      const id = f.properties?.id
      if (typeof id !== 'string') continue
      if (f.layer.id === OVR.label) {
        labelId ??= id
        continue
      }
      if (seen.has(id) || f.geometry.type !== 'Point') continue
      seen.add(id)
      const p = map.project(f.geometry.coordinates as [number, number])
      hits.push({ id, live: f.properties.live === true || f.properties.live === 'true', acres: Number(f.properties.acres) || 0, distPx: Math.hypot(p.x - point.x, p.y - point.y) })
    }
    return pickFireHit(hits) ?? labelId
  }

  /** The fire of a "Spread not prepared yet" chip or another fire's perimeter outline under the pointer. */
  private cardTargetAt(point: { x: number; y: number }): string | null {
    const map = this.map
    const layers = [OVR.chip, LYR.nearbyLine, LYR.nearbyLabel].filter((id) => map.getLayer(id))
    if (!layers.length) return null
    const id = map.queryRenderedFeatures([point.x, point.y], { layers })[0]?.properties?.id
    return typeof id === 'string' ? id : null
  }

  /** Open a fire's card from the overview map and fly to its area (decision 1: clicking a fire flies to it). */
  private openFireFromOverview(id: string): void {
    const ws = useWorkspace.getState()
    ws.setFireCard(id)
    const s = findFire(id, useStore.getState().summary, catalogOf())
    const req = s ? fireFlyTo(s) : null
    if (req) ws.requestMapFlyTo(req)
  }

  // ------------------------------------------------------------------------------------------------ camera
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

  private pose(): CameraPose {
    const c = this.map.getCenter()
    return { lon: c.lng, lat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() }
  }

  /** What the opening camera should frame now (null while the data is not ready). */
  private goal(): FrameGoal | null {
    const s = useStore.getState()
    return goalFor({
      target: this.framing.target,
      incidentId: s.incidentId,
      incidentLoading: s.incidentLoading,
      summary: s.summary,
      manifest: s.manifest,
      rasters: this.rasterState(readyManifest(s.manifest)),
      burned: this.layer('observed_arrival'),
      p90: this.layer('arrival_p90'),
      perimeters: s.perimeters?.perimeters ?? null,
      overviewView: this.overviewView,
    })
  }

  /** Is the ready bundle's raster set in? Starts the bounded wait for it. */
  private rasterState(m: IncidentManifest | null): 'pending' | 'settled' | 'expired' {
    if (!m || this.rasters) return 'settled'
    const w = this.rasterWait
    if (w.key === this.rasterKey) return w.expired ? 'expired' : 'pending'
    window.clearTimeout(w.timer)
    const key = this.rasterKey
    this.rasterWait = {
      key,
      expired: false,
      timer: window.setTimeout(() => {
        if (this.destroyed || this.rasterWait.key !== key) return
        this.rasterWait.expired = true
        this.offerGoal(true)
      }, RASTER_WAIT_MS),
    }
    return 'pending'
  }

  private resetRasterWait(): void {
    window.clearTimeout(this.rasterWait.timer)
    this.rasterWait = { key: '', timer: 0, expired: false }
  }

  /** Offer the current goal to the opening camera; fly when it answers with a fit. */
  private offerGoal(animate: boolean): void {
    if (this.destroyed) return
    const cmd = this.framing.offer(this.goal())
    if (cmd) this.issueFit(cmd.goal, animate, cmd.reissue)
    this.publishFraming()
  }

  /** Fit a goal inside the safe area. The padding is set first (a padding ease cut short never leaves it wrong);
   *  when MapLibre cannot fit (cameraForBounds answers undefined) the camera eases to the box centre at a zoom that
   *  fits the whole map, padding included. */
  private issueFit(goal: FrameGoal, animate: boolean, reissue: boolean): void {
    const map = this.map
    const duration = animate ? motionMs(FIT_MS) : 0
    const padding = this.padding()
    const bearing = map.getBearing()
    const pitch = map.getPitch()
    this.issuing = true
    try {
      if (!paddingEquals(map.getPadding(), padding)) map.setPadding(padding)
      let pose: CameraPose
      let fallback = false
      if (goal.bounds) {
        const overview = goal.kind === 'overview'
        const margin = overview ? OVERVIEW_MARGIN_PX : FIT_MARGIN_PX
        const maxZoom = overview ? 8 : FIT_MAX_ZOOM
        const cam = map.cameraForBounds(goal.bounds, { padding: margin, bearing, maxZoom })
        if (cam?.center && Number.isFinite(cam.zoom)) {
          const c = LngLat.convert(cam.center)
          pose = { lon: c.lng, lat: c.lat, zoom: cam.zoom as number, bearing, pitch }
        } else {
          fallback = true
          const [lon, lat] = boundsCenter(goal.bounds)
          const el = map.getContainer()
          pose = { lon, lat, zoom: zoomForBounds(goal.bounds, el.clientWidth, el.clientHeight, margin, maxZoom), bearing, pitch }
        }
      } else {
        const v = goal.view ?? { lon: CALIFORNIA[0], lat: CALIFORNIA[1], zoom: 5 }
        pose = { lon: v.lon, lat: v.lat, zoom: v.zoom, bearing, pitch }
      }
      // recorded before the move: an instant move ends inside the call below
      this.framing.started(goal, pose, reissue)
      if (import.meta.env.DEV) mapStats.fits++
      if (fallback) map.easeTo({ center: [pose.lon, pose.lat], zoom: pose.zoom, bearing, pitch, padding, duration })
      else map.flyTo({ center: [pose.lon, pose.lat], zoom: pose.zoom, bearing, pitch, duration })
    } finally {
      this.issuing = false
    }
    this.fitMoving = map.isMoving()
    // an instant fit has already ended
    if (!this.fitMoving) this.afterMove(false)
    this.publishFraming()
  }

  /** Re-issue an interrupted fit once the camera is free (never inside another move's moveend). */
  private scheduleReissue(): void {
    if (this.reissueTimer) return
    this.reissueTimer = window.setTimeout(() => {
      this.reissueTimer = 0
      const g = this.framing.goal
      if (this.destroyed || this.framing.phase !== 'flying' || !g) return
      if (this.userInputActive()) {
        this.framing.userGesture()
        this.publishFraming()
        return
      }
      // the interrupting move is still running: its own moveend asks again
      if (this.map.isMoving()) return
      this.issueFit(g, true, true)
    }, 0)
  }

  private userInputActive(): boolean {
    return this.pointerDown || performance.now() - this.lastInputMs < USER_INPUT_MS
  }

  private publishFraming(): void {
    const framing = this.framing.phase
    const framedKind = this.framing.framedKind()
    const rt = useMapRuntime.getState()
    if (rt.framing !== framing || rt.framedKind !== framedKind) useMapRuntime.setState({ framing, framedKind })
  }

  /** Explicit camera requests (search results, list rows, feed items, return-to): fit bounds inside the safe area or
   *  go to a point. */
  private fly(f: Omit<MapFlyTo, 'nonce'>, animate = true): void {
    const map = this.map
    const duration = animate ? motionMs(1100) : 0
    const padding = this.padding()
    if (!paddingEquals(map.getPadding(), padding)) map.setPadding(padding)
    if (f.bounds) {
      const cam = map.cameraForBounds(f.bounds, { padding: FIT_MARGIN_PX, bearing: map.getBearing(), maxZoom: FIT_MAX_ZOOM })
      if (cam?.center && Number.isFinite(cam.zoom)) map.flyTo({ center: cam.center, zoom: cam.zoom, bearing: map.getBearing(), duration })
      else {
        const el = map.getContainer()
        map.easeTo({ center: boundsCenter(f.bounds), zoom: zoomForBounds(f.bounds, el.clientWidth, el.clientHeight, FIT_MARGIN_PX, FIT_MAX_ZOOM), padding, duration })
      }
    } else {
      const zoom = f.zoom ?? Math.max(map.getZoom(), 13)
      map.easeTo({ center: [f.lon, f.lat], zoom, duration })
    }
    // remembered after the call: starting a move ends the previous one, whose moveend clears activeFly
    this.activeFly = duration > 0 && map.isMoving() ? { req: f, animate } : null
  }

  /** Keep the map padding equal to the safe area. The opening fit in flight restarts toward the same goal with the new
   *  padding, as does an explicit flight; during a user gesture the change waits for the gesture to end. */
  private applySafeInsets(animate: boolean): void {
    const padding = this.padding()
    const g = this.framing.goal
    if (this.framing.phase === 'flying' && g) {
      // our own flight (or nothing) is moving: restart it with the new padding. Another move that interrupted the fit
      // (a 2D/3D or compass ease) runs on: the re-issue after it ends uses the new padding, and that move's target
      // pitch / bearing instead of an intermediate one.
      if (this.fitMoving || !this.map.isMoving()) this.issueFit(g, animate, false)
      return
    }
    if (this.map.isMoving()) {
      const f = this.activeFly
      if (f) {
        this.map.setPadding(padding)
        this.fly(f.req, f.animate)
      } else this.pendingPadding = true
      return
    }
    // a goal framed moments ago (the layout still settling), and the California overview as framed, follow the safe
    // area while the user has not moved: fit them again
    if (this.framing.phase === 'done' && g && (performance.now() - this.framedAt < SETTLE_MS || (g.kind === 'overview' && g.bounds === CALIFORNIA_BOUNDS))) {
      this.issueFit(g, animate, false)
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
    this.updateBuildings()
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
    // moves that issueFit interrupts (or its own instant jump) are handled by issueFit itself
    if (this.issuing) return
    // a gesture that stopped the opening flight shows up as an input on the map just before this moveend
    if (!byUser && this.framing.phase === 'flying' && this.userInputActive()) this.framing.userGesture()
    // MapLibre starts a wheel zoom without an originalEvent (only its moveend carries the wheel event): a move the user
    // made ends an official area's focus hold, and on the overview it is the user's view (not a fly to a fire)
    if (byUser || this.userInputActive()) {
      this.focusHold.release()
      if (useStore.getState().incidentId == null) this.overviewFireFly = false
    }
    this.afterMove(byUser)
  }

  private afterMove(byUser: boolean): void {
    this.activeFly = null
    this.fitMoving = false
    if (this.pendingPadding) {
      this.pendingPadding = false
      this.applySafeInsets(false)
    }
    const wasFlying = this.framing.phase === 'flying'
    if (this.framing.moveEnd(byUser, this.pose())) this.scheduleReissue()
    if (wasFlying && this.framing.phase === 'done') this.framedAt = performance.now()
    // Keep only views worth restoring (framed, kept, or moved by the user); never one mid-flight or while waiting for
    // data: restored on the next mount it would stop the incident from being framed.
    if (this.framing.viewIsSettled()) {
      const p = this.pose()
      useWorkspace.getState().setView({ centerLon: p.lon, centerLat: p.lat, zoom: p.zoom, bearing: p.bearing, pitch: p.pitch })
      // the overview view Back returns to: never one zoomed in far enough to focus a fire again
      if (useStore.getState().incidentId == null && !this.overviewFireFly && p.zoom < FOCUS_OUT_ZOOM) this.overviewView = { lon: p.lon, lat: p.lat, zoom: p.zoom }
      this.scheduleFocus()
    }
    this.updateCamera()
    this.updateAoiInView()
    this.publishFraming()
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

  // ------------------------------------------------------------------------------------------------ focus (decision 10)
  /** Evaluate the focus once the camera has settled (a new move cancels it). */
  private scheduleFocus(): void {
    window.clearTimeout(this.focusTimer)
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = 0
      this.evaluateFocus()
    }, FOCUS_DEBOUNCE_MS)
  }

  /** The visible map area (inside the safe-area padding), its central part and the camera centre, in lon/lat. */
  private focusView(): FocusView {
    const map = this.map
    const pad = map.getPadding()
    const el = map.getContainer()
    const left = pad.left ?? 0
    const top = pad.top ?? 0
    const right = Math.max(left + 1, el.clientWidth - (pad.right ?? 0))
    const bottom = Math.max(top + 1, el.clientHeight - (pad.bottom ?? 0))
    const box = (x0: number, y0: number, x1: number, y1: number): LonLatBox => {
      const pts = [map.unproject([x0, y0]), map.unproject([x1, y0]), map.unproject([x1, y1]), map.unproject([x0, y1])]
      return [Math.min(...pts.map((q) => q.lng)), Math.min(...pts.map((q) => q.lat)), Math.max(...pts.map((q) => q.lng)), Math.max(...pts.map((q) => q.lat))]
    }
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    const fx = ((right - left) * CENTRAL_FRACTION) / 2
    const fy = ((bottom - top) * CENTRAL_FRACTION) / 2
    const c = map.getCenter()
    return { zoom: map.getZoom(), center: [c.lng, c.lat], view: box(left, top, right, bottom), central: box(cx - fx, cy - fy, cx + fx, cy + fy) }
  }

  /** The open fire for the focus rule: its area (manifest grid or list row) and reported point. */
  private currentFocus(): FocusCurrent | null {
    const s = useStore.getState()
    const id = s.incidentId
    if (!id) return null
    const row = findFire(id, s.summary, catalogOf())
    const grid = s.manifest && s.manifest.id === id ? s.manifest.grid : null
    const b = grid?.bbox_lonlat ?? row?.bbox_lonlat ?? null
    const bbox = b && b.length === 4 && b.every(Number.isFinite) ? (b as LonLatBox) : null
    const point: [number, number] | null = row && Number.isFinite(row.lon) && Number.isFinite(row.lat) ? [row.lon, row.lat] : null
    return { id, bbox, point }
  }

  /** Focus the prepared fire the view zooms in on, or return to the overview (decision 10); never moves the camera.
   *  Not during a gesture, a flight or the opening framing. Also refreshes the other fires' outlines. */
  private evaluateFocus(): void {
    // the decision needs only the camera and the lists (not the style); a move or gesture in progress re-schedules it
    // at its end
    if (this.destroyed || this.map.isMoving() || this.userInputActive()) return
    const phase = this.framing.phase
    if (phase === 'waiting' || phase === 'flying') return
    const v = this.focusView()
    this.updateNearby(v)
    const st = useStore.getState()
    // chips for the unprepared fires the view is zoomed in on (never the open one)
    const chips = chipTargets(v, this.overviewSet, st.incidentId ? [st.incidentId] : [])
    if (chips.join(',') !== this.chipIds.join(',')) {
      this.chipIds = chips
      this.applyOverviewState()
    }
    // any prepared fire can be focused, whatever the overview filter (it only decides the markers and the list); while
    // an official area is shown, what is open stays
    const next = focusUnlessHeld(v, allFocusCandidates(catalogOf()), this.currentFocus(), this.focusHold)
    // the store debounces the change; asking for what is shown cancels a request still pending there
    if (next === st.incidentId && (this.focusAsked === undefined || this.focusAsked === next)) return
    this.focusAsked = next
    st.focusIncidentFromMap(next)
  }

  /** Cancel a focus change of ours still pending in the store's debounce (asking for what is shown cancels it). */
  private keepShownFocus(): void {
    const st = useStore.getState()
    if (this.focusAsked === undefined || this.focusAsked === st.incidentId) return
    this.focusAsked = st.incidentId
    st.focusIncidentFromMap(st.incidentId)
  }

  /** Other prepared fires in view (zoom >= NEARBY_MIN_ZOOM), from all three lists like the focus: fetch their
   *  perimeters once; drawn by updateVectors. */
  private updateNearby(v: FocusView): void {
    const c = catalogOf()
    const rows = [...c.live, ...c.season, ...c.historical]
    const list = v.zoom >= NEARBY_MIN_ZOOM ? nearbyFires(rows, v.view, v.center, useStore.getState().incidentId, this.replayTime()) : []
    const same = list.length === this.nearbyList.length && list.every((f, i) => f.id === this.nearbyList[i].id)
    this.nearbyList = list
    for (const f of list)
      if (!this.nearbyLoader.get(f))
        void this.nearbyLoader.load(f).then((b) => {
          if (b && !this.destroyed) this.markDirty('vectors')
        })
    if (!same) this.markDirty('vectors')
  }

  // ------------------------------------------------------------------------------------------------ controls
  private actions(): MapActions {
    const ease = (o: { bearing?: number; pitch?: number }, ms: number) => this.map.easeTo({ ...o, duration: motionMs(ms) })
    return {
      frameFire: () => this.frameRequest('fire'),
      frameArea: () => this.frameRequest('area'),
      frameOverview: () => this.frameRequest('overview'),
      rotateBy: (deg) => ease({ bearing: this.map.getBearing() + deg }, 300),
      tiltBy: (deg) => {
        if (useWorkspace.getState().perspective !== '3d') return
        ease({ pitch: Math.max(0, Math.min(MAX_PITCH_3D, this.map.getPitch() + deg)) }, 300)
      },
      topDown: () => ease({ pitch: 0 }, 450),
      northUp: () => ease({ bearing: 0 }, 450),
      zoomBy: (delta) => {
        // the zoom buttons are the user's move: an official area's focus hold ends
        this.focusHold.release()
        const p = this.framing.pose
        if (this.framing.phase === 'flying' && p) {
          // zooming during the opening flight: relative to where the flight ends, not where it happens to be
          this.framing.explicit()
          this.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(0, Math.min(this.map.getMaxZoom(), p.zoom + delta)), duration: motionMs(FIT_MS) })
          this.publishFraming()
        } else this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: motionMs(250) })
      },
      retryAerial: () => {
        setProvider('imagery', 'idle')
        useWorkspace.getState().setBasemapFallback(null)
      },
    }
  }

  /** The "Incident" / "California" controls: frame the fire, its modeled area or the overview, tracked like a fit. */
  private frameRequest(kind: FrameGoal['kind']): void {
    const g = this.requestGoal(kind)
    if (!g) return
    this.overviewFireFly = false
    this.focusHold.release()
    const cmd = this.framing.request(g)
    this.issueFit(cmd.goal, true, false)
  }

  private requestGoal(kind: FrameGoal['kind']): FrameGoal | null {
    if (kind === 'overview') return { key: 'overview:request', kind: 'overview', provisional: false, bounds: CALIFORNIA_BOUNDS }
    const s = useStore.getState()
    const id = s.incidentId
    if (id == null) return null
    const m = s.manifest && s.manifest.id === id ? s.manifest : null
    if (kind === 'area' && m?.grid) return { key: `area:${id}`, kind: 'area', provisional: false, bounds: aoiBounds(m.grid) }
    const ready = readyManifest(s.manifest)
    const g = goalFor({
      target: id,
      incidentId: id,
      incidentLoading: false,
      summary: s.summary,
      manifest: s.manifest,
      rasters: this.rasters || !ready ? 'settled' : 'expired',
      burned: this.layer('observed_arrival'),
      p90: this.layer('arrival_p90'),
      perimeters: s.perimeters?.perimeters ?? null,
      overviewView: null,
    })
    return g ? { ...g, key: `fire:${id}:request`, kind: 'fire' } : null
  }

  /** The open fire's bounds for others (CONTRACT §13 map: useMapRuntime.fireBounds), once its rasters are in. */
  private updateFireBounds(): void {
    const s = useStore.getState()
    const m = readyManifest(s.manifest)
    let b: LonLatBox | null = null
    if (m && this.rasters) {
      const sum = s.summary && s.summary.id === m.id ? s.summary : null
      b = fireBounds({
        grid: m.grid,
        burned: this.layer('observed_arrival'),
        p90: this.layer('arrival_p90'),
        perimeter: latestPerimeter(s.perimeters?.perimeters),
        point: sum ? { lon: sum.lon, lat: sum.lat } : null,
        acres: sum?.acres,
      })
    }
    const cur = useMapRuntime.getState().fireBounds
    if (cur === b || (cur && b && cur.every((v, i) => v === b[i]))) return
    useMapRuntime.setState({ fireBounds: b })
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
    map.on('movestart', (e: { originalEvent?: unknown }) => {
      // the camera moves again: no focus change until it settles
      window.clearTimeout(this.focusTimer)
      this.focusTimer = 0
      // a gesture (drag, wheel, keys, touch, double click) takes the camera
      if (e.originalEvent == null) return
      this.focusHold.release()
      this.framing.userGesture()
      if (useStore.getState().incidentId == null) this.overviewFireFly = false
      this.publishFraming()
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
      if (k === 'imagery' && this.imageryTimer) {
        window.clearTimeout(this.imageryTimer)
        this.imageryTimer = 0
      }
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

  /** Input on the map itself (not on the chrome): tells a user gesture from a programmatic interruption. */
  private bindInputEvents(container: HTMLElement): void {
    const down = () => {
      this.pointerDown = true
      this.lastInputMs = performance.now()
    }
    const up = () => {
      this.pointerDown = false
    }
    const input = () => {
      this.lastInputMs = performance.now()
    }
    const opts = { capture: true, passive: true } as const
    container.addEventListener('pointerdown', down, opts)
    container.addEventListener('touchstart', down, opts)
    container.addEventListener('wheel', input, opts)
    container.addEventListener('keydown', input, opts)
    const ends = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const
    for (const t of ends) window.addEventListener(t, up, true)
    this.domUnsubs.push(() => {
      container.removeEventListener('pointerdown', down, opts)
      container.removeEventListener('touchstart', down, opts)
      container.removeEventListener('wheel', input, opts)
      container.removeEventListener('keydown', input, opts)
      for (const t of ends) window.removeEventListener(t, up, true)
    })
  }

  private providerOf(sourceId: string): ProviderKey | null {
    if (sourceId === VECTOR_SOURCE) return 'vector'
    if (sourceId === IMAGERY_SOURCE) return 'imagery'
    if (sourceId === TERRAIN_SOURCE || sourceId === HILLSHADE_SOURCE) return 'terrain'
    return null
  }

  /** The aerial style is shown: its first USGS tile must arrive within IMAGERY_FIRST_TILE_MS (a hidden tab waits). */
  private watchImagery(): void {
    window.clearTimeout(this.imageryTimer)
    this.imageryTimer = 0
    if (this.tiles.imagery.ok > 0) return
    const check = () => {
      this.imageryTimer = 0
      if (this.destroyed || useWorkspace.getState().basemap !== 'aerial' || this.tiles.imagery.ok > 0) return
      if (typeof document !== 'undefined' && document.hidden) {
        this.imageryTimer = window.setTimeout(check, IMAGERY_FIRST_TILE_MS)
        return
      }
      this.providerFailed('imagery')
    }
    this.imageryTimer = window.setTimeout(check, IMAGERY_FIRST_TILE_MS)
  }

  private providerFailed(k: ProviderKey): void {
    if (k === 'vector') setProvider('vector', 'failed', 'OpenFreeMap vector tiles are not loading')
    else if (k === 'imagery') {
      setProvider('imagery', 'failed', 'USGS imagery tiles are not loading')
      window.clearTimeout(this.imageryTimer)
      this.imageryTimer = 0
      // fall back to the dark street map: the aerial style (and every USGS request) goes away; never a user pick
      const ws = useWorkspace.getState()
      if (ws.basemap === 'aerial' && ws.basemapFallback == null) ws.setBasemapFallback('dark')
    } else {
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
    const ws = useWorkspace.getState()
    const incidentId = useStore.getState().incidentId
    // a camera icon opens that camera (extras/cameras.ts handles the click); it never selects a location
    const camLayers = present(EXTRAS_HOVER_LAYERS.cameras)
    if (camLayers.length && map.queryRenderedFeatures(e.point, { layers: camLayers }).length) return
    // an unprepared fire's chip, or another fire's perimeter outline: its card (I3), no camera move, never a build
    const cardId = this.cardTargetAt(e.point)
    if (cardId) {
      ws.setFireCard(cardId)
      return
    }
    const evLayers = present([LYR.eventsCircle])
    const hit = evLayers.length ? map.queryRenderedFeatures(e.point, { layers: evLayers }) : []
    const eid = hit[0]?.properties?.eid as string | undefined
    const item = eid ? this.feed.get(eid) : undefined
    if (item) {
      selectFeedItem(item)
      return
    }
    // a fire marker or label (at every zoom, decision 10) opens its card (I3) and flies to it, never a location select
    const fireId = this.fireAt(e.point)
    if (fireId) {
      this.openFireFromOverview(fireId)
      return
    }
    // inside a fire: its own marker or label opens its card
    if (incidentId != null) {
      const own = present([LYR.incidentHit, LYR.incidentCircle, LYR.incidentLabel])
      if (own.length && map.queryRenderedFeatures(e.point, { layers: own }).length) {
        ws.setFireCard(incidentId)
        return
      }
    }
    // a click on the empty map closes an open fire card
    if (ws.fireCardId != null) ws.setFireCard(null)
    // inside an official zone the point is selected as usual (the card lists the zone) and the zone is highlighted
    const zoneLayers = present(EXTRAS_HOVER_LAYERS.zones)
    const zid = zoneLayers.length ? map.queryRenderedFeatures(e.point, { layers: zoneLayers })[0]?.properties?.id : undefined
    useExtrasRuntime.getState().setZoneId(typeof zid === 'string' ? zid : null)
    ws.selectLocation({ lat: e.lngLat.lat, lon: e.lngLat.lng, source: 'click' })
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
      const fires = OVERVIEW_HIT_LAYERS
      const own: readonly string[] = [LYR.incidentHit, LYR.incidentCircle, LYR.incidentLabel]
      const cards: readonly string[] = [OVR.chip, LYR.nearbyLine, LYR.nearbyLabel]
      const ids = [
        LYR.eventsCircle,
        ...cams,
        ...cards,
        ...fires,
        ...own,
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
      // icon, a fire marker (the overview) or the open fire's own marker; an evacuation zone (a large area) only when
      // nothing else is under the pointer
      let f: MapGeoJSONFeature | undefined
      const fireId = this.fireAt(p)
      if (fireId) f = feats.find((x) => fires.includes(x.layer.id) && x.properties?.id === fireId)
      f =
        feats.find((x) => x.layer.id === LYR.eventsCircle) ??
        feats.find((x) => cams.includes(x.layer.id)) ??
        feats.find((x) => x.layer.id === OVR.chip) ??
        f ??
        feats.find((x) => own.includes(x.layer.id)) ??
        feats.find((x) => !zones.includes(x.layer.id) && !fires.includes(x.layer.id)) ??
        feats[0]
      if (!f) {
        this.hideHover()
        return
      }
      const clickable = f.layer.id === LYR.eventsCircle || cams.includes(f.layer.id) || fires.includes(f.layer.id) || own.includes(f.layer.id) || cards.includes(f.layer.id)
      map.getCanvas().style.cursor = clickable ? 'pointer' : ''
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
    /** CAL FIRE's official record of a fire, as text. */
    const calfire = (s: IncidentSummary) => {
      const parts = [s.acres != null ? areaText(s.acres, units).text : 'size not reported']
      if (s.percent_contained != null) parts.push(`${Math.round(s.percent_contained)} % contained`)
      parts.push(fireStatus(s).label)
      line(`CAL FIRE (official): ${parts.join(' · ')}`)
      if (s.updated_ms) line(`Updated ${fmtDateTimeTz(s.updated_ms)}`, 'fxm-tip-hint')
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
    if (f.layer.id === OVR.chip) {
      const s = findFire(String(p.id), useStore.getState().summary, catalogOf())
      line(s?.name ?? String(p.name ?? 'Fire'), 'fxm-tip-title')
      line(String(p.chip))
      line("Open the fire card to prepare the analysis. Fire-3d never prepares one on its own.", 'fxm-tip-hint')
      return el
    }
    if (f.layer.id === LYR.nearbyLine || f.layer.id === LYR.nearbyLabel) {
      line(String(p.name ?? 'Fire'), 'fxm-tip-title')
      line(`Latest agency perimeter${Number.isFinite(Number(p.t)) ? `, ${fmtDateTimeTz(Number(p.t))}` : ''}`)
      line('Another prepared fire: zoom in on it to open its spread, or click for its card', 'fxm-tip-hint')
      return el
    }
    if (OVERVIEW_HIT_LAYERS.includes(f.layer.id)) {
      const s = findFire(String(p.id), useStore.getState().summary, catalogOf())
      if (!s) return null
      line(s.name, 'fxm-tip-title')
      calfire(s)
      line('Click for the fire card', 'fxm-tip-hint')
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
      case LYR.incidentHit:
      case LYR.incidentCircle:
      case LYR.incidentLabel: {
        const s = useStore.getState().summary
        line(String(p.name ?? s?.name ?? 'Incident'), 'fxm-tip-title')
        line('Reported incident location (not the exact ignition point)')
        line(fmtLatLon(Number(p.lat), Number(p.lon)), 'fxm-tip-mono')
        line('Click for the fire card (CAL FIRE status and link)', 'fxm-tip-hint')
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
      this.updateFireBounds()
      // the fire's extent is known now: the opening camera may fly
      this.offerGoal(true)
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
    if (d.vectors) {
      this.updateVectors()
      this.applyOverviewState()
    }
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
    // other prepared fires in view: their perimeter shown at the timeline time in a replay, else the latest
    const t2 = this.replayTime()
    const entries = layers.perimeters ? this.nearbyList.flatMap((fire) => {
      const bundle = this.nearbyLoader.get(fire)
      return bundle && fire.id !== s.incidentId ? [{ fire, bundle }] : []
    }) : []
    const nearKey = entries.map((e) => `${e.fire.id}@${e.fire.builtMs}:${shownPerimeterIndex(e.bundle.perimeters, t2)}`).join('|') || '-'
    if (nearKey !== this.nearbyKey) {
      this.nearbyKey = nearKey
      const { fc } = nearbyPerimeterFeatures(entries, t2)
      this.setData(SRC.nearby, fc)
      patchOverlays({ nearby: fc.features.length })
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
