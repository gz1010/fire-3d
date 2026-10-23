// Dev-only test page for the optional sources (extras-dev.html): its own minimal MapLibre map (OpenFreeMap dark)
// around a real incident, the three layer handles, panels, legend, feed items and credits exactly as ui-integration
// will mount them. window.__extrasDev exposes controls for screenshot scripts.
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature } from 'geojson'
import { Map as MapLibreMap, NavigationControl, ScaleControl, type GeoJSONSource } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'
import { getIncident } from '../../api/client'
import type { IncidentDetailResponse } from '../../api/types'
import { nowMarkerMs } from '../../state/store'
import { useNow } from '../../ui/hooks'
import { cameraFeedItems, cameraLegend, mountCameraLayer, type CameraLayerHandle } from '../cameras'
import { CameraPanel } from '../CameraPanel'
import { DEFAULT_MARGIN_KM, extrasAtMs, incidentAreaBbox, type BBox } from '../client'
import { EVAC_LAYERS, evacuationFeedItems, evacuationLegend, mountEvacuationLayer, zonesBounds, type EvacuationLayerHandle } from '../evacuation'
import { EvacuationPanel } from '../EvacuationPanel'
import { ExtrasLegend } from '../ExtrasCommon'
import { fmtWhen } from '../format'
import { useCameraFrame, useCameras, useEvacuations, useImagery } from '../hooks'
import { cameraCredits, evacuationCredits, imageryCredits } from '../credits'
import { imageryFeedItems, imageryLegend, mountImageryLayer, pickDefaultImagery, type ImageryLayerHandle } from '../imagery'
import { ImageryPanel } from '../ImageryPanel'
import { DEV_PRESETS, resolveTime } from './presets'

const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark'
type LayerKey = 'evacuation' | 'cameras' | 'recentImagery'

interface DevControls {
  setPreset(id: string, timeIndex?: number): void
  setTime(index: number): void
  setLayers(l: Partial<Record<LayerKey, boolean>>): void
  selectProduct(id: string | null | 'default'): void
  selectCamera(id: string | null): void
  /** Fit the map to the official zones shown (Normal / Training zones are not drawn). */
  fitZones(): void
  /** Jump to a view (alignment checks). */
  view(lon: number, lat: number, zoom: number): void
  setOpacity(v: number): void
  requestFrame(): void
  state(): Record<string, unknown>
}

declare global {
  interface Window {
    __extrasDev?: DevControls
  }
}

/** Screenshot scripts drive the page through window.__extrasDev (re-published after every render). */
function exposeDevControls(c: DevControls): void {
  window.__extrasDev = c
}

function initialPreset(): { id: string; time: number } {
  const p = new URLSearchParams(window.location.search)
  const id = p.get('preset') ?? 'cooley'
  return { id: DEV_PRESETS.some((d) => d.id === id && !d.standalone) ? id : 'cooley', time: Number(p.get('time') ?? 0) || 0 }
}

/** fitBounds padding that keeps the area clear of the dev chrome (side panels on the right, or a bottom sheet). */
function framePadding(map: MapLibreMap, extra = 0): { top: number; bottom: number; left: number; right: number } {
  const { clientWidth: w, clientHeight: h } = map.getContainer()
  if (w < 900) return { top: 230 + extra, bottom: Math.round(h * 0.45) + 16, left: 56, right: 24 }
  return { top: 110 + extra, bottom: 220, left: 70 + extra, right: 450 }
}

function rect(b: BBox): Feature {
  return {
    type: 'Feature',
    properties: { kind: 'area' },
    geometry: { type: 'LineString', coordinates: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] },
  }
}

