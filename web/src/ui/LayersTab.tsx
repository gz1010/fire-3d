// Layers tab (SPEC 9.4): grouped Base / Fire / Parametric / Live & Atmosphere. Each row: checkbox, swatch, label,
// opacity slider and %. Unavailable layers are greyed with a tooltip explaining why. Compact legends appear under
// visible layers whose colours carry meaning (forecast probability, fuels, detections).
import { Eye, EyeOff, Plane, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentManifest } from '../api/types'
import { fmtNumber } from '../lib/format'
import { FUEL_GROUP_COLORS, FUEL_GROUP_NAMES, type FuelGroup } from '../lib/fuels'
import { DEFAULT_LAYERS, useStore, type LayerKey, type VisualStyle } from '../state/store'
import { Checkbox, Slider } from './controls'

interface LayerDef {
  key: LayerKey
  label: string
  tip: string
  icon?: ReactNode
}

interface LayerGroup {
  id: string
  label: string
  layers: LayerDef[]
}

const GROUPS: LayerGroup[] = [
  {
    id: 'base',
    label: 'Base',
    layers: [
      { key: 'terrain', label: 'Terrain (3D)', tip: 'USGS 3DEP DEM relief with sky-view ambient occlusion' },
      { key: 'imagery', label: 'Aerial imagery', tip: 'NAIP aerial photo (USGS), colour-graded' },
      { key: 'trees', label: 'Trees', tip: 'Instanced trees from LANDFIRE canopy cover and height' },
      { key: 'fuels', label: 'Fuels (FBFM40)', tip: 'LANDFIRE Scott & Burgan 40 fuel models' },
      { key: 'burnScar', label: 'Burn scar (dNBR)', tip: 'Sentinel-2 differenced normalized burn ratio' },
    ],
  },
  {
    id: 'fire',
    label: 'Fire',
    layers: [
      { key: 'observedFire', label: 'Observed fire', tip: 'Charred ground and flame front from the reconstructed arrival time' },
      { key: 'isochrones', label: 'Isochrones', tip: 'Lines of equal arrival time (1–12 h steps)' },
      { key: 'forecast', label: 'Forecast probability', tip: 'P(burned by t) from the ensemble arrival quantiles' },
      { key: 'detections', label: 'Detections', tip: 'NASA FIRMS hot pixels: VIIRS, MODIS, Landsat (GOES as faint halos)' },
      { key: 'perimeters', label: 'Perimeters', tip: 'NIFC WFIGS daily fire perimeters' },
      { key: 'ignition', label: 'Ignition', tip: 'Estimated ignition point and time' },
    ],
  },
  {
    id: 'parametric',
    label: 'Parametric',
    layers: [
      { key: 'lattice', label: 'Data lattice', tip: 'Golden dot lattice draped on the terrain (field: View → Lattice field)' },
      { key: 'contours', label: 'Contours', tip: 'Elevation contour lines' },
      { key: 'telemetry', label: 'Telemetry', tip: 'Monospace readouts at the ignition, active fronts and the cursor probe' },
      { key: 'profilePath', label: 'Profile path', tip: 'Path of the elevation profile chart' },
    ],
  },
  {
    id: 'live',
    label: 'Live & Atmosphere',
    layers: [
      { key: 'smoke', label: 'Smoke', tip: 'Smoke plumes from the active front, drifting with the modelled wind' },
      { key: 'wind', label: 'Wind field', tip: 'Wind streaks from the 4×4 weather grid at the current time' },
      { key: 'aircraft', label: 'Aircraft (ADS-B)', tip: 'Firefighting aircraft from open ADS-B data (adsb.lol, or adsb.fi when adsb.lol is unreachable), refreshed every 10 s', icon: <Plane size={12} /> },
    ],
  },
]

interface Ctx {
  manifest: IncidentManifest | null
  hasForecast: boolean
  detections: number
  perimeters: number
  hasWeather: boolean
  profileLen: number
  style: VisualStyle
  aircraft: number
}

