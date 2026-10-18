// HTML overlays of the 3D view (SPEC 9.3): compass (rotates with the view bearing; click resets north), scale bar,
// 2D/3D toggle, exaggeration, quality, DOF, frame-fire and fullscreen controls, the probe readout near the cursor
// (hybrid / parametric), the low-FPS quality suggestion and a loading veil. Dark glass, positioned inside the canvas
// area not covered by app chrome (CSS --safe-*), which is also measured into sceneStore.viewInsets for the camera.
import { Aperture, Crosshair, Maximize2, Minimize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { fmtNumber } from '../../lib/format'
import { fuelInfo } from '../../lib/fuels'
import { fmtDateTime, fmtTPlus } from '../../lib/time'
import { useStore, type Quality } from '../../state/store'
import { useAssetsError, useAssetsLoading } from '../assets'
import { useSceneStore } from '../sceneStore'
import './overlays.css'

const HOUR = 3_600_000
const EXAGGERATIONS = [1, 1.5, 2, 3, 5]
const QUALITIES: { v: Quality; label: string }[] = [
  { v: 'high', label: 'High' },
  { v: 'medium', label: 'Med' },
  { v: 'low', label: 'Low' },
]

/** Measures the --safe-* box relative to the scene root into sceneStore.viewInsets. */
function SafeAreaProbe({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  const collapsed = useStore((s) => s.panelsCollapsed)
  useEffect(() => {
    const el = ref.current
    const root = rootRef.current
    if (!el || !root) return
    const measure = () => {
      const r = root.getBoundingClientRect()
      const s = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      useSceneStore.getState().setViewInsets({
        top: Math.max(0, Math.round(s.top - r.top)),
        right: Math.max(0, Math.round(r.right - s.right)),
        bottom: Math.max(0, Math.round(r.bottom - s.bottom)),
        left: Math.max(0, Math.round(s.left - r.left)),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(root)
    window.addEventListener('resize', measure)
    const t = window.setTimeout(measure, 250) // after panel transitions
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      window.clearTimeout(t)
    }
  }, [rootRef, collapsed])
  return <div ref={ref} className="sc-safe-probe" aria-hidden />
}

function Compass() {
  const bearing = useSceneStore((s) => s.camera?.bearingDeg ?? 0)
  const polar = useSceneStore((s) => s.camera?.polarDeg ?? 0)
  const issue = useSceneStore((s) => s.issueCameraCommand)
  return (
    <>
      <button
        type="button"
        className="sc-glass sc-compass"
        title={`Heading ${Math.round(bearing)}° — click to face north`}
        aria-label="Reset view to north"
        onClick={() => issue('reset-north')}
      >
        <svg viewBox="-24 -24 48 48" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden>
          <circle r="20.5" fill="none" stroke="rgba(232,214,170,0.16)" strokeWidth="1" />
          {Array.from({ length: 24 }, (_, i) => {
            const a = (i * 15 * Math.PI) / 180
            const major = i % 6 === 0
            const r0 = major ? 16.5 : 18.5
            return (
              <line
                key={i}
                x1={Math.sin(a) * r0}
                y1={-Math.cos(a) * r0}
                x2={Math.sin(a) * 20.5}
                y2={-Math.cos(a) * 20.5}
                stroke={major ? 'rgba(232,214,170,0.55)' : 'rgba(232,214,170,0.2)'}
                strokeWidth={major ? 1.1 : 0.8}
              />
            )
          })}
          <path d="M0 -15 L4.2 0 L0 -2.2 L-4.2 0 Z" fill="#E8C77E" />
          <path d="M0 15 L4.2 0 L0 2.2 L-4.2 0 Z" fill="rgba(236,230,214,0.28)" />
          <circle r="1.6" fill="#0b120e" stroke="#E8C77E" strokeWidth="0.8" />
          <text x="0" y="-8.6" textAnchor="middle" fontSize="5.4" fontFamily="JetBrains Mono, monospace" fontWeight="600" fill="#0b120e" transform="translate(0 0)">
            N
          </text>
        </svg>
      </button>
      <div className="sc-compass-tilt" aria-hidden>
        {Math.round(bearing).toString().padStart(3, '0')}° · {Math.round(90 - polar)}°
      </div>
    </>
  )
}

const NICE = [1, 2, 2.5, 5]
function niceLength(maxM: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, maxM))))
  let best = p
  for (const k of NICE) if (k * p <= maxM) best = k * p
  return best
}
function fmtLen(m: number): string {
  if (m >= 1000) return `${fmtNumber(m / 1000, m % 1000 === 0 ? 0 : 1)} km`
  return `${fmtNumber(m)} m`
}

