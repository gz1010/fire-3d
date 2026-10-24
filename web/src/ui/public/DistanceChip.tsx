// The fire view's distance chip (brief 4 H4, FireView.dc.html; PLAN-4 §3.4, decision i-7). With the browser's
// location (workspace `device`, set only after a click, memory only: never sent, never in the link, never stored) it
// reads "↗ 20 mi | northeast of you" and says what it measures under it ("to the mapped edge, Oct 23 perimeter" or "to
// the reported location, not its edge"); a click stops sharing (setDevice(null)) and the chip turns into "Share your
// location to see how far you are", whose click asks the browser (navigator.geolocation, no outside service). Light
// blue is the selected-point / distance colour of the design system; nothing here says or colours "safe".
import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { fmtDayDate } from '../../lib/time'
import { deviceFromPosition, LOCATE_MAX_AGE_MS, LOCATE_MESSAGES, LOCATE_TIMEOUT_MS, locateFailure, type LocateFailure } from '../../location/locate'
import { newestPerimeter } from '../../map/fireProfile'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { distanceChipText, distanceToFire, SHARE_PROMPT } from './fireView'

function ArrowIcon({ bearing }: { bearing: number | null }) {
  // the screen's arrow points north-east (45°): turned to the fire's compass direction from the viewer
  const turn = bearing == null ? 0 : bearing - 45
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: `rotate(${turn}deg)` }}>
      <path d="M6 18 L18 6" />
      <path d="M9 6 H18 V15" />
    </svg>
  )
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 11 L21 3 L13 21 L11 13 Z" />
    </svg>
  )
}

export function DistanceChip({ compact = false }: { compact?: boolean }) {
  const device = useWorkspace((s) => s.device)
  const units = useWorkspace((s) => s.units)
  const tf = useTimeFormat()
  const st = useStore(
    useShallow((s) => ({
      summary: s.summary && s.summary.id === s.incidentId ? s.summary : null,
      grid: s.manifest?.status === 'ready' && s.manifest.id === s.incidentId ? s.manifest.grid : null,
      perimeters: s.manifest?.status === 'ready' && s.manifest.id === s.incidentId ? (s.perimeters?.perimeters ?? null) : null,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<LocateFailure | null>(null)
  const msgId = useId()
  const seq = useRef(0)
  // a request still running when the chip unmounts must not apply
  useEffect(
    () => () => {
      seq.current++
    },
    [],
  )

  const share = () => {
    setFailure(null)
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined
    if (!geo) {
      setFailure(typeof window !== 'undefined' && window.isSecureContext === false ? 'insecure' : 'unsupported')
      return
    }
    const mine = ++seq.current
    setBusy(true)
    geo.getCurrentPosition(
      (pos) => {
        if (mine !== seq.current) return
        setBusy(false)
        const d = deviceFromPosition(pos, Date.now())
        if (!d) setFailure('unavailable')
        else useWorkspace.getState().setDevice(d)
      },
      (err) => {
        if (mine !== seq.current) return
        setBusy(false)
        setFailure(locateFailure(err?.code))
      },
      { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: LOCATE_MAX_AGE_MS },
    )
  }

  const newest = newestPerimeter(st.perimeters)
  const d = device ? distanceToFire(device, { perimeter: newest, grid: st.grid, reported: st.summary }) : null
  if (device && d) {
    const t = distanceChipText(d, units, newest ? fmtDayDate(newest.t_ms, tf.tz, { year: 'auto' }) : null)
    return (
      <div className={`pfv-dist-wrap${compact ? ' is-compact' : ''}`}>
        <button
          type="button"
          className={`pfv-dist is-shared${d.inside ? ' is-inside' : ''}`}
          aria-label={`${t.spoken} Click to stop sharing your location.`}
          data-tip={`Measured ${t.measures}, from your browser's location (not saved, not in the link). Click to stop sharing.`}
          onClick={() => {
            setFailure(null)
            useWorkspace.getState().setDevice(null)
          }}
        >
          <span className="pfv-dist-icon" aria-hidden="true">
            <ArrowIcon bearing={d.inside ? null : d.bearing} />
          </span>
          <span className="pfv-dist-value" aria-hidden="true">
            {t.value}
            {t.unit && <span className="pfv-dist-unit">{t.unit}</span>}
          </span>
          <span className="pfv-dist-sep" aria-hidden="true" />
          <span className="pfv-dist-dir" aria-hidden="true">
            {t.direction}
          </span>
        </button>
        <p className="pfv-dist-measures">{t.measures}</p>
      </div>
    )
  }
  return (
    <div className={`pfv-dist-wrap${compact ? ' is-compact' : ''}`}>
      <button type="button" className={`pfv-dist is-prompt${busy ? ' is-busy' : ''}`} aria-describedby={failure ? msgId : undefined} onClick={share} disabled={busy} data-tip="Your browser finds your location only when you click. Fire-3d does not save it or put it in the link.">
        {busy ? <LoaderCircle size={14} className="pfv-dist-spin" aria-hidden="true" /> : <ShareIcon />}
        {busy ? 'Finding your location…' : SHARE_PROMPT}
      </button>
      {failure && (
        <p className="pfv-dist-msg" id={msgId} role="status">
          <span>{LOCATE_MESSAGES[failure]}</span>
          <button type="button" className="mw-icon-btn is-sm" aria-label="Dismiss" onClick={() => setFailure(null)}>
            <X size={12} />
          </button>
        </p>
      )}
    </div>
  )
}
