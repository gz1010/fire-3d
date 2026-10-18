// Map legend (owner: map-core; BRIEF §5, §7, §9, CONTRACT §4.3): one entry per visible wildfire / selection layer,
// each with its line style or fill pattern next to the colour (never colour alone). The compact row names the layers
// and the time the forecast refers to; "Details" explains each layer's meaning, source and limits, the model-run
// classes and the forecast display choice, and the optional official sources (evacuation zones, cameras, satellite
// image) with their entries or an explicit status when they cannot be shown. Rendered in the bottom legend slot
// (details open upward) or inline in the Layers panel (details shown in place).
import { ChevronDown, Info } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ExtrasLegend, ExtrasNotice, LegendSwatch } from '../extras/ExtrasCommon'
import { compactExtrasLegend, EXTRAS_LAYER_KEYS, useExtrasLegend, useExtrasStatus } from '../extras/runtime'
import { fmtDateTimeTz } from '../lib/time'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { Segmented } from '../ui/controls'
import { useDismiss, useNow } from '../ui/hooks'
import { useMapRuntime } from './mapStore'
import { DETECTION_RECENT_H, DETECTION_WINDOW_H, GOES_WINDOW_H, RECENT_H, type ForecastView } from './overlayModel'

const VIEWS: { value: ForecastView; label: string; tip: string }[] = [
  { value: 'auto', label: 'Auto', tip: 'Chance by the end of the forecast before it starts; spread by the timeline time inside it' },
  { value: 'time', label: 'By timeline time', tip: 'Share of model runs that had reached each spot by the timeline time' },
  { value: 'horizon', label: 'By forecast end', tip: 'Share of model runs that burned each spot by the end of the forecast period' },
]

function Swatch({ kind }: { kind: string }) {
  return <span className={`fxm-sw fxm-sw-${kind}`} aria-hidden="true" />
}

function Row({ sw, children }: { sw: string; children: ReactNode }) {
  return (
    <li>
      <Swatch kind={sw} />
      <span>{children}</span>
    </li>
  )
}

