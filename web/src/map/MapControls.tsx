// Small map controls (owner: map-core; BRIEF §3, CONTRACT §4.1): 2D/3D perspective, a quick basemap switch, a compass
// that shows the bearing and resets north, zoom out / in, and "Return to incident". All are buttons (keyboard and
// screen-reader accessible); camera moves honour prefers-reduced-motion.
import { Crosshair, Minus, Plus } from 'lucide-react'
import { Segmented, SelectMenu } from '../ui/controls'
import { useWorkspace, type Basemap, type Perspective } from '../state/workspace'
import { motionMs, useMapRuntime } from './mapStore'
import { BASEMAP_DESCRIPTION, BASEMAP_LABEL, BASEMAP_SHORT } from './providers'

const PERSPECTIVES: { value: Perspective; label: string; tip: string }[] = [
  { value: '2d', label: '2D', tip: 'Top-down map, north up' },
  { value: '3d', label: '3D', tip: 'Terrain with a tilted camera' },
]

const BASEMAPS: Basemap[] = ['dark', 'roads', 'aerial']

export function MapControls() {
  const perspective = useWorkspace((s) => s.perspective)
  const setPerspective = useWorkspace((s) => s.setPerspective)
  const basemap = useWorkspace((s) => s.basemap)
  const setBasemap = useWorkspace((s) => s.setBasemap)
  const returnToIncident = useWorkspace((s) => s.returnToIncident)
  const map = useMapRuntime((s) => s.map)
  const bearing = useMapRuntime((s) => s.camera?.bearing ?? 0)
  const pitch = useMapRuntime((s) => s.camera?.pitch ?? 0)
  const rotated = Math.abs(bearing) > 0.5
  const compassLabel = rotated ? `Reset north (map rotated ${Math.round(((bearing % 360) + 360) % 360)}°)` : 'North is up'
  return (
    <div className="mw-ctl fxm-ctl" role="toolbar" aria-label="Map controls">
      <Segmented value={perspective} options={PERSPECTIVES} onChange={setPerspective} ariaLabel="Perspective" size="sm" />
      <SelectMenu
        value={basemap}
        onChange={setBasemap}
        label={`Basemap: ${BASEMAP_LABEL[basemap]}`}
        tip="Basemap"
        placement="bottom-end"
        width={250}
        className="fxm-basemap-btn"
        display={
          <>
            <span className="fxm-bm-long">{BASEMAP_LABEL[basemap]}</span>
            <span className="fxm-bm-short">{BASEMAP_SHORT[basemap]}</span>
          </>
        }
        options={BASEMAPS.map((b) => ({ value: b, label: BASEMAP_LABEL[b], hint: BASEMAP_DESCRIPTION[b] }))}
      />
      <span className="fxm-ctl-sep" aria-hidden="true" />
      <button
        type="button"
        className={`fxm-icon-btn fxm-compass ${rotated ? 'is-rotated' : ''}`}
        aria-label={compassLabel}
        data-tip={compassLabel}
        disabled={!map}
        onClick={() => map?.easeTo({ bearing: 0, duration: motionMs(500) })}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
          <path d="M10 2.2 13 10h-6z" className="fxm-compass-n" />
          <path d="M10 17.8 7 10h6z" className="fxm-compass-s" />
        </svg>
        {perspective === '3d' && <span className="fxm-pitch mw-mono" aria-hidden="true">{Math.round(pitch)}°</span>}
      </button>
      <button type="button" className="fxm-icon-btn" aria-label="Zoom out" data-tip="Zoom out" disabled={!map} onClick={() => map?.zoomOut({ duration: motionMs(250) })}>
        <Minus size={15} aria-hidden="true" />
      </button>
      <button type="button" className="fxm-icon-btn" aria-label="Zoom in" data-tip="Zoom in" disabled={!map} onClick={() => map?.zoomIn({ duration: motionMs(250) })}>
        <Plus size={15} aria-hidden="true" />
      </button>
      <button type="button" className="mw-btn fxm-return" aria-label="Return to incident" data-tip="Frame the incident and its modeled area" onClick={returnToIncident}>
        <Crosshair size={14} aria-hidden="true" />
        <span>Incident</span>
      </button>
    </div>
  )
}
