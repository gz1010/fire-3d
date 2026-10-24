// Small map controls (owner: map-core; BRIEF §3, CONTRACT §4.1, §15.2): 2D/3D perspective, a quick basemap switch, a
// compass that shows the heading, zoom out / in, and the framing button ("Incident" inside a fire: the fire, then its
// modeled area; "All states" on the overview: the lower 48). In 3D an orbit group sits beside them (brief 2, O-R14):
// tilt ±10°, "Top-down" (pitch 0, terrain kept) and "North up", with a one-time gesture hint. All are buttons
// (keyboard and screen-reader accessible); camera moves go through the controller (useMapRuntime.actions), so the
// opening camera knows about them, and honour prefers-reduced-motion.
// Brief 4 (H2c, decision f): the map turns in 2D as in 3D. The compass can be dragged around its centre to set the
// heading (ui/useCompassDrag.ts; a click without a drag is still "north up", ← / → on it turn 15°), ⟲ ⟳ turn 15°, and
// Q / E / N do the same from anywhere (state/runtime.ts). Three looks:
//   default  today's row (top right of the chromes that do not pass a variant), rotate buttons in the 3D orbit row;
//   bar      one glass bar as the handoff's Main details (2D/3D, basemap, ⟲ compass ⟳, −, +, framing, optional
//            Layers icon); the 3D orbit row goes on the side away from the screen edge it sits on (`anchor`);
//   compact  a vertical cluster: zoom in / out, ⟲, compass, ⟳ (Public minimal and the fire view).
// Development builds also take ?ctl=bar|compact to show a variant in today's slot (screenshots; compiled out of
// production).
import { ChevronsDown, ChevronsUp, Crosshair, Layers, Map as MapIcon, Minus, Plus, RotateCcw, RotateCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { headingLabel, isRotated } from '../lib/compass'
import { controlsShift, useSearchUi } from '../location/searchUi'
import { useNarrow } from '../location/useNarrow'
import { ROTATE_STEP_DEG } from '../state/rotation'
import { useStore } from '../state/store'
import { useWorkspace, type Basemap, type PanelKey, type Perspective } from '../state/workspace'
import { Segmented, SelectMenu } from '../ui/controls'
import { useCompassDrag } from '../ui/useCompassDrag'
import { useMapRuntime } from './mapStore'
import { aerialPhotoLine, BASEMAP_DESCRIPTION, BASEMAP_LABEL, BASEMAP_SHORT } from './providers'

export type MapControlsVariant = 'bar' | 'compact'

export interface MapControlsProps {
  /** Unset: today's controls row. */
  variant?: MapControlsVariant
  /** bar: the screen edge the bar sits at; the 3D orbit row and the one-time hint go on the other side (default top). */
  anchor?: 'top' | 'bottom'
  /** bar: a Layers icon at the end that opens / closes the Layers panel. */
  layers?: boolean
  className?: string
}

const PERSPECTIVES: { value: Perspective; label: string; tip: string }[] = [
  { value: '2d', label: '2D', tip: 'Top-down map (keeps its heading; N or the compass for north up)' },
  { value: '3d', label: '3D', tip: 'Terrain with a tilted camera; tilt with the buttons beside the controls' },
]

const BASEMAPS: Basemap[] = ['dark', 'roads', 'aerial']

/** localStorage key: the rotate / tilt gesture hint was shown (per browser; storage may be unavailable). Brief 4 renamed
 *  it so the new hint (2D rotation, Q / E, the compass drag) shows once more. */
const HINT_KEY = 'fire3d.rotateHintSeen'
const HINT_MS = 12_000

/** The one-time hint (brief 4 wording: every way to turn the map, Mac trackpads included). */
export const ROTATE_HINT =
  'Turn the map: drag the compass, press Q or E (N for north up), right-drag or Ctrl + drag (also on a Mac trackpad), or twist two fingers on a touch screen or in Safari. In 3D, drag up and down the same way to tilt.'

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

/** ?ctl=bar|compact in development builds (screenshots of a variant in today's slot); null in production. */
function devVariant(): MapControlsVariant | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('ctl')
  return v === 'bar' || v === 'compact' ? v : null
}

/** The one-time rotate / tilt hint, hanging off the controls (shown once per browser for 12 s). */
function RotateHint({ side }: { side: 'below' | 'above' }) {
  const [hint, setHint] = useState(() => !hintSeen())
  useEffect(() => {
    if (!hint) return
    markHintSeen()
    const t = window.setTimeout(() => setHint(false), HINT_MS)
    return () => window.clearTimeout(t)
  }, [hint])
  if (!hint) return null
  return (
    <div className={`fxm-orbit-hint is-${side}`} role="note">
      <span>{ROTATE_HINT}</span>
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
  )
}

