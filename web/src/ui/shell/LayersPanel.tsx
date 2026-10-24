// Layers & settings (owner: shell, CONTRACT §3; BRIEF §6, §9): the secondary controls of Public/Command — basemap,
// wildfire and optional-source layers, the forecast run shown on the map, units, and the way to the Forensic tools
// (activity lattice, telemetry, visual styles, smoke) that stay off in Public/Command. A non-modal drawer under the
// header's Layers button (a bottom sheet on phones, where it also carries the map legend). Each optional source that
// is switched on shows its panel under its toggle (status, official wording, times, limits, credits and terms).
// Brief 2: Public opens on aerial photos and Command on the dark map unless the user picks a basemap here (a pick wins
// in both presets); on the California overview only the basemap, legend, units and the Forensic pointer apply.
// Brief 4 H4 (decision a): the Public fire view keeps the basemap, the perimeters, the selected location, the official
// and optional sources and the units; the model's and the estimates' toggles (and the forecast run) are Command's, said
// in a note with a link (map/fireProfile.ts PUBLIC_FIRE_HIDDEN).
import { Box, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CameraPanel } from '../../extras/CameraPanel'
import { EvacuationPanel } from '../../extras/EvacuationPanel'
import { zonesBounds } from '../../extras/evacuation'
import { ImageryLayerSummary, ImageryPanel } from '../../extras/ImageryPanel'
import { useExtrasRuntime } from '../../extras/runtime'
import { fmtAt } from '../../lib/time'
import { useTimeFormat } from '../../state/timeZone'
import { MapLegend } from '../../map/MapLegend'
import { fitOfficialBounds } from '../../official/select'
import { BASEMAP_LABEL } from '../../map/providers'
import { useStore } from '../../state/store'
import { DEFAULT_MAP_LAYERS, defaultBasemap, useWorkspace, type Basemap, type MapLayerKey, type Units } from '../../state/workspace'
import { Segmented } from '../controls'
import { ENSEMBLE_LABEL } from '../options'
import { switchWorkspace } from './handoff'
import { NARROW_QUERY, useDrawerFocus, useMediaQuery } from './hooks'
import { OVERVIEW_LEGEND_IN_PANEL_QUERY } from '../public/overviewLayout'
import { PUBLIC_FIRE_HIDDEN } from '../../map/fireProfile'
import { LAYERS_IN_COMMAND } from '../public/fireView'
import { applyView } from './views'

const BASEMAPS: { value: Basemap; desc: string }[] = [
  { value: 'dark', desc: 'Subdued roads and places; fire layers stand out' },
  { value: 'roads', desc: 'Road map with streets, towns and landmarks' },
  { value: 'aerial', desc: 'USGS aerial photos (dated, taken before recent fires; not live) with road and place labels' },
]

const LAYERS: { key: MapLayerKey; label: string; desc: string }[] = [
  { key: 'observed', label: 'Observed fire', desc: 'Burned area reconstructed from satellite detections and perimeters, up to the timeline time' },
  { key: 'perimeters', label: 'Mapped perimeters', desc: 'Agency fire perimeters with the time they were mapped' },
  { key: 'detections', label: 'Satellite heat detections', desc: 'Hotspots seen by satellites; context, not the exact fire edge' },
  { key: 'forecast', label: 'Modeled spread (forecast)', desc: 'Experimental model ensemble, not an evacuation order' },
  { key: 'events', label: 'Event locations', desc: 'Places of the updates in the feed' },
  { key: 'selection', label: 'Selected location', desc: 'Your pin from a search, coordinates or a map click' },
]

type SourceKey = Extract<MapLayerKey, 'evacuation' | 'cameras' | 'recentImagery'>