export function MapLegend({ inline }: { inline?: boolean } = {}) {
  const layers = useWorkspace((s) => s.mapLayers)
  const hasSelection = useWorkspace((s) => s.selection != null)
  const basemap = useWorkspace((s) => s.basemap)
  const overlays = useMapRuntime((s) => s.overlays)
  const forecastView = useMapRuntime((s) => s.forecastView)
  const setForecastView = useMapRuntime((s) => s.setForecastView)
  const forecast = useStore((s) => s.forecast)
  const ready = useStore((s) => s.manifest?.status === 'ready')
  const now = useNow(60_000)
  const extras = useExtrasLegend(now)
  const extrasStatus = useExtrasStatus()
  const extrasCompact = compactExtrasLegend(extras)
  const [open, setOpen] = useState(false)
  const [inPanel, setInPanel] = useState(!!inline)
  const root = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!inline && root.current?.closest('.mw-legend-inline, .mw-layers')) setInPanel(true)
  }, [inline])
  useDismiss(open && !inPanel, [root], () => setOpen(false))

  const fc = overlays.forecast
  const frame = fc.frame
  const obs = overlays.observed
  const det = overlays.detections
  const per = overlays.perimeter
  const showObserved = layers.observed && ready && obs.status !== 'missing' && obs.status !== 'none'
  const showForecast = layers.forecast && ready
  const showDet = layers.detections && det.total > 0
  const showPer = layers.perimeters && per.count > 0
  const showSel = layers.selection && hasSelection

  let fcShort = 'No forecast'
  if (fc.status === 'loading') fcShort = 'Forecast loading…'
  else if (fc.status === 'error') fcShort = 'Forecast unavailable'
  else if (fc.status === 'ready' && frame) {
    if (frame.kind === 'before-start') fcShort = `Forecast starts ${fmtDateTimeTz(frame.startMs)}`
    else fcShort = `Modeled spread by ${fmtDateTimeTz(frame.byMs)}`
  }
  const fcOff = fc.status !== 'ready' || !frame || frame.kind === 'before-start'

  const compact = (
    <ul className="fxm-legend-row" aria-label="Legend">
      {showObserved && <Row sw="observed">Observed fire</Row>}
      {showForecast && <Row sw={fcOff ? 'forecast-off' : 'forecast'}>{fcShort}</Row>}
      {showDet && <Row sw="detection">Heat detections</Row>}
      {showPer && <Row sw="perimeter">Perimeter</Row>}
      {showSel && <Row sw="selection">Selected location</Row>}
      {extrasCompact.map((x) => (
        <li key={x.layer} className="fxm-legend-extra">
          <LegendSwatch entry={x.entry} />
          <span>{x.label}</span>
        </li>
      ))}
      {!showObserved && !showForecast && !showDet && !showPer && !showSel && extrasCompact.length === 0 && <li className="fxm-legend-empty">No wildfire layers shown</li>}
    </ul>
  )

  const details = (
    <div className="fxm-legend-details" id="fxm-legend-details">
      {showObserved && (
        <section>
          <h3>
            <Swatch kind="observed" /> Observed fire
          </h3>
          <p>
            Area burned by the timeline time{obs.asOfMs ? ` (${fmtDateTimeTz(obs.asOfMs)})` : ''}, reconstructed from agency perimeters and satellite heat detections: an
            estimate between observations. Solid glowing edge.
          </p>
          <ul>
            <Row sw="recent">Burned in the {RECENT_H} h before the timeline time</Row>
            <Row sw="observed">Burned earlier</Row>
          </ul>
        </section>
      )}
      {showForecast && (
        <section>
          <h3>
            <Swatch kind={fcOff ? 'forecast-off' : 'forecast'} /> Modeled spread (experimental model)
          </h3>
          {fc.status === 'ready' && frame && forecast ? (
            <>
              <p>
                {frame.kind === 'horizon'
                  ? `Share of the ${fc.members ?? ''} model runs that burned each spot by ${fmtDateTimeTz(frame.byMs)}, the end of the forecast (${forecast.horizon_h} h after ${fmtDateTimeTz(frame.startMs)}).`
                  : frame.kind === 'time'
                    ? `Share of the ${fc.members ?? ''} model runs that had reached each spot by ${fmtDateTimeTz(frame.byMs)}${frame.clamped ? ' (the end of the forecast)' : ''}.`
                    : `The forecast period starts ${fmtDateTimeTz(frame.startMs)}. Move the timeline into it, or show the chance by the end of the forecast.`}{' '}
                Forecast issued {fmtDateTimeTz(forecast.issued_ms)}.
              </p>
              <ul>
                <Row sw="fc90">At least 90 % of runs (hatched)</Row>
                <Row sw="fc50">50–90 % of runs (hatched, dashed outline at 50 %)</Row>
                <Row sw="fc10">10–50 % of runs (dotted outline at 10 %)</Row>
              </ul>
              <p className="fxm-legend-note">
                Spots reached by fewer than 10 % of runs are not shaded. Percentages describe this model ensemble, not a guarantee, and are separate from
                official evacuation orders.
              </p>
            </>
          ) : (
            <p>{fc.status === 'loading' ? 'Loading the forecast…' : fc.status === 'error' ? `The forecast could not be loaded${fc.error ? ` (${fc.error})` : ''}.` : 'No forecast run is available for this incident.'}</p>
          )}
          <div className="fxm-legend-views">
            <span>Show</span>
            <Segmented value={forecastView} options={VIEWS} onChange={setForecastView} ariaLabel="Forecast display" size="sm" />
          </div>
        </section>
      )}
      {showDet && (
        <section>
          <h3>
            <Swatch kind="detection" /> Satellite heat detections
          </h3>
          <p>
            Each mark is one sensor pixel (VIIRS about 375 m, MODIS about 1 km), a dot when zoomed out and the pixel's square when zoomed in: heat was
            detected somewhere inside it, not along an exact fire edge. Shown for the {DETECTION_WINDOW_H} h before the timeline time.
          </p>
          <ul>
            <Row sw="detection">
              Last {DETECTION_RECENT_H} h ({det.counts[0]})
            </Row>
            <Row sw="detection-old">
              {DETECTION_RECENT_H}–{DETECTION_WINDOW_H} h ago ({det.counts[1]})
            </Row>
            <Row sw="detection-goes">
              GOES, last {Math.round(GOES_WINDOW_H * 60)} min ({det.counts[2]}): coarse 2 km pixels, outline only
            </Row>
          </ul>
        </section>
      )}
      {showPer && (
        <section>
          <h3>
            <Swatch kind="perimeter" /> Agency perimeter
          </h3>
          <p>
            Latest published by the timeline time{per.latestMs ? `: ${fmtDateTimeTz(per.latestMs)}` : ''} (solid line, labelled). Earlier perimeters are dashed.
          </p>
        </section>
      )}
      {ready && (
        <section>
          <h3>
            <Swatch kind="aoi" /> Modeled area
          </h3>
          <p>The fire model covers only the area inside the dashed line. Outside it, model results are unknown, not low risk.</p>
        </section>
      )}
      <section>
        <h3>
          <Swatch kind="incident" /> Reported location
        </h3>
        <p>The incident's reported coordinates. This is not the exact ignition point.</p>
      </section>
      {showSel && (
        <section>
          <h3>
            <Swatch kind="selection" /> Selected location
          </h3>
          <p>The point you picked (map click, coordinates or address). A dashed ring marks an approximate position.</p>
        </section>
      )}
      {basemap === 'aerial' && <p className="fxm-legend-note">Aerial basemap: dated USGS orthoimagery, not live satellite imagery.</p>}
      {(extras.length > 0 || Object.keys(extrasStatus).length > 0) && (
        <section className="fxm-legend-extras">
          <h3>Official and optional sources</h3>
          <ExtrasLegend entries={extras} />
          {EXTRAS_LAYER_KEYS.map((k) => {
            const line = extrasStatus[k]
            return line ? <ExtrasNotice key={k} line={line} /> : null
          })}
          {layers.evacuation && <p className="fxm-legend-note">Fire-3d's modeled spread is not an evacuation instruction. Follow local officials.</p>}
        </section>
      )}
    </div>
  )

  if (inPanel)
    return (
      <section ref={root} className="mw-legend fxm-legend is-inline" aria-label="Map legend">
        {compact}
        {details}
      </section>
    )
  return (
    <section ref={root} className="mw-legend fxm-legend" aria-label="Map legend">
      <div className="fxm-legend-anchor">
        {compact}
        <button type="button" className="fxm-legend-toggle" aria-expanded={open} aria-controls="fxm-legend-details" onClick={() => setOpen((o) => !o)} data-tip="What the map layers mean">
          <Info size={13} aria-hidden="true" />
          <span>Details</span>
          <ChevronDown size={12} aria-hidden="true" className={open ? 'is-open' : ''} />
        </button>
        {open && <div className="fxm-legend-pop">{details}</div>}
      </div>
    </section>
  )
}