/** ⟲ / ⟳: turn the map 15° left / right. */
function RotateButton({ dir, size = 15 }: { dir: -1 | 1; size?: number }) {
  const actions = useMapRuntime((s) => s.actions)
  const label = dir < 0 ? `Turn left ${ROTATE_STEP_DEG}° (Q)` : `Turn right ${ROTATE_STEP_DEG}° (E)`
  return (
    <button type="button" className="fxm-icon-btn fxm-rotate" aria-label={label} data-tip={label} disabled={!actions} onClick={() => actions?.rotateBy(dir * ROTATE_STEP_DEG)}>
      {dir < 0 ? <RotateCcw size={size} aria-hidden="true" /> : <RotateCw size={size} aria-hidden="true" />}
    </button>
  )
}

/** The compass: the needle points north on screen; drag it around to turn the map, click for north up. */
function Compass({ look }: { look: 'default' | 'handoff' }) {
  const actions = useMapRuntime((s) => s.actions)
  const bearing = useMapRuntime((s) => s.camera?.bearing ?? 0)
  const pitch = useMapRuntime((s) => s.camera?.pitch ?? 0)
  const perspective = useWorkspace((s) => s.perspective)
  const { props, dragging } = useCompassDrag({
    bearing: () => useMapRuntime.getState().camera?.bearing ?? 0,
    setBearing: (deg) => useMapRuntime.getState().actions?.setBearing(deg),
    northUp: () => useMapRuntime.getState().actions?.northUp(),
    rotateBy: (deg) => useMapRuntime.getState().actions?.rotateBy(deg),
    disabled: !actions,
  })
  const rotated = isRotated(bearing)
  const heading = headingLabel(bearing)
  const label = rotated ? `Compass, heading ${heading}: click for north up, drag or press ← → to turn the map` : 'Compass, north is up: drag or press ← → to turn the map'
  const tip = rotated ? `Heading ${heading}. Click for north up; drag to turn (Q / E, N)` : 'North is up. Drag to turn the map (Q / E, N for north up)'
  return (
    <button
      type="button"
      className={`fxm-icon-btn fxm-compass ${rotated ? 'is-rotated' : ''} ${dragging ? 'is-dragging' : ''}`}
      aria-label={label}
      data-tip={dragging ? undefined : tip}
      disabled={!actions}
      {...props}
    >
      {look === 'handoff' ? (
        <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
          <path d="M7 1 L11 9 L3 9 Z" className="fxm-compass-n" />
          <path d="M7 17 L11 9 L3 9 Z" className="fxm-compass-s" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
          <path d="M10 2.2 13 10h-6z" className="fxm-compass-n" />
          <path d="M10 17.8 7 10h6z" className="fxm-compass-s" />
        </svg>
      )}
      {perspective === '3d' && <span className="fxm-pitch mw-mono" aria-hidden="true">{Math.round(pitch)}°</span>}
    </button>
  )
}

/** The 3D orbit group (tilt, top-down, north up; the rotate buttons too when the controls have none of their own)
 *  and the one-time gesture hint. */