/** Why a layer cannot be shown for this incident (null = available). */
function unavailableReason(key: LayerKey, c: Ctx): string | null {
  const m = c.manifest
  if (!m) return 'No incident bundle loaded'
  const has = (n: string) => Boolean(m.layers[n])
  switch (key) {
    case 'imagery':
      return has('naip') ? null : 'NAIP imagery is not available for this area'
    case 'trees':
      return has('trees') ? null : 'No tree layer in this bundle'
    case 'fuels':
      return has('fuel') ? null : 'LANDFIRE fuels are not available'
    case 'burnScar': {
      if (has('burn_severity')) return null
      const w = m.warnings.find((x) => /burn.?severity|dnbr|sentinel/i.test(x))
      return w ?? 'No Sentinel-2 dNBR for this incident yet'
    }
    case 'observedFire':
    case 'isochrones':
      return has('observed_arrival') ? null : 'No observed arrival-time layer'
    case 'forecast':
      return c.hasForecast ? null : m.forecasts.some((f) => f.status === 'ready') ? 'Select a forecast run in the Analysis tab' : 'Run a forecast in the Analysis tab'
    case 'detections':
      return c.detections > 0 ? null : 'No satellite detections in this bundle'
    case 'perimeters':
      return c.perimeters > 0 ? null : 'No NIFC perimeters matched this fire'
    case 'ignition':
      return m.ignition ? null : 'Ignition point unknown'
    case 'wind':
      return c.hasWeather ? null : 'No weather in this bundle'
    case 'aircraft':
      return m.mode === 'live' ? null : 'ADS-B aircraft are shown for live incidents only'
    case 'profilePath':
      return c.profileLen >= 2 ? null : 'Draw a path: Analysis → Draw elevation profile path'
    default:
      return null
  }
}

function styleNote(key: LayerKey, style: VisualStyle): string | null {
  if (style === 'realistic' && (key === 'lattice' || key === 'telemetry')) return 'Hidden in the Realistic style'
  return null
}

function meta(key: LayerKey, c: Ctx): string | null {
  const m = c.manifest
  if (!m) return null
  switch (key) {
    case 'fuels':
      return m.fuels_edition || null
    case 'detections':
      return c.detections ? fmtNumber(c.detections) : null
    case 'perimeters':
      return c.perimeters ? String(c.perimeters) : null
    case 'aircraft':
      return m.mode === 'live' ? String(c.aircraft) : null
    default:
      return null
  }
}

export function LayersTab() {
  const { layers, ...rest } = useStore(
    useShallow((s) => ({
      layers: s.layers,
      manifest: s.manifest,
      hasForecast: s.forecast != null,
      detections: s.detections?.detections.length ?? 0,
      perimeters: s.perimeters?.perimeters.length ?? 0,
      hasWeather: s.weather != null,
      profileLen: s.profilePath.length,
      style: s.visualStyle,
      aircraft: s.aircraft.filter((a) => a.is_fire_aircraft).length,
    })),
  )
  const ctx: Ctx = rest
  const st = useStore.getState
  return (
    <div className="layers">
      {GROUPS.map((g) => {
        const avail = g.layers.filter((l) => !unavailableReason(l.key, ctx))
        const on = avail.filter((l) => layers[l.key].visible).length
        const allOn = avail.length > 0 && on === avail.length
        return (
          <div key={g.id} className="lg">
            <div className="lg-head">
              <span className="eyebrow">{g.label}</span>
              <span className="lg-count mono">
                {on}/{g.layers.length}
              </span>
              <span className="lg-line" />
              <button
                type="button"
                className="lg-toggle"
                disabled={avail.length === 0}
                data-tip={allOn ? `Hide all ${g.label} layers` : `Show all ${g.label} layers`}
                aria-label={allOn ? `Hide all ${g.label} layers` : `Show all ${g.label} layers`}
                onClick={() => avail.forEach((l) => st().setLayerVisible(l.key, !allOn))}
              >
                {allOn ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
            {g.layers.map((l) => (
              <LayerRow key={l.key} def={l} ctx={ctx} visible={layers[l.key].visible} opacity={layers[l.key].opacity} />
            ))}
          </div>
        )
      })}
      <div className="layers-foot">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => st().resetLayers()}>
          <RotateCcw size={12} /> Reset to defaults
        </button>
        <span className="muted">Double-click a % to reset it</span>
      </div>
    </div>
  )
}