export function DevApp() {
  const [init] = useState(initialPreset)
  const [presetId, setPresetId] = useState(init.id)
  const [timeIdx, setTimeIdx] = useState(init.time)
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ evacuation: true, cameras: true, recentImagery: false })
  const [detail, setDetail] = useState<{ id: string; data: IncidentDetailResponse | null; error: string | null } | null>(null)
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [productChoice, setProductChoice] = useState<string | null | undefined>(undefined) // undefined = automatic
  const [opacity, setOpacity] = useState(0.9)
  const [zoneId, setZoneId] = useState<string | null>(null)
  const now = useNow(60_000)
  const frame = useCameraFrame()

  const preset = DEV_PRESETS.find((p) => p.id === presetId) ?? DEV_PRESETS[0]
  const time = preset.times[Math.min(timeIdx, preset.times.length - 1)]

  useEffect(() => {
    if (!preset.incidentId) return
    const id = preset.incidentId
    const ctrl = new AbortController()
    getIncident(id, { signal: ctrl.signal })
      .then((data) => setDetail({ id, data, error: null }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setDetail({ id, data: null, error: String(e) })
      })
    return () => ctrl.abort()
  }, [preset.incidentId])

  const d = preset.incidentId && detail?.id === preset.incidentId ? detail.data : null
  const summary = d?.summary ?? (preset.point ? { lat: preset.point.lat, lon: preset.point.lon } : null)
  const manifest = d?.manifest?.status === 'ready' ? d.manifest : null
  const startedMs = d?.summary.started_ms ?? preset.point?.startedMs ?? null
  // the timeline's NOW marker (live: latest observation): at / after it current-only sources show current status
  const markerMs = nowMarkerMs(manifest, null)
  const timeMs = resolveTime(time, now, markerMs)
  const evacBbox = incidentAreaBbox(summary, manifest, DEFAULT_MARGIN_KM.evacuations)
  const camBbox = incidentAreaBbox(summary, manifest, DEFAULT_MARGIN_KM.cameras)
  const imgBbox = incidentAreaBbox(summary, manifest, DEFAULT_MARGIN_KM.imagery)
  const ready = preset.incidentId ? d != null : true

  const evac = useEvacuations(ready && evacBbox ? { bbox: evacBbox, incident: preset.incidentId, atMs: extrasAtMs('evacuations', preset.mode, timeMs, now, markerMs) } : null, layers.evacuation)
  const cams = useCameras(ready && camBbox ? { bbox: camBbox, incident: preset.incidentId, atMs: extrasAtMs('cameras', preset.mode, timeMs, now, markerMs) } : null, layers.cameras)
  const imgs = useImagery(ready && imgBbox ? { bbox: imgBbox, incident: preset.incidentId, atMs: extrasAtMs('imagery', preset.mode, timeMs, now, markerMs) } : null, layers.recentImagery)

  const product = productChoice === undefined ? pickDefaultImagery(imgs.data, startedMs) : (imgs.data?.products.find((p) => p.id === productChoice) ?? null)

  // ---- map
  const container = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const handles = useRef<{ evac: EvacuationLayerHandle; cams: CameraLayerHandle; img: ImageryLayerHandle } | null>(null)
  const [mapReady, setMapReady] = useState(false)

  useEffect(() => {
    if (!container.current) return
    const map = new MapLibreMap({ container: container.current, style: DARK_STYLE, center: [-120, 37.5], zoom: 5.5, attributionControl: false })
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-left')
    map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left')
    // the OpenFreeMap dark style references sprite icons it does not ship ('circle-11'): fill them with a blank
    // image (never the extras' own ids, which their handles add before any layer uses them)
    map.on('styleimagemissing', (e: { id: string }) => {
      if (!e.id.startsWith('fx-extras-') && !map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) })
    })
    mapRef.current = map
    handles.current = {
      img: mountImageryLayer(map, { visible: false, beforeId: EVAC_LAYERS.tint }),
      evac: mountEvacuationLayer(map, { visible: true }),
      cams: mountCameraLayer(map, { visible: true, onSelect: (id) => setCameraId(id) }),
    }
    const addContext = () => {
      if (map.getSource('dev-context')) return
      map.addSource('dev-context', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: 'dev-area', type: 'line', source: 'dev-context', filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-color': 'rgba(232,237,243,0.5)', 'line-width': 1.2, 'line-dasharray': [4, 3] } })
      map.addLayer({
        id: 'dev-incident',
        type: 'circle',
        source: 'dev-context',
        filter: ['==', ['get', 'kind'], 'incident'],
        paint: { 'circle-radius': 6, 'circle-color': '#ff5a1f', 'circle-stroke-color': '#0b1119', 'circle-stroke-width': 2 },
      })
      map.addLayer({
        id: 'dev-incident-label',
        type: 'symbol',
        source: 'dev-context',
        filter: ['==', ['get', 'kind'], 'incident'],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 13, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
        paint: { 'text-color': '#ffd2bf', 'text-halo-color': 'rgba(8,12,18,0.92)', 'text-halo-width': 1.6 },
      })
      setMapReady(true)
    }
    map.on('load', addContext)
    map.on('style.load', addContext)
    return () => {
      handles.current?.evac.remove()
      handles.current?.cams.remove()
      handles.current?.img.remove()
      handles.current = null
      mapRef.current = null
      map.remove()
    }
  }, [])

  useEffect(() => handles.current?.evac.setData(layers.evacuation ? evac.data : null), [evac.data, layers.evacuation])
  useEffect(() => handles.current?.cams.setData(layers.cameras ? cams.data : null), [cams.data, layers.cameras])
  useEffect(() => handles.current?.cams.setSelected(cameraId), [cameraId])
  useEffect(() => handles.current?.img.setProduct(layers.recentImagery ? product : null), [product, layers.recentImagery])
  useEffect(() => handles.current?.img.setOpacity(opacity), [opacity])
  useEffect(() => {
    handles.current?.evac.setVisible(layers.evacuation)
    handles.current?.cams.setVisible(layers.cameras)
    handles.current?.img.setVisible(layers.recentImagery)
  }, [layers])

  // frame the area and draw the context (query area, reported location); primitive deps only
  const areaKey = evacBbox ? evacBbox.map((v) => v.toFixed(4)).join(',') : ''
  const pointLon = summary?.lon ?? null
  const pointLat = summary?.lat ?? null
  const pointName = d?.summary.name ?? preset.point?.name ?? ''
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !areaKey) return
    const b = areaKey.split(',').map(Number) as BBox
    const src = map.getSource('dev-context') as GeoJSONSource | undefined
    const features: Feature[] = [rect(b)]
    if (pointLon != null && pointLat != null) {
      features.push({ type: 'Feature', properties: { kind: 'incident', name: `${pointName} (reported location)` }, geometry: { type: 'Point', coordinates: [pointLon, pointLat] } })
    }
    src?.setData({ type: 'FeatureCollection', features })
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: framePadding(map), duration: 0 })
  }, [areaKey, pointLon, pointLat, pointName, mapReady])

  const fit = (b: BBox | null, maxZoom = 14) => {
    const map = mapRef.current
    if (b && map) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: framePadding(map, 10), maxZoom, duration: 0 })
  }
  const shownZones = () => (evac.data?.status === 'available' ? evac.data.zones.features.filter((f) => !['normal', 'training'].includes(f.properties.status_key)) : [])
  const showZone = (id: string) => {
    const z = shownZones().find((f) => f.id === id)
    if (!z) return
    setZoneId(id)
    fit(zonesBounds([z]))
  }

  // ---- controls for screenshot scripts
  const ctl = useRef<DevControls | null>(null)
  useEffect(() => {
    ctl.current = {
      setPreset: (id, t = 0) => {
        if (DEV_PRESETS.find((p) => p.id === id)?.standalone) {
          window.location.search = `?preset=${id}`
          return
        }
        setPresetId(id)
        setTimeIdx(t)
        setCameraId(null)
        setProductChoice(undefined)
        frame.clear()
      },
      setTime: (i) => setTimeIdx(i),
      setLayers: (l) => setLayers((s) => ({ ...s, ...l })),
      selectProduct: (id) => setProductChoice(id === 'default' ? undefined : id),
      selectCamera: (id) => setCameraId(id),
      fitZones: () => fit(zonesBounds(shownZones())),
      view: (lon, lat, zoom) => mapRef.current?.jumpTo({ center: [lon, lat], zoom }),
      setOpacity: (v) => setOpacity(v),
      requestFrame: () => {
        if (cameraId) frame.request(cameraId)
      },
      state: () => ({
        preset: presetId,
        timeMs,
        evac: evac.data?.status ?? null,
        evacZones: evac.data?.zones.features.length ?? null,
        cams: cams.data?.status ?? null,
        camCount: cams.data?.cameras.features.length ?? null,
        imagery: imgs.data?.status ?? null,
        products: imgs.data?.products.map((p) => p.id) ?? [],
        product: product?.id ?? null,
        frame: frame.frame?.status ?? null,
        loading: evac.loading || cams.loading || imgs.loading,
      }),
    }
    exposeDevControls(ctl.current)
  })

  const legend = [...evacuationLegend(layers.evacuation ? evac.data : null), ...cameraLegend(layers.cameras ? cams.data : null), ...imageryLegend(layers.recentImagery ? product : null, imgs.data?.reference_ms ?? now)]
  const timeRange: [number, number] | null = manifest?.time_range ? [manifest.time_range.start_ms, manifest.time_range.end_ms] : null
  const feed = [
    ...evacuationFeedItems(layers.evacuation ? evac.data : null, manifest),
    ...cameraFeedItems(layers.cameras ? cams.data : null),
    ...imageryFeedItems(layers.recentImagery ? imgs.data : null, timeRange, startedMs),
  ].sort((a, b) => b.tMs - a.tMs)
  const credits = [
    'OpenFreeMap',
    '© OpenMapTiles',
    '© OpenStreetMap contributors',
    'MapLibre',
    ...[
      ...(layers.evacuation ? evacuationCredits(evac.data) : []),
      ...(layers.cameras ? cameraCredits(cams.data) : []),
      ...(layers.recentImagery ? imageryCredits(product, imgs.data) : []),
    ].map((c) => c.text),
  ]

  return (
    <div className="xd-root">
      <div ref={container} className="xd-map" aria-label="Map" />
      <div className="xd-top">
      <header className="xd-bar">
        <strong className="xd-title">Fire-3d · optional sources (dev)</strong>
        <div className="xd-group" role="group" aria-label="Incident">
          {DEV_PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === presetId} onClick={() => ctl.current?.setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="xd-group" role="group" aria-label="Time">
          {preset.times.map((t, i) => (
            <button key={t.label} type="button" aria-pressed={i === timeIdx} onClick={() => setTimeIdx(i)}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="xd-sub">
        <div className="xd-group" role="group" aria-label="Layers">
          {(['evacuation', 'cameras', 'recentImagery'] as const).map((k) => (
            <label key={k} className="xd-check">
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} />
              {k === 'evacuation' ? 'Evacuation zones' : k === 'cameras' ? 'Cameras' : 'Recent imagery'}
            </label>
          ))}
        </div>
        <div className="xd-when">
          {preset.mode === 'live' ? 'Live' : 'Replay'} · selected time {fmtWhen(timeMs, now)}
          {preset.mode === 'live' && markerMs != null ? ` · NOW marker (latest observation) ${fmtWhen(markerMs, now)}` : ''}
          {preset.point ? ` · ${preset.point.note}` : ''}
          {detail?.error ? ` · incident failed to load: ${detail.error}` : ''}
        </div>
      </div>
      </div>
      <aside className="xd-side">
        {layers.evacuation && <EvacuationPanel state={evac} onShowZone={showZone} selectedZoneId={zoneId} />}
        {layers.cameras && <CameraPanel state={cams} frame={frame} selectedId={cameraId} onSelect={setCameraId} centre={summary ? [summary.lon, summary.lat] : null} />}
        {layers.recentImagery && (
          <ImageryPanel state={imgs} selectedId={product?.id ?? null} onSelect={(id) => setProductChoice(id)} opacity={opacity} onOpacity={setOpacity} startedMs={startedMs} />
        )}
      </aside>
      <div className="xd-bottom">
        {legend.length > 0 && (
          <div className="xd-card">
            <div className="xd-card-title">Legend</div>
            <ExtrasLegend entries={legend} />
          </div>
        )}
        {feed.length > 0 && (
          <div className="xd-card xd-feed">
            <div className="xd-card-title">Feed items (preview)</div>
            <ul>
              {feed.slice(0, 5).map((f) => (
                <li key={f.id}>
                  <span className="xd-feed-title">{f.title}</span>
                  <span className="xd-feed-meta">
                    {f.kind} · {fmtWhen(f.tMs, now)} · {f.source}
                    {f.seekable ? '' : ' · not seekable'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="xd-attrib">{credits.join(' · ')}</div>
    </div>
  )
}