const SOURCES: { key: SourceKey; label: string; desc: string }[] = [
  { key: 'evacuation', label: 'Evacuation zones (official)', desc: 'Current orders and warnings from local officials, where a state publishes them (California: Cal OES; Oregon: Oregon OEM), with the issuing authority and update time; elsewhere not available in this state' },
  { key: 'cameras', label: 'Public cameras', desc: 'Wildfire and traffic cameras; an image loads only when you ask' },
  { key: 'recentImagery', label: 'Recent satellite imagery', desc: 'Recently acquired scenes with their acquisition time, cloud and resolution; not live' },
]

const UNITS: { value: Units; label: string; tip: string }[] = [
  { value: 'us', label: 'US', tip: 'mph, ft, mi, °F, acres' },
  { value: 'metric', label: 'Metric', tip: 'km/h, m, km, °C, hectares' },
]

function LayerRow({ k, label, desc, bare }: { k: MapLayerKey; label: string; desc: string; bare?: boolean }) {
  const on = useWorkspace((s) => s.mapLayers[k])
  const setMapLayer = useWorkspace((s) => s.setMapLayer)
  const row = (
    <label className="mw-check-row">
      <input type="checkbox" checked={on} onChange={(e) => setMapLayer(k, e.target.checked)} />
      <span className="mw-check-text">
        <span className="mw-check-label">{label}</span>
        <span className="mw-check-desc">{desc}</span>
      </span>
    </label>
  )
  return bare ? row : <li>{row}</li>
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The panel of one optional source, under its toggle while the layer is on (CONTRACT §12.3 item 3). */
function SourcePanel({ k }: { k: SourceKey }) {
  const on = useWorkspace((s) => s.mapLayers[k])
  // wide screens: the Satellite chip's "More images" holds the image list; phones keep it here (the chip is hidden
  // while this sheet is open)
  const narrow = useMediaQuery(NARROW_QUERY)
  const units = useWorkspace((s) => s.units)
  const summary = useStore((s) => s.summary)
  const rt = useExtrasRuntime(
    useShallow((s) => ({
      evac: s.evac,
      cams: s.cams,
      imgs: s.imgs,
      frame: s.frame,
      product: s.product,
      cameraId: s.cameraId,
      zoneId: s.zoneId,
      opacity: s.opacity,
    })),
  )
  if (!on) return null
  const x = useExtrasRuntime.getState()
  if (k === 'evacuation') {
    const showZone = (id: string) => {
      const zone = rt.evac.data?.zones.features.find((f) => f.id === id)
      const b = zone ? zonesBounds([zone]) : null
      x.setZoneId(id)
      // an official area: the map keeps the open fire (fitOfficialBounds marks the flight 'official')
      fitOfficialBounds(b)
    }
    return <EvacuationPanel state={rt.evac} onShowZone={showZone} selectedZoneId={rt.zoneId} />
  }
  if (k === 'cameras')
    return <CameraPanel state={rt.cams} frame={rt.frame} selectedId={rt.cameraId} onSelect={x.setCameraId} centre={summary ? [summary.lon, summary.lat] : null} units={units} />
  if (!narrow) return <ImageryLayerSummary state={rt.imgs} product={rt.product} opacity={rt.opacity} onOpacity={x.setOpacity} />
  return (
    <ImageryPanel
      state={rt.imgs}
      selectedId={rt.product?.id ?? null}
      onSelect={x.setProductChoice}
      opacity={rt.opacity}
      onOpacity={x.setOpacity}
      startedMs={summary?.started_ms ?? null}
    />
  )
}

function SourceRow({ k, label, desc }: { k: SourceKey; label: string; desc: string }) {
  return (
    <li className="mw-source">
      <LayerRow k={k} label={label} desc={desc} bare />
      <div className="mw-source-panel">
        <SourcePanel k={k} />
      </div>
    </li>
  )
}

/** A camera picked on the map opens this drawer: bring its entry (with "Show latest image") into view, and the image
 *  once it has loaded. */
function useRevealSelectedCamera(open: boolean) {
  const cameraId = useExtrasRuntime((s) => s.cameraId)
  const frameReady = useExtrasRuntime((s) => s.frame.cameraId === s.cameraId && s.frame.frame != null)
  useEffect(() => {
    if (!open || !cameraId) return
    const id = requestAnimationFrame(() => {
      document.querySelector('.mw-layers .xs-cam-detail')?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [open, cameraId, frameReady])
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mw-set">
      <div className="mw-set-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function ForecastRunPicker() {
  const command = useWorkspace((s) => s.preset === 'command')
  const tf = useTimeFormat()
  const { runs, runId, mode } = useStore(
    useShallow((s) => ({ runs: s.manifest?.status === 'ready' ? s.manifest.forecasts : [], runId: s.forecastRunId, mode: s.manifest?.mode ?? s.mode })),
  )
  const ready = runs.filter((r) => r.status === 'ready')
  if (ready.length === 0)
    return (
      <p className="mw-set-note">
        No forecast run for this incident
        {mode === 'historical' ? (command ? ' yet. Hindcasts can be run in the Forensic workspace.' : ' yet. A model re-run on past weather can be started in the Forensic workspace.') : ' yet.'}
      </p>
    )
  return (
    <>
      <select className="mw-select" aria-label="Forecast run shown on the map" value={runId ?? ''} onChange={(e) => void useStore.getState().selectForecast(e.target.value || null)}>
        <option value="">No forecast</option>
        {ready.map((r) => (
          <option key={r.run_id} value={r.run_id}>
            Issued {fmtAt(r.issued_ms, tf, { zone: true })} · {r.horizon_h} h · {r.members} runs ({ENSEMBLE_LABEL[r.ensemble] ?? r.ensemble})
          </option>
        ))}
      </select>
      <p className="mw-set-note">The map shows where at least 10 %, 50 % or 90 % of the model runs had burned by the timeline time. It describes the model ensemble, not a certainty.</p>
    </>
  )
}

/** Which basemap the user gets by default, what they picked, and a fallback the map is showing instead. */
function BasemapNote() {
  const preset = useWorkspace((s) => s.preset)
  const pick = useWorkspace((s) => s.basemapPick)
  const fallback = useWorkspace((s) => s.basemapFallback)
  const wanted = pick ?? defaultBasemap(preset)
  if (fallback && fallback !== wanted)
    return (
      <p className="mw-set-note is-warn" role="status">
        {BASEMAP_LABEL[wanted]} is not loading, so the map shows {BASEMAP_LABEL[fallback]}. Pick {BASEMAP_LABEL[wanted]} again to retry.
      </p>
    )
  return (
    <p className="mw-set-note">
      {pick
        ? `Your pick stays in Public and Command. Without one, Public opens on ${BASEMAP_LABEL.aerial} and Command on ${BASEMAP_LABEL.dark}.`
        : `Default for ${preset === 'public' ? 'Public' : 'Command'}: ${BASEMAP_LABEL[defaultBasemap(preset)]}. A basemap you pick here stays in both presets.`}
    </p>
  )
}

export function LayersPanel() {
  const open = useWorkspace((s) => s.panels.layers)
  const basemap = useWorkspace((s) => s.basemap)
  const units = useWorkspace((s) => s.units)
  const command = useWorkspace((s) => s.preset === 'command')
  const overview = useStore((s) => s.incidentId == null)
  // the Public fire view (decision a): no model or estimate toggles here
  const fireView = !command && !overview
  const changed = useWorkspace((s) => (Object.keys(DEFAULT_MAP_LAYERS) as MapLayerKey[]).some((k) => s.mapLayers[k] !== DEFAULT_MAP_LAYERS[k]))
  const narrow = useMediaQuery(NARROW_QUERY)
  // brief 4 H3: below 1200 px the overview has no room for its legend on the map (the fire list needs the height); it
  // is here instead, as on phones
  const overviewLegendHere = useMediaQuery(OVERVIEW_LEGEND_IN_PANEL_QUERY) && overview
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'layers')
  useRevealSelectedCamera(open)
  if (!open) return null
  const ws = useWorkspace.getState()
  return (
    <section className="mw-layers" aria-labelledby="mw-layers-title" data-drawer="layers">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className="mw-panel-head">
        <h2 id="mw-layers-title" ref={heading} tabIndex={-1}>
          Layers &amp; settings
        </h2>
        <button type="button" className="mw-icon-btn" aria-label="Close layers and settings" data-tip="Close (Esc)" onClick={() => ws.setPanel('layers', false)}>
          <X size={15} />
        </button>
      </header>
      <div className="mw-layers-body">
        <Section title="Basemap">
          <div className="mw-basemaps" role="radiogroup" aria-label="Basemap">
            {BASEMAPS.map((b) => (
              <button key={b.value} type="button" role="radio" aria-checked={basemap === b.value} className={`mw-basemap mw-basemap-${b.value}`} onClick={() => ws.setBasemap(b.value)}>
                <span className="mw-basemap-swatch" aria-hidden="true" />
                <span className="mw-basemap-label">{BASEMAP_LABEL[b.value]}</span>
                <span className="mw-basemap-desc">{b.desc}</span>
              </button>
            ))}
          </div>
          <BasemapNote />
        </Section>
        {(narrow || overviewLegendHere) && (
          <Section title="Legend">
            <div className="mw-legend-inline">
              <MapLegend />
            </div>
          </Section>
        )}
        {overview ? (
          <Section title="Fire layers">
            <p className="mw-set-note">Open a fire to choose its map layers, official sources and forecast run. The overview shows CAL FIRE's official records only.</p>
          </Section>
        ) : (
          <>
            <Section
              title="Wildfire layers"
              aside={
                changed ? (
                  <button type="button" className="mw-link-btn" onClick={ws.resetMapLayers}>
                    <RotateCcw size={12} /> Reset
                  </button>
                ) : null
              }
            >
              <ul className="mw-check-list">
                {LAYERS.filter((l) => !fireView || !PUBLIC_FIRE_HIDDEN.includes(l.key)).map((l) => (
                  <LayerRow key={l.key} k={l.key} label={l.label} desc={fireView && l.key === 'perimeters' ? 'The newest agency fire perimeter, filled, with the time it was mapped' : l.desc} />
                ))}
              </ul>
              {fireView && (
                <p className="mw-set-note">
                  {LAYERS_IN_COMMAND}.{' '}
                  <button type="button" className="mw-link-btn" onClick={() => applyView('command')}>
                    Open Command ›
                  </button>
                </p>
              )}
            </Section>
            <Section title="Official and optional sources">
              <ul className="mw-check-list">
                {SOURCES.map((l) => (
                  <SourceRow key={l.key} k={l.key} label={l.label} desc={l.desc} />
                ))}
              </ul>
              <p className="mw-set-note">Fire-3d's modeled spread is experimental and is not an evacuation instruction. Follow local officials.</p>
            </Section>
            {!fireView && (
              <Section title="Forecast shown">
                <ForecastRunPicker />
              </Section>
            )}
          </>
        )}
        <Section title="Units">
          <Segmented value={units} options={UNITS} onChange={ws.setUnits} ariaLabel="Units" size="sm" className="mw-seg-fill" />
        </Section>
        <Section title="Scientific views and visual effects">
          <p className="mw-set-note">
            The activity and slope lattice, detailed telemetry, smoke and the hybrid, realistic and parametric visual styles stay off here. They are in the Forensic
            workspace with the charts, replay, {command ? 'hindcasts' : 'model re-runs on past weather'} and forecast controls.
          </p>
          <button type="button" className="mw-btn is-sm" onClick={() => switchWorkspace('forensic')}>
            <Box size={13} /> {overview ? 'Open Forensic (pick a fire there)' : 'Open Forensic workspace'}
          </button>
        </Section>
      </div>
    </section>
  )
}
