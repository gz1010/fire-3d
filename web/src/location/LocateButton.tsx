// The overview's locate-me button (brief 4, Main.dc.html: a 52 px round glass button beside the search pill; PLAN-4
// §3.3 and decision i-7). Only a click asks the browser (navigator.geolocation.getCurrentPosition, no outside location
// service). The fix becomes the workspace's `device` (memory only) and the map flies there and marks it
// (map/DeviceMarker.tsx); nothing leaves the browser. A prompt under the button row says so and offers "Check this
// spot", which first says what a check sends (the point to Fire-3d's server, as a map click) and then makes it the
// selected point "Your location" (approximate when the browser's accuracy is coarser than 100 m), checked by the
// location card. "Stop showing my location" forgets it. Denied, unavailable and timed-out requests get a plain message
// in the same place; nothing is guessed. Pure parts: location/locate.ts.
import { LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useWorkspace } from '../state/workspace'
import {
  deviceFromPosition,
  deviceSelection,
  deviceZoom,
  LOCATE_CHECK_LABEL,
  LOCATE_CHECK_NOTE,
  LOCATE_FOUND,
  LOCATE_HIDE_LABEL,
  LOCATE_LABEL,
  LOCATE_MAX_AGE_MS,
  LOCATE_MESSAGES,
  LOCATE_TIMEOUT_MS,
  LOCATE_TIP,
  locateFailure,
  type LocateFailure,
} from './locate'
import './location.css'

function LocateIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22" />
    </svg>
  )
}

export function LocateButton() {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<LocateFailure | null>(null)
  // the prompt after a fix (shown while the device location is the one this click found and not yet checked)
  const [found, setFound] = useState(false)
  const device = useWorkspace((s) => s.device)
  const msgId = useId()
  // a request still running when the button unmounts (a chrome swap) or a newer click must not apply
  const seq = useRef(0)
  useEffect(
    () => () => {
      seq.current++
    },
    [],
  )
  // a new point (map click, search, or this prompt's check) makes the message and the prompt stale
  useEffect(
    () =>
      useWorkspace.subscribe((s, p) => {
        if (s.selection !== p.selection && s.selection) {
          setFailure(null)
          setFound(false)
        }
      }),
    [],
  )

  const locate = () => {
    setFailure(null)
    setFound(false)
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
        if (!d) {
          setFailure('unavailable')
          return
        }
        // in the browser only: the map flies there and marks it; a check is the user's next choice
        const ws = useWorkspace.getState()
        ws.setDevice(d)
        ws.requestMapFlyTo({ lon: d.lon, lat: d.lat, zoom: deviceZoom(d.accuracyM) })
        setFound(true)
      },
      (err) => {
        if (mine !== seq.current) return
        setBusy(false)
        setFailure(locateFailure(err?.code))
      },
      { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: LOCATE_MAX_AGE_MS },
    )
  }

  const check = () => {
    const d = useWorkspace.getState().device
    if (!d) return
    setFound(false)
    useWorkspace.getState().selectLocation(deviceSelection(d), { fly: false })
  }
  const hide = () => {
    setFound(false)
    useWorkspace.getState().setDevice(null)
  }

  const prompt = found && device != null
  return (
    <div className="loc-locate">
      <button
        type="button"
        className={`loc-locate-btn${busy ? ' is-busy' : ''}${device ? ' is-on' : ''}`}
        aria-label={busy ? 'Finding your location…' : LOCATE_LABEL}
        aria-describedby={failure || prompt ? msgId : undefined}
        aria-busy={busy || undefined}
        data-tip={LOCATE_TIP}
        onClick={() => {
          if (!busy) locate()
        }}
      >
        {busy ? <LoaderCircle size={20} className="loc-spin" aria-hidden="true" /> : <LocateIcon />}
      </button>
      <div className="loc-locate-below" aria-live="polite">
        {failure && (
          <p className="mw-panel loc-locate-msg" id={msgId} role="status">
            <span>{LOCATE_MESSAGES[failure]}</span>
            <button type="button" className="mw-icon-btn is-sm" aria-label="Dismiss" onClick={() => setFailure(null)}>
              <X size={13} aria-hidden="true" />
            </button>
          </p>
        )}
        {prompt && (
          <div className="mw-panel loc-locate-msg loc-locate-found" id={msgId} role="status">
            <div className="loc-locate-found-body">
              <p className="loc-locate-found-text">{LOCATE_FOUND}</p>
              <p className="loc-locate-found-note">{LOCATE_CHECK_NOTE}</p>
              <div className="loc-locate-found-actions">
                <button type="button" className="mw-btn is-sm is-primary" onClick={check}>
                  {LOCATE_CHECK_LABEL}
                </button>
                <button type="button" className="mw-btn is-sm" onClick={hide}>
                  {LOCATE_HIDE_LABEL}
                </button>
              </div>
            </div>
            <button type="button" className="mw-icon-btn is-sm" aria-label="Close" data-tip="Close (the map keeps showing your location)" onClick={() => setFound(false)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
