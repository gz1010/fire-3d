// Small map controls (owner: map-core; BRIEF §3, CONTRACT §4.1): 2D/3D perspective, a quick basemap switch, a compass
// that shows the bearing and resets north, zoom out / in, and the framing button ("Incident" inside a fire: the fire,
// then its modeled area; "All states" on the overview: the lower 48). In 3D an orbit group sits under them (brief 2, O-R14): rotate
// 15° either way, tilt ±10°, "Top-down" (pitch 0, terrain kept) and "North up", with a one-time gesture hint. All are
// buttons (keyboard and screen-reader accessible); camera moves go through the controller (useMapRuntime.actions), so
// the opening camera knows about them, and honour prefers-reduced-motion.
import { ChevronsDown, ChevronsUp, Crosshair, Map as MapIcon, Minus, Plus, RotateCcw, RotateCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { controlsShift, useSearchUi } from '../location/searchUi'
import { useNarrow } from '../location/useNarrow'
import { useStore } from '../state/store'
import { useWorkspace, type Basemap, type PanelKey, type Perspective } from '../state/workspace'
import { Segmented, SelectMenu } from '../ui/controls'
import { useMapRuntime } from './mapStore'
import { aerialPhotoLine, BASEMAP_DESCRIPTION, BASEMAP_LABEL, BASEMAP_SHORT } from './providers'

const PERSPECTIVES: { value: Perspective; label: string; tip: string }[] = [
  { value: '2d', label: '2D', tip: 'Top-down map, north up' },
  { value: '3d', label: '3D', tip: 'Terrain with a tilted camera; rotate and tilt with the buttons below' },
]

const BASEMAPS: Basemap[] = ['dark', 'roads', 'aerial']

/** localStorage key: the 3D gesture hint was shown (per browser; storage may be unavailable). */
const HINT_KEY = 'fire3d.orbitHintSeen'
const HINT_MS = 12_000

function hintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return true
  }
}

function markHintSeen(): void {
  try {
    window.localStorage.setItem(HINT_KEY, '1')
  } catch {
    // storage unavailable: the hint simply shows again next time
  }
}

