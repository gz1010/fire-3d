// Persistent coordinate strip (owner: location; CONTRACT §5.1, BRIEF §8, brief 2 decision 7). Always visible, also
// with panels collapsed: the incident's reported location (as reported in the incident data; never called the
// ignition point) and, separately, the selected point, both as labelled WGS84 decimal degrees with copy buttons. Its
// form follows the shell's slot (useCoordsVariant, CONTRACT §13 shell): 'full' (Command) adds the incident id,
// timestamps, degrees-minutes-seconds and UTM; 'compact' (Public) is decimal degrees only; 'line' (phones) is ONE
// line: the selected point, else the fire's reported location, else a hint on the overview.
import { Check, Copy, Crosshair } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { formatDecimalPair, formatDms, formatLat, formatLon } from '../lib/geodesy'
import { lonLatToUtm } from '../lib/reproject'
import { recordIssuerLabel } from '../api/records'
import { fmtAt } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { useCoordsVariant } from '../ui/shell/coordsVariant'
import './location.css'

/** Copy text; falls back to a hidden textarea where the async clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <>
      <button
        type="button"
        className={`mw-icon-btn is-sm loc-copy${state === 'ok' ? ' is-done' : ''}`}
        aria-label={label}
        title={`${label}: ${text}`}
        onClick={() =>
          void copyText(text).then((ok) => {
            setState(ok ? 'ok' : 'fail')
            window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setState('idle'), 1600)
          })
        }
      >
        {state === 'ok' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <span className="loc-sr" aria-live="polite">
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed: select the coordinates and copy them manually' : ''}
      </span>
    </>
  )
}

function selectedLabel(sel: SelectedLocation): string {
  if (sel.source === 'address') return sel.adjusted ? 'Selected address · pin moved' : 'Selected address · approximate'
  if (sel.source === 'event') return sel.approximate ? 'Event location · estimated' : 'Event location'
  if (sel.source === 'incident') return 'Selected · incident reported location'
  if (sel.source === 'coords') return sel.adjusted ? 'Entered point · moved' : 'Entered point'
  return sel.adjusted ? 'Selected point · moved' : 'Selected point'
}

function Coord(props: { kind: 'incident' | 'selected'; label: string; hint: string; lat: number; lon: number; zone: number | null; command: boolean; onLocate: () => void }) {
  const { kind, label, hint, lat, lon, zone, command, onLocate } = props
  const pair = formatDecimalPair(lat, lon)
  const utm = command && zone ? lonLatToUtm(lon, lat, zone) : null
  return (
    <div className={`loc-coord is-${kind}`} title={hint}>
      <span className="loc-coord-label">
        <span className={`loc-coord-dot is-${kind}`} aria-hidden="true" />
        {label}
      </span>
      {/* latitude and longitude each stay whole; a narrow strip wraps between them, never under the buttons */}
      <span className="loc-coord-row">
        <span className="loc-coord-value mw-mono">
          <span>{formatLat(lat)},</span> <span>{formatLon(lon)}</span>
        </span>
        <CopyButton text={pair} label={`Copy ${kind === 'incident' ? 'reported incident' : 'selected'} coordinates`} />
        <button type="button" className="mw-icon-btn is-sm" aria-label={`Center the map on the ${kind === 'incident' ? 'reported incident location' : 'selected point'}`} title="Center the map here" onClick={onLocate}>
          <Crosshair size={13} />
        </button>
      </span>
      {command && (
        <span className="loc-coord-extra mw-mono">
          <span>{formatDms(lat, lon)}</span>
          {utm && (
            <>
              {' · '}
              <span>
                UTM {zone}N {Math.round(utm[0])} E {Math.round(utm[1])} N
              </span>
            </>
          )}
        </span>
      )}
    </div>
  )
}

/** Coordinates and labels stay on one line while they fit, so the strip's intrinsic width is one full coordinate line
 *  (the shell sizes its column from it). When the bottom row squeezes the strip below that (narrow windows),
 *  `is-tight` lets latitude / longitude and the labels wrap as whole units instead of running under the buttons. */
function fitStrip(el: HTMLElement) {
  el.classList.remove('is-tight')
  const over = Array.from(el.querySelectorAll<HTMLElement>('.loc-coord-label, .loc-coord-value, .loc-coord-extra')).some((v) => v.scrollWidth > v.clientWidth + 1)
  el.classList.toggle('is-tight', over)
}

function useStripFit() {
  const ref = useRef<HTMLDivElement | null>(null)
  // after every render (content, preset or time changed) ...
  useLayoutEffect(() => {
    if (ref.current) fitStrip(ref.current)
  })
  // ... and whenever the window or the strip's own box changes size
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => fitStrip(el))
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    void document.fonts?.ready.then(schedule)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])
  return ref
}