function OrbitGroup({ pitch, rotate, hintSide }: { pitch: number; rotate: boolean; hintSide: 'below' | 'above' }) {
  const actions = useMapRuntime((s) => s.actions)
  const btn = (label: string, onClick: () => void, icon: ReactNode, disabled = false) => (
    <button type="button" className="fxm-icon-btn" aria-label={label} data-tip={label} disabled={!actions || disabled} onClick={onClick}>
      {icon}
    </button>
  )
  return (
    <div className="fxm-orbit" role="group" aria-label={rotate ? 'Rotate and tilt the 3D view' : 'Tilt the 3D view'}>
      {rotate && (
        <>
          <RotateButton dir={-1} />
          <RotateButton dir={1} />
          <span className="fxm-ctl-sep" aria-hidden="true" />
        </>
      )}
      {btn('Tilt more (+10°)', () => actions?.tiltBy(10), <ChevronsUp size={15} aria-hidden="true" />, pitch >= 79.5)}
      {btn('Tilt less (−10°)', () => actions?.tiltBy(-10), <ChevronsDown size={15} aria-hidden="true" />, pitch <= 0.5)}
      <button type="button" className="mw-btn fxm-orbit-text" data-tip="Look straight down; terrain stays on" disabled={!actions || pitch <= 0.5} onClick={() => actions?.topDown()}>
        Top-down
      </button>
      <button type="button" className="mw-btn fxm-orbit-text" data-tip="Turn the map so north is up (N)" disabled={!actions} onClick={() => actions?.northUp()}>
        North up
      </button>
      <RotateHint side={hintSide} />
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

function ZoomButton({ delta }: { delta: -1 | 1 }) {
  const actions = useMapRuntime((s) => s.actions)
  const label = delta < 0 ? 'Zoom out' : 'Zoom in'
  return (
    <button type="button" className="fxm-icon-btn" aria-label={label} data-tip={label} disabled={!actions} onClick={() => actions?.zoomBy(delta)}>
      {delta < 0 ? <Minus size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
    </button>
  )
}

function PerspectiveSwitch() {
  const perspective = useWorkspace((s) => s.perspective)
  const setPerspective = useWorkspace((s) => s.setPerspective)
  return <Segmented value={perspective} options={PERSPECTIVES} onChange={setPerspective} ariaLabel="Perspective" size="sm" />
}

function BasemapMenu() {
  const basemap = useWorkspace((s) => s.basemap)
  const setBasemap = useWorkspace((s) => s.setBasemap)
  const fallback = useWorkspace((s) => s.basemapFallback)
  const hasIncident = useStore((s) => s.incidentId != null)
  const startedMs = useStore((s) => s.summary?.started_ms ?? null)
  const photoLine = aerialPhotoLine(hasIncident ? startedMs : null)
  return (
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
  )
}

/** "Incident" (the fire, then its modeled area) / "All states". */
function FrameButton({ narrow }: { narrow: boolean }) {
  const actions = useMapRuntime((s) => s.actions)
  const framedKind = useMapRuntime((s) => s.framedKind)
  const hasIncident = useStore((s) => s.incidentId != null)
  // inside a fire the button toggles: the fire, then (pressed again while still framed on it) the modeled area
  const nextArea = hasIncident && framedKind === 'fire'
  const frameLabel = !hasIncident ? 'Show all of the lower 48 states' : nextArea ? 'Show the whole modeled area' : 'Frame the fire'
  const frameTip = !hasIncident ? 'Show all of the lower 48 states (Alaska and Hawaii are not supported yet)' : nextArea ? 'Show the whole modeled area (press again for the fire)' : 'Frame the fire (press again for the whole modeled area)'
  return (
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
  )
}

/** The bar's Layers icon: opens / closes the Layers panel (drawers hand focus back through data-panel-toggle). */
function LayersButton() {
  const open = useWorkspace((s) => s.panels.layers)
  const togglePanel = useWorkspace((s) => s.togglePanel)
  return (
    <button
      type="button"
      className={`fxm-icon-btn fxm-layers ${open ? 'is-on' : ''}`}
      aria-label="Layers"
      aria-expanded={open}
      data-tip="Layers, basemap, forecast run and units"
      data-panel-toggle="layers"
      onClick={() => togglePanel('layers')}
    >
      <Layers size={17} aria-hidden="true" />
    </button>
  )
}

export function MapControls({ variant: asked, anchor = 'top', layers = false, className }: MapControlsProps = {}) {
  const variant = devVariant() ?? asked
  const narrow = useNarrow()
  const ctlRef = useYieldToSearch(narrow)
  const perspective = useWorkspace((s) => s.perspective)
  const pitch = useMapRuntime((s) => s.camera?.pitch ?? 0)
  const extra = className ? ` ${className}` : ''

  if (variant === 'compact')
    return (
      <div className={`mw-ctl fxm-ctl is-compact${extra}`} role="toolbar" aria-label="Map controls" aria-orientation="vertical" ref={ctlRef}>
        <ZoomButton delta={1} />
        <ZoomButton delta={-1} />
        <span className="fxm-ctl-sep is-h" aria-hidden="true" />
        <RotateButton dir={-1} />
        <Compass look="handoff" />
        <RotateButton dir={1} />
      </div>
    )

  if (variant === 'bar') {
    const orbit = perspective === '3d' ? <OrbitGroup pitch={pitch} rotate={false} hintSide={anchor === 'bottom' ? 'above' : 'below'} /> : null
    return (
      <div className={`mw-ctl fxm-ctl is-bar is-anchor-${anchor}${extra}`} role="toolbar" aria-label="Map controls" ref={ctlRef}>
        {anchor === 'bottom' && orbit}
        <div className="fxm-ctl-row">
          <PerspectiveSwitch />
          <BasemapMenu />
          <div className="fxm-turn" role="group" aria-label="Turn the map">
            <RotateButton dir={-1} />
            <Compass look="handoff" />
            <RotateButton dir={1} />
          </div>
          <ZoomButton delta={-1} />
          <ZoomButton delta={1} />
          <FrameButton narrow={narrow} />
          {layers && <LayersButton />}
        </div>
        {anchor !== 'bottom' && orbit}
        {perspective !== '3d' && <RotateHint side={anchor === 'bottom' ? 'above' : 'below'} />}
      </div>
    )
  }

  return (
    <div className={`mw-ctl fxm-ctl${extra}`} role="toolbar" aria-label="Map controls" ref={ctlRef}>
      <div className="fxm-ctl-row">
        <PerspectiveSwitch />
        <BasemapMenu />
        <span className="fxm-ctl-sep" aria-hidden="true" />
        <Compass look="default" />
        <ZoomButton delta={-1} />
        <ZoomButton delta={1} />
        <FrameButton narrow={narrow} />
      </div>
      {perspective === '3d' && <OrbitGroup pitch={pitch} rotate hintSide="below" />}
    </div>
  )
}