function LayerRow({ def, ctx, visible, opacity }: { def: LayerDef; ctx: Ctx; visible: boolean; opacity: number }) {
  const reason = unavailableReason(def.key, ctx)
  const note = reason ? null : styleNote(def.key, ctx.style)
  const disabled = reason != null
  const st = useStore.getState
  const m = meta(def.key, ctx)
  const tip = reason ?? (note ? `${def.tip} · ${note}` : def.tip)
  return (
    <>
      <div className={`lrow ${disabled ? 'is-unavailable' : ''} ${visible && !disabled ? 'is-on' : ''} ${note ? 'is-styled-off' : ''}`}>
        <Checkbox checked={visible && !disabled} disabled={disabled} label={`Show ${def.label}`} onChange={(v) => st().setLayerVisible(def.key, v)} />
        <span className={`sw sw-${def.key}`} aria-hidden>
          {def.icon}
        </span>
        <button type="button" className="lrow-label" disabled={disabled} data-tip={tip} onClick={() => st().toggleLayer(def.key)}>
          <span className="ellipsis">{def.label}</span>
          {m && <span className="lrow-meta mono">{m}</span>}
        </button>
        <Slider
          className="lrow-slider"
          label={`${def.label} opacity`}
          value={opacity}
          disabled={disabled}
          onChange={(v) => st().setLayerOpacity(def.key, v)}
        />
        <button
          type="button"
          className="lrow-pct mono"
          disabled={disabled}
          onDoubleClick={() => st().setLayerOpacity(def.key, DEFAULT_LAYERS[def.key].opacity)}
          aria-label={`${def.label} opacity ${Math.round(opacity * 100)}%`}
        >
          {Math.round(opacity * 100)}%
        </button>
      </div>
      {visible && !disabled && <Legend layer={def.key} />}
    </>
  )
}

const FUEL_GROUPS: FuelGroup[] = ['GR', 'GS', 'SH', 'TU', 'TL', 'SB', 'NB']

function Legend({ layer }: { layer: LayerKey }) {
  if (layer === 'forecast')
    return (
      <div className="legend">
        <span className="legend-ramp ramp-prob" />
        <span className="legend-ticks mono">
          <i style={{ left: '10%' }}>10</i>
          <i style={{ left: '50%' }}>50</i>
          <i style={{ left: '90%' }}>90%</i>
        </span>
        <span className="legend-cap">P(burned by t)</span>
      </div>
    )
  if (layer === 'fuels')
    return (
      <div className="legend legend-wrap">
        {FUEL_GROUPS.map((g) => (
          <span key={g} className="legend-chip" data-tip={FUEL_GROUP_NAMES[g]}>
            <i style={{ background: FUEL_GROUP_COLORS[g] }} />
            {g}
          </span>
        ))}
      </div>
    )
  if (layer === 'detections')
    return (
      <div className="legend legend-wrap">
        <span className="legend-chip" data-tip="VIIRS 375 m footprint">
          <i className="det-v" />
          VIIRS
        </span>
        <span className="legend-chip" data-tip="MODIS 1 km footprint">
          <i className="det-m" />
          MODIS
        </span>
        <span className="legend-chip" data-tip="Landsat 30 m">
          <i className="det-l" />
          Landsat
        </span>
        <span className="legend-chip" data-tip="GOES ~2 km, timing only (faint halo)">
          <i className="det-g" />
          GOES
        </span>
        <span className="legend-age" data-tip="Colour by age: ≤ 12 h bright, older dimmer">
          <span className="legend-ramp ramp-age" />
          <span className="mono">age</span>
        </span>
      </div>
    )
  return null
}