/** Phones: one line, the selected point, else the reported location, else a hint (overview). */
function CoordLine(props: { sel: SelectedLocation | null; summary: { name: string; lat: number; lon: number } | null; onLocate: (lat: number, lon: number) => void }) {
  const { sel, summary, onLocate } = props
  const pt = sel ? { kind: 'selected' as const, label: sel.source === 'address' ? 'Address' : 'Selected', lat: sel.lat, lon: sel.lon } : summary ? { kind: 'incident' as const, label: `${summary.name} reported`, lat: summary.lat, lon: summary.lon } : null
  if (!pt)
    return (
      <div className="loc-coord-line is-empty">
        <span className="loc-coord-value mw-muted">Search or click the map to get coordinates</span>
      </div>
    )
  return (
    <div className={`loc-coord-line is-${pt.kind}`} title={pt.kind === 'incident' ? 'Where the incident was reported. It is not necessarily where the fire started.' : 'The point you selected (cyan pin).'}>
      <span className="loc-coord-label">
        <span className={`loc-coord-dot is-${pt.kind}`} aria-hidden="true" />
        <span className="loc-coord-label-text">{pt.label}</span>
      </span>
      <span className="loc-coord-value mw-mono">
        {formatLat(pt.lat)}, {formatLon(pt.lon)}
      </span>
      <CopyButton text={formatDecimalPair(pt.lat, pt.lon)} label={`Copy ${pt.kind === 'incident' ? 'reported incident' : 'selected'} coordinates`} />
      <button type="button" className="mw-icon-btn is-sm" aria-label={`Center the map on the ${pt.kind === 'incident' ? 'reported incident location' : 'selected point'}`} onClick={() => onLocate(pt.lat, pt.lon)}>
        <Crosshair size={13} />
      </button>
    </div>
  )
}

export function CoordinateStrip() {
  const ref = useStripFit()
  const variant = useCoordsVariant()
  const st = useStore(
    useShallow((s) => ({
      summary: s.summary,
      incidentId: s.incidentId,
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      timeMs: s.timeMs,
    })),
  )
  const sel = useWorkspace((s) => s.selection)
  const command = variant === 'full'
  const { summary, manifest } = st
  const zone = manifest?.grid.utm_zone ?? null
  const tf = useTimeFormat()
  // the agency whose record the bundle used (CAL FIRE in California, NIFC WFIGS elsewhere; §14.12.6), by its issuer
  const reportedBy =
    manifest?.data_sources.some((d) => /CAL FIRE|NIFC WFIGS incident/i.test(d.name)) && summary ? recordIssuerLabel(summary) : null
  const fly = (lat: number, lon: number) => useWorkspace.getState().requestMapFlyTo({ lon, lat, zoom: Math.max(useWorkspace.getState().view?.zoom ?? 13, 13) })
  const valid = summary && st.incidentId && Number.isFinite(summary.lat) && Number.isFinite(summary.lon) ? summary : null
  if (variant === 'line')
    return (
      <div ref={ref} className="mw-panel loc-strip is-line" role="group" aria-label="Coordinates, WGS84">
        <CoordLine sel={sel} summary={valid} onLocate={fly} />
      </div>
    )
  return (
    <div ref={ref} className={`mw-panel loc-strip${command ? ' is-command' : ''}`} role="group" aria-label="Coordinates, WGS84">
      {valid ? (
        <Coord
          kind="incident"
          label={`${valid.name} · reported location${reportedBy ? ` (${reportedBy})` : ''}`}
          hint="Where the incident was reported in the incident data. It is not necessarily where the fire started."
          lat={valid.lat}
          lon={valid.lon}
          zone={zone}
          command={command}
          onLocate={() => fly(valid.lat, valid.lon)}
        />
      ) : (
        <div className="loc-coord is-empty">
          <span className="loc-coord-label">{st.incidentId ? 'Incident · reported location' : 'United States overview'}</span>
          <span className="loc-coord-value mw-muted">{st.incidentId ? 'Loading…' : 'No fire open'}</span>
        </div>
      )}
      {sel ? (
        <Coord kind="selected" label={selectedLabel(sel)} hint="The point you selected (cyan pin)." lat={sel.lat} lon={sel.lon} zone={zone} command={command} onLocate={() => fly(sel.lat, sel.lon)} />
      ) : (
        (command || !st.incidentId) && (
          <div className="loc-coord is-empty">
            <span className="loc-coord-label">Selected point</span>
            <span className="loc-coord-value mw-muted">Click the map or search to select a point</span>
          </div>
        )
      )}
      {command && st.incidentId && (
        <dl className="loc-strip-meta">
          <div>
            <dt>Incident ID</dt>
            <dd className="mw-mono">{st.incidentId}</dd>
          </div>
          {summary?.updated_ms != null && (
            <div>
              <dt>{reportedBy ? `${reportedBy} record updated` : 'Incident record updated'}</dt>
              <dd className="mw-mono">{fmtAt(summary.updated_ms, tf, { year: 'always', zone: true })}</dd>
            </div>
          )}
          <div>
            <dt>Selected time</dt>
            <dd className="mw-mono">{fmtAt(st.timeMs, tf, { year: 'always', zone: true })}</dd>
          </div>
          <div>
            <dt>Datum</dt>
            <dd className="mw-mono">WGS84{zone ? ` · UTM ${zone}N` : ''}</dd>
          </div>
        </dl>
      )}
    </div>
  )
}