/** The 3D orbit group and its one-time gesture hint. */
function OrbitGroup({ pitch }: { pitch: number }) {
  const actions = useMapRuntime((s) => s.actions)
  const [hint, setHint] = useState(() => !hintSeen())
  useEffect(() => {
    if (!hint) return
    markHintSeen()
    const t = window.setTimeout(() => setHint(false), HINT_MS)
    return () => window.clearTimeout(t)
  }, [hint])
  const btn = (label: string, onClick: () => void, icon: ReactNode, disabled = false) => (
    <button type="button" className="fxm-icon-btn" aria-label={label} data-tip={label} disabled={!actions || disabled} onClick={onClick}>
      {icon}
    </button>
  )
  return (
    <div className="fxm-orbit" role="group" aria-label="Rotate and tilt the 3D view">
      {btn('Rotate left 15°', () => actions?.rotateBy(-15), <RotateCcw size={15} aria-hidden="true" />)}
      {btn('Rotate right 15°', () => actions?.rotateBy(15), <RotateCw size={15} aria-hidden="true" />)}
      <span className="fxm-ctl-sep" aria-hidden="true" />
      {btn('Tilt more (+10°)', () => actions?.tiltBy(10), <ChevronsUp size={15} aria-hidden="true" />, pitch >= 79.5)}
      {btn('Tilt less (−10°)', () => actions?.tiltBy(-10), <ChevronsDown size={15} aria-hidden="true" />, pitch <= 0.5)}
      <button type="button" className="mw-btn fxm-orbit-text" data-tip="Look straight down; terrain stays on" disabled={!actions || pitch <= 0.5} onClick={() => actions?.topDown()}>
        Top-down
      </button>
      <button type="button" className="mw-btn fxm-orbit-text" data-tip="Turn the map so north is up" disabled={!actions} onClick={() => actions?.northUp()}>
        North up
      </button>
      {hint && (
        <div className="fxm-orbit-hint" role="note">
          <span>Rotate and tilt: right-drag or Ctrl + drag with a mouse, two fingers on touch screens, or Shift + arrow keys on the map.</span>
          <button
            type="button"
            className="fxm-notice-close"
            aria-label="Dismiss the tip"
            onClick={() => {
              markHintSeen()
              setHint(false)
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

/** Phones: the bottom sheets (fire list, layers, analysis) cover most of the map. A frame press closes the open one
 *  first, so the framed map shows instead of fitting behind or above the sheet (W15, audit G12b). */
const SHEETS: PanelKey[] = ['updates', 'layers', 'analysis']

/** Phones: slide the controls below an open search message (searchUi.ts controlsShift). A transform, not a margin:
 *  the controls' slot keeps its size, so the safe area and the framing do not move with the message. */
function useYieldToSearch(narrow: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  const pop = useSearchUi((s) => s.popover)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const top = el.parentElement?.getBoundingClientRect().top ?? el.getBoundingClientRect().top
    const dy = narrow ? controlsShift(pop, top) : 0
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : ''
  }, [narrow, pop])
  return ref
}

export function MapControls() {
  const narrow = useNarrow()
  const ctlRef = useYieldToSearch(narrow)
  const perspective = useWorkspace((s) => s.perspective)
  const setPerspective = useWorkspace((s) => s.setPerspective)
  const basemap = useWorkspace((s) => s.basemap)
  const setBasemap = useWorkspace((s) => s.setBasemap)
  const fallback = useWorkspace((s) => s.basemapFallback)
  const hasIncident = useStore((s) => s.incidentId != null)
  const startedMs = useStore((s) => s.summary?.started_ms ?? null)
  const actions = useMapRuntime((s) => s.actions)
  const framedKind = useMapRuntime((s) => s.framedKind)
  const bearing = useMapRuntime((s) => s.camera?.bearing ?? 0)
  const pitch = useMapRuntime((s) => s.camera?.pitch ?? 0)
  const rotated = Math.abs(bearing) > 0.5
  const compassLabel = rotated ? `Reset north (map rotated ${Math.round(((bearing % 360) + 360) % 360)}°)` : 'North is up'
  const photoLine = aerialPhotoLine(hasIncident ? startedMs : null)
  // inside a fire the button toggles: the fire, then (pressed again while still framed on it) the modeled area
  const nextArea = hasIncident && framedKind === 'fire'
  const frameLabel = !hasIncident ? 'Show all of the lower 48 states' : nextArea ? 'Show the whole modeled area' : 'Frame the fire'
  const frameTip = !hasIncident ? 'Show all of the lower 48 states (Alaska and Hawaii are not supported yet)' : nextArea ? 'Show the whole modeled area (press again for the fire)' : 'Frame the fire (press again for the whole modeled area)'
  return (
    <div className="mw-ctl fxm-ctl" role="toolbar" aria-label="Map controls" ref={ctlRef}>
      <div className="fxm-ctl-row">
        <Segmented value={perspective} options={PERSPECTIVES} onChange={setPerspective} ariaLabel="Perspective" size="sm" />
        <SelectMenu
          value={basemap}
          // an explicit pick ends a fallback: picking aerial while it fails over to the street map tries the photos again
          onChange={setBasemap}
          label={`Basemap: ${BASEMAP_LABEL[basemap]}`}
          tip="Basemap"
          placement="bottom-end"
          width={270}
          className="fxm-basemap-btn"
          display={
            <>
              <span className="fxm-bm-long">{BASEMAP_LABEL[basemap]}</span>
              <span className="fxm-bm-short">{BASEMAP_SHORT[basemap]}</span>
            </>
          }
          options={BASEMAPS.map((b) => ({
            value: b,
            label: BASEMAP_LABEL[b],
            hint: b === 'aerial' ? `${fallback != null ? 'Not loading right now (USGS). ' : ''}${photoLine}; not live satellite` : BASEMAP_DESCRIPTION[b],
          }))}
        />
        <span className="fxm-ctl-sep" aria-hidden="true" />
        <button
          type="button"
          className={`fxm-icon-btn fxm-compass ${rotated ? 'is-rotated' : ''}`}
          aria-label={compassLabel}
          data-tip={compassLabel}
          disabled={!actions}
          onClick={() => actions?.northUp()}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
            <path d="M10 2.2 13 10h-6z" className="fxm-compass-n" />
            <path d="M10 17.8 7 10h6z" className="fxm-compass-s" />
          </svg>
          {perspective === '3d' && <span className="fxm-pitch mw-mono" aria-hidden="true">{Math.round(pitch)}°</span>}
        </button>
        <button type="button" className="fxm-icon-btn" aria-label="Zoom out" data-tip="Zoom out" disabled={!actions} onClick={() => actions?.zoomBy(-1)}>
          <Minus size={15} aria-hidden="true" />
        </button>
        <button type="button" className="fxm-icon-btn" aria-label="Zoom in" data-tip="Zoom in" disabled={!actions} onClick={() => actions?.zoomBy(1)}>
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mw-btn fxm-return"
          aria-label={frameLabel}
          data-tip={frameTip}
          disabled={!actions}
          onClick={() => {
            if (narrow) {
              const ws = useWorkspace.getState()
              for (const k of SHEETS) if (ws.panels[k]) ws.setPanel(k, false)
            }
            if (!hasIncident) actions?.frameOverview()
            else if (nextArea) actions?.frameArea()
            else actions?.frameFire()
          }}
        >
          {hasIncident ? <Crosshair size={14} aria-hidden="true" /> : <MapIcon size={14} aria-hidden="true" />}
          <span>{hasIncident ? 'Incident' : 'All states'}</span>
        </button>
      </div>
      {perspective === '3d' && <OrbitGroup pitch={pitch} />}
    </div>
  )
}
