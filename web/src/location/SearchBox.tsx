// Location search (owner: location; CONTRACT §5.1, BRIEF §8). One explicitly submitted query, no autocomplete:
// pasted coordinates are read locally (lib/geodesy), incident names are matched in the loaded catalog, and only text
// that starts with a house number goes to the Census Geocoder proxy (/api/geocode). Census positions are
// interpolated along address ranges: they are selected as approximate and adjustable, and ambiguous results are
// listed, never picked silently. Coordinates and incident search work without the geocoder. "/" focuses the box.
import { Flame, LoaderCircle, MapPin, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { IncidentSummary } from '../api/types'
import { describeError } from '../api/client'
import { distanceM, formatLat, formatLon, type ParsedLatLon } from '../lib/geodesy'
import { area, distance } from '../lib/plainLanguage'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { addressDetails, addressRange, useAddressDetails } from './addressStore'
import { geocodeAddress } from './geocodeClient'
import { likelyMissingWestSign, planSearch, type IncidentHit } from './search'
import type { GeocodeMatch, GeocodeResponse } from './types'
import './location.css'

type Status = { tone: 'info' | 'ok' | 'warn' | 'error'; text: string; busy?: boolean } | null

interface Results {
  incidents: IncidentHit[]
  addresses: { res: GeocodeResponse; matches: GeocodeMatch[] } | null
}

const NOTE = 'Street addresses: U.S. Census Bureau Geocoder. Positions are interpolated along the street’s address range (approximate).'

/** Zoom for a searched point: neighbourhood scale, or closer if the map is already closer. */
function flyZoom(): number {
  return Math.min(16, Math.max(14, useWorkspace.getState().view?.zoom ?? 0))
}

function incidentPool(): IncidentSummary[] {
  const s = useStore.getState()
  return [...(s.summary ? [s.summary] : []), ...s.catalog.live, ...s.catalog.historical]
}

export function SearchBox() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [focused, setFocused] = useState(false)
  const [lastCoords, setLastCoords] = useState<ParsedLatLon | null>(null)
  const units = useWorkspace((s) => s.units)
  const summary = useStore((s) => s.summary)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLFormElement | null>(null)
  const reqRef = useRef<AbortController | null>(null)
  const listId = useId()
  const statusId = useId()

  // "/" focuses the search box (not while typing elsewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      inputRef.current?.focus()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      reqRef.current?.abort()
    }
  }, [])

  // confirmations fade after a few seconds (warnings and errors stay until the next edit)
  useEffect(() => {
    if (status?.tone !== 'ok') return
    const t = window.setTimeout(() => setStatus((cur) => (cur === status ? null : cur)), 5000)
    return () => window.clearTimeout(t)
  }, [status])

  // close the result list on outside pointer-down
  useEffect(() => {
    if (!results) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setResults(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [results])

  const close = () => {
    setResults(null)
    inputRef.current?.focus()
  }

  const chooseCoords = (p: { lat: number; lon: number }, read?: ParsedLatLon) => {
    useWorkspace.getState().selectLocation({ lat: p.lat, lon: p.lon, source: 'coords' }, { fly: true, zoom: flyZoom() })
    setLastCoords(read ?? null)
    const how = read?.fromLink ? ' (from the map link)' : read?.order === 'lon-lat' ? ' (read as longitude, latitude)' : ''
    const east = read && likelyMissingWestSign(read)
    setStatus({ tone: east ? 'warn' : 'ok', text: `Showing ${formatLat(p.lat)}, ${formatLon(p.lon)}${how}${east ? ': east longitude, far from California.' : ''}` })
    setResults(null)
  }

  const chooseIncident = (s: IncidentSummary) => {
    setResults(null)
    setStatus(null)
    setText('')
    if (s.id !== useStore.getState().incidentId) void useStore.getState().selectIncident(s.id, { autoBuild: true })
    else useWorkspace.getState().returnToIncident()
  }

  const chooseAddress = (res: GeocodeResponse, m: GeocodeMatch) => {
    useAddressDetails.getState().setDetails(addressDetails(res, m))
    useWorkspace.getState().selectLocation(
      { lat: m.lat, lon: m.lon, source: 'address', label: m.matched_address, matchedAddress: m.matched_address, approximate: true, adjustable: true },
      { fly: true, zoom: Math.max(15, flyZoom()) },
    )
    setStatus(null) // the card says it is approximate and adjustable
    setResults(null)
  }

  const submit = async () => {
    const q = text.trim()
    reqRef.current?.abort()
    reqRef.current = null
    setLastCoords(null)
    const plan = planSearch(q, incidentPool())
    if (plan.kind === 'empty') {
      setStatus(null)
      setResults(null)
      return
    }
    if (plan.kind === 'coords') return chooseCoords(plan.parsed, plan.parsed)
    if (plan.kind === 'nothing') {
      const loading = useStore.getState().catalog.loading
      setResults(null)
      setStatus({
        tone: 'warn',
        text: loading
          ? 'The incident list is still loading. Try again in a moment.'
          : `No incident matches “${q}”. For an address, start with the house number (e.g. 600 E Mariposa St, Altadena, CA). Place names are not searched.`,
      })
      return
    }
    if (plan.kind === 'incidents') {
      if (plan.incidents.length === 1 || plan.incidents[0].score === 100) return chooseIncident(plan.incidents[0].summary)
      setStatus(null)
      setResults({ incidents: plan.incidents, addresses: null })
      return
    }
    // a street address: Census lookup through the API (incident matches are listed too)
    const ctrl = new AbortController()
    reqRef.current = ctrl
    setResults(plan.incidents.length ? { incidents: plan.incidents, addresses: null } : null)
    setStatus({ tone: 'info', text: 'Looking up the address (U.S. Census Bureau)…', busy: true })
    try {
      const res = await geocodeAddress(plan.query, { signal: ctrl.signal, timeoutMs: 30_000 })
      if (ctrl.signal.aborted) return
      reqRef.current = null
      if (res.matches.length === 1 && !plan.incidents.length) return chooseAddress(res, res.matches[0])
      if (!res.matches.length) {
        setStatus({ tone: 'warn', text: 'No US street address matched. Check the house number, street and city or ZIP code.' })
        if (!plan.incidents.length) setResults(null)
        return
      }
      const more = (res.total_matches ?? res.matches.length) > res.matches.length ? ` (first ${res.matches.length} of ${res.total_matches})` : ''
      setStatus({ tone: 'info', text: `${res.matches.length === 1 ? 'One address matches' : `${res.matches.length} addresses match${more}`}: choose one.` })
      setResults({ incidents: plan.incidents, addresses: { res, matches: res.matches } })
    } catch (e) {
      if (ctrl.signal.aborted) return
      reqRef.current = null
      setStatus({ tone: 'error', text: `Address lookup failed: ${describeError(e)}. Coordinates, map clicks and incident search still work.` })
    }
  }

  const onListKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.loc-result') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      items[Math.min(items.length - 1, i + 1)]?.focus()
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      if (i <= 0) inputRef.current?.focus()
      else items[i - 1]?.focus()
      e.preventDefault()
    } else if (e.key === 'Escape' && (results || status)) {
      // close our popover only (not the shell's drawers, which also listen for Escape)
      setStatus(null)
      close()
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const fixSign = lastCoords && likelyMissingWestSign(lastCoords) ? { lat: lastCoords.lat, lon: -lastCoords.lon } : null
  // distance of each address candidate from the selected incident's reported location (helps pick the right one)
  const near = summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon) ? { lat: summary.lat, lon: summary.lon, name: summary.name } : null
  const showHint = focused && !text && !results && !status
  return (
    <form
      ref={rootRef}
      className="loc-search"
      role="search"
      aria-label="Search address, coordinates or incident"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={onListKey}
    >
      <div className="mw-panel loc-search-bar">
        <Search size={15} aria-hidden="true" className="loc-search-icon" />
        <input
          ref={inputRef}
          className="loc-search-input"
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          aria-label="Address, coordinates or incident"
          aria-describedby={statusId}
          placeholder="Address, coordinates or incident"
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value)
            if (status?.tone !== 'info' || !status.busy) setStatus(null)
          }}
        />
        {status?.busy && <LoaderCircle size={15} className="loc-spin" aria-hidden="true" />}
        {text && (
          <button
            type="button"
            className="mw-icon-btn is-sm"
            aria-label="Clear search"
            onClick={() => {
              reqRef.current?.abort()
              setText('')
              setStatus(null)
              setResults(null)
              inputRef.current?.focus()
            }}
          >
            <X size={13} />
          </button>
        )}
        <button type="submit" className="mw-btn is-sm loc-search-go" disabled={!text.trim()}>
          Search
        </button>
      </div>
      <div id={statusId} className="loc-search-below" aria-live="polite">
        {showHint && (
          <p className="mw-panel loc-search-hint">
            Try <span className="mw-mono">600 E Mariposa St, Altadena, CA</span>, <span className="mw-mono">34.2048, -118.1027</span> or an incident name. Press Enter to search.
          </p>
        )}
        {status && !results && (
          <p className={`mw-panel loc-search-status is-${status.tone}`} role={status.tone === 'error' ? 'alert' : undefined}>
            {status.text}
            {fixSign && (
              <button type="button" className="mw-link-btn" onClick={() => chooseCoords(fixSign)}>
                Use {formatLon(fixSign.lon)} instead?
              </button>
            )}
          </p>
        )}
        {results && (
          <div className="mw-panel loc-results" id={listId}>
            {status && <p className={`loc-results-status is-${status.tone}`}>{status.text}</p>}
            {results.incidents.length > 0 && (
              <section aria-label="Incidents">
                <h3 className="mw-eyebrow loc-results-head">Incidents</h3>
                <ul>
                  {results.incidents.map(({ summary: s }) => (
                    <li key={s.id}>
                      <button type="button" className="loc-result" onClick={() => chooseIncident(s)}>
                        <Flame size={14} aria-hidden="true" className="loc-result-icon is-fire" />
                        <span className="loc-result-text">
                          <span className="loc-result-title">{s.name}</span>
                          <span className="loc-result-sub">
                            {[s.year, s.county ? `${s.county} County` : null, s.acres ? area(s.acres, units).text : null, s.is_active ? 'active' : null].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {results.addresses && (
              <section aria-label="Street addresses">
                <h3 className="mw-eyebrow loc-results-head">Addresses · approximate</h3>
                <ul>
                  {results.addresses.matches.map((m) => (
                    <li key={`${m.matched_address}|${m.lat}|${m.lon}`}>
                      <button type="button" className="loc-result" onClick={() => chooseAddress(results.addresses!.res, m)}>
                        <MapPin size={14} aria-hidden="true" className="loc-result-icon is-select" />
                        <span className="loc-result-text">
                          <span className="loc-result-title">{m.matched_address}</span>
                          <span className="loc-result-sub">
                            {near && `${distance(distanceM(near, m), units).text} from ${near.name} · `}
                            Interpolated along{' '}
                            {addressRange(m.from_address, m.to_address) ? (
                              <>
                                house numbers <span className="loc-nowrap">{addressRange(m.from_address, m.to_address)}</span>
                              </>
                            ) : (
                              'the address range'
                            )}{' '}
                            ·{' '}
                            <span className="mw-mono">
                              {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(results.addresses || status?.busy) && <p className="loc-results-note">{NOTE}</p>}
          </div>
        )}
      </div>
    </form>
  )
}