function ScaleBar() {
  const mpp = useSceneStore((s) => s.camera?.metersPerPixel ?? 0)
  if (!mpp || !Number.isFinite(mpp)) return null
  const len = niceLength(mpp * 150) // nice step ratios <= 2, so the bar is 75..150 px
  const px = Math.max(30, Math.round(len / mpp))
  const half = len / 2
  return (
    <div className="sc-glass sc-scale" title="Scale at the view centre">
      <div className="sc-scale-labels" style={{ width: px }}>
        <span style={{ left: 0 }}>0</span>
        {px >= 112 && <span style={{ left: px / 2 }}>{len >= 1000 ? fmtNumber(half / 1000, half % 1000 === 0 ? 0 : 1) : fmtNumber(half)}</span>}
        <span style={{ left: px }}>{fmtLen(len)}</span>
      </div>
      <div className="sc-scale-bar" style={{ width: px }} />
    </div>
  )
}

function useFullscreen(): [boolean, () => void] {
  const [fs, setFs] = useState(() => typeof document !== 'undefined' && Boolean(document.fullscreenElement))
  useEffect(() => {
    const on = () => setFs(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen?.().catch(() => undefined)
  }
  return [fs, toggle]
}

function ViewDock() {
  const viewMode = useStore((s) => s.viewMode)
  const setViewMode = useStore((s) => s.setViewMode)
  const exaggeration = useStore((s) => s.exaggeration)
  const setExaggeration = useStore((s) => s.setExaggeration)
  const quality = useStore((s) => s.quality)
  const setQuality = useStore((s) => s.setQuality)
  const dof = useStore((s) => s.dof)
  const setDof = useStore((s) => s.setDof)
  const issue = useSceneStore((s) => s.issueCameraCommand)
  const [fs, toggleFs] = useFullscreen()
  const exOptions = EXAGGERATIONS.includes(exaggeration) ? EXAGGERATIONS : [...EXAGGERATIONS, exaggeration].sort((a, b) => a - b)
  const dofAvailable = viewMode === '3d' && quality !== 'low'
  return (
    <div className="sc-dock">
      <ScaleBar />
      <div className="sc-glass sc-group" role="group" aria-label="View">
        {(['2d', '3d'] as const).map((m) => (
          <button key={m} type="button" className="sc-seg" aria-pressed={viewMode === m} onClick={() => setViewMode(m)} title={m === '2d' ? 'Top-down map view' : 'Oblique 3D view'}>
            {m.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="sc-glass sc-group" role="group" aria-label="Rendering">
        <label className="sc-select" title="Vertical exaggeration">
          <span className="sr-only">Vertical exaggeration</span>
          <select value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))}>
            {exOptions.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
        <span className="sc-sep" />
        <label className="sc-select" title="Rendering quality">
          <span className="sr-only">Quality</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
            {QUALITIES.map((q) => (
              <option key={q.v} value={q.v}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <span className="sc-sep" />
        <button
          type="button"
          className="sc-icon-btn"
          aria-pressed={dof && dofAvailable}
          disabled={!dofAvailable}
          style={dofAvailable ? undefined : { opacity: 0.35 }}
          onClick={() => setDof(!dof)}
          title={dofAvailable ? `Depth of field ${dof ? 'on' : 'off'}` : 'Depth of field (3D view, medium/high quality)'}
          aria-label="Toggle depth of field"
        >
          <Aperture />
        </button>
        <button type="button" className="sc-icon-btn" onClick={() => issue('frame-fire')} title="Frame the fire" aria-label="Frame the fire">
          <Crosshair />
        </button>
        <button type="button" className="sc-icon-btn" aria-pressed={fs} onClick={toggleFs} title={fs ? 'Exit fullscreen' : 'Fullscreen'} aria-label="Toggle fullscreen">
          {fs ? <Minimize2 /> : <Maximize2 />}
        </button>
      </div>
    </div>
  )
}

/** CSS size of an element, kept current with a ResizeObserver. */
function useElementSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

function ProbeReadout({ area }: { area: { w: number; h: number } }) {
  const probe = useSceneStore((s) => s.probe)
  const interacting = useSceneStore((s) => s.interacting)
  const style = useStore((s) => s.visualStyle)
  const manifest = useStore((s) => s.manifest)
  const timeMs = useStore((s) => s.timeMs)
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 240, h: 130 })
  // re-measure the readout when its layout can change (row set / fuel name)
  const fuelCode = probe?.fuel
  const hasArrival = probe?.arrivalH != null
  const hasP = probe?.pBurn != null
  useEffect(() => {
    const el = ref.current
    if (el) setBox((b) => (b.w === el.offsetWidth && b.h === el.offsetHeight ? b : { w: el.offsetWidth, h: el.offsetHeight }))
  }, [fuelCode, hasArrival, hasP])
  if (!probe || interacting || style === 'realistic' || !manifest || probe.screenX == null || probe.screenY == null) return null
  const origin = manifest.time_origin_ms
  const ignH = manifest.ignition ? (manifest.ignition.t_ms - origin) / HOUR : null
  const tH = (timeMs - origin) / HOUR
  const fuel = fuelInfo(probe.fuel)
  const slopeDeg = (Math.atan(probe.slope) * 180) / Math.PI
  const burnedNow = probe.arrivalH != null && probe.arrivalH <= tH
  const pw = area.w || 4000
  const ph = area.h || 4000
  let x = probe.screenX + 18
  let y = probe.screenY + 18
  if (x + box.w > pw - 8) x = probe.screenX - box.w - 18
  if (y + box.h > ph - 8) y = probe.screenY - box.h - 18
  return (
    <div ref={ref} className="sc-glass sc-probe" style={{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` }}>
      <div className="sc-probe-coord">
        {Math.abs(probe.lat).toFixed(5)}°{probe.lat >= 0 ? 'N' : 'S'} {Math.abs(probe.lon).toFixed(5)}°{probe.lon >= 0 ? 'E' : 'W'}
      </div>
      <div className="sc-probe-row">
        <span>ELEV</span>
        <span>
          {fmtNumber(probe.elev)} m <span className="sc-dim">·</span> {fmtNumber(slopeDeg)}° slope
        </span>
      </div>
      <div className="sc-probe-row">
        <span>FUEL</span>
        <span>
          {fuel.label}
          {probe.canopyPct != null && probe.canopyPct > 0 ? (
            <>
              {' '}
              <span className="sc-dim">·</span> {fmtNumber(probe.canopyPct)}% canopy
            </>
          ) : null}
        </span>
      </div>
      <div className="sc-probe-fuel">{fuel.name}</div>
      <div className="sc-probe-row">
        <span>ARRIVAL</span>
        {probe.arrivalH == null ? (
          <span className="sc-dim">unburned</span>
        ) : (
          <span className={burnedNow ? 'sc-hot' : undefined}>
            {fmtDateTime(origin + probe.arrivalH * HOUR)}
            {ignH != null ? ` ${fmtTPlus(probe.arrivalH - ignH)}` : ''}
          </span>
        )}
      </div>
      {probe.pBurn != null && (
        <div className="sc-probe-row">
          <span>P(BURN)</span>
          <span>
            {fmtNumber(probe.pBurn * 100)}% <span className="sc-dim">by horizon</span>
            {probe.pBurnNow != null ? (
              <>
                {' '}
                <span className="sc-dim">·</span> {fmtNumber(probe.pBurnNow * 100)}% now
              </>
            ) : null}
          </span>
        </div>
      )}
    </div>
  )
}

function QualityToast() {
  const suggestion = useSceneStore((s) => s.qualitySuggestion)
  const fps = useSceneStore((s) => s.fps)
  const setSuggestion = useSceneStore((s) => s.setQualitySuggestion)
  const setQuality = useStore((s) => s.setQuality)
  if (!suggestion) return null
  return (
    <div className="sc-glass sc-toast" role="status">
      <span>
        Low frame rate (<b className="mono">{Math.round(fps)} fps</b>). Switch to <b>{suggestion === 'medium' ? 'Medium' : 'Low'}</b> quality?
      </span>
      <button type="button" className="sc-toast-btn" onClick={() => setQuality(suggestion)}>
        Switch
      </button>
      <button type="button" className="sc-toast-x" aria-label="Dismiss" onClick={() => setSuggestion(null)}>
        <X size={14} />
      </button>
    </div>
  )
}

function LoadingVeil() {
  const loading = useAssetsLoading()
  const error = useAssetsError()
  const ready = useSceneStore((s) => s.terrainReady)
  const hasManifest = useStore((s) => s.manifest?.status === 'ready')
  if (error && !ready) {
    return (
      <div className="sc-loading">
        <div className="sc-loading-err">Could not load the terrain: {error}</div>
      </div>
    )
  }
  if (!hasManifest || ready || !loading) return null
  return (
    <div className="sc-loading" role="status">
      <span>Loading terrain</span>
      <div className="sc-loading-bar" />
    </div>
  )
}

export function SceneOverlays({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const ready = useSceneStore((s) => s.terrainReady)
  const area = useElementSize(rootRef)
  return (
    <div className="sc-ui">
      <SafeAreaProbe rootRef={rootRef} />
      {ready && <Compass />}
      {ready && <ViewDock />}
      <ProbeReadout area={area} />
      <QualityToast />
      <LoadingVeil />
    </div>
  )
}
