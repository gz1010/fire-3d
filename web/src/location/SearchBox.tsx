// "Check an address" search (owner: us-web; CONTRACT §5.1, brief 2 C-R1/R3/R4/R5, O-R9; brief 3 §14.10: every
// lower-48 state, "Boise, ID", "83702 ID", the lat/lon order guess of W8 and US wording). One explicitly submitted
// query, no autocomplete: pasted coordinates are read locally (lib/geodesy); an exact incident name opens that fire
// (search.ts); street addresses go to the Census Geocoder proxy and towns / ZIP codes to the local Census Gazetteer
// index through /api/geocode. Census positions are interpolated along address ranges: they are selected as
// approximate and adjustable, and ambiguous results are listed, never picked silently. A prepared fire opens
// explicitly (openFromSearch: framed, source 'search'); an unprepared fire only opens its card (I3), whose "Prepare
// analysis (1-3 min)" is the one place a build can start.
// One popover (hint, busy, message or results) closes on Escape, an edit, Clear, an outside click, a map click, a new
// selection and a pick; every close cancels the lookup in flight and late replies are dropped (search.ts state
// machine). A fire focused or left by zooming (brief 2 decision 10) changes neither. The popover never covers the
// location card (searchUi.ts). Phones: focusing the box closes open sheets, and a pick blurs the input. "/" focuses
// the box.
import { Building2, Flame, Hash, LoaderCircle, MapPin, Search, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { IncidentSummary } from '../api/types'
import { distanceM, formatLat, formatLon, type ParsedLatLon } from '../lib/geodesy'
import { distance } from '../lib/plainLanguage'
import { pickFire } from '../state/fireCard'
import { useStore } from '../state/store'
import { useWorkspace, type PanelKey } from '../state/workspace'
import { addressDetails, addressRange, prettyAddress, useAddressDetails } from './addressStore'
import { geocodeAddress, plainSearchError } from './geocodeClient'
import { incidentPool } from './incidents'
import { openFromSearch } from './openFromSearch'
import {
  INITIAL_SEARCH,
  READINESS_LABEL,
  areaBounds,
  areaLabel,
  areaSub,
  NOT_SUPPORTED_NOTE,
  OUTSIDE_LOWER48_WARNING,
  placeName,
  cancelledLookup,
  decide,
  fireResultFacts,
  incidentAction,
  likelyMissingWestSign,
  listCount,
  planSearch,
  readiness,
  searchReducer,
  type IncidentHit,
  type Popover,
  type ResultLists,
  type SearchEvent,
  type SearchPlan,
  type SearchState,
} from './search'
import { freshCarry, useSearchUi } from './searchUi'
import type { GeocodeMatch, GeocodeResponse } from './types'
import { useNarrow } from './useNarrow'
import './location.css'

const ADDRESS_NOTE = 'Street addresses: U.S. Census Bureau Geocoder. Positions are interpolated along the street’s address range (approximate).'
const GAZETTEER_CREDIT = 'Towns and ZIP areas: U.S. Census Bureau Gazetteer Files.'
const SHEETS: PanelKey[] = ['updates', 'layers', 'analysis']

/** Zoom for a searched point: neighbourhood scale, or closer if the map is already closer. */
function flyZoom(): number {
  return Math.min(16, Math.max(14, useWorkspace.getState().view?.zoom ?? 0))
}

const fireName = (s: Pick<IncidentSummary, 'name'>) => (/\bfire$/i.test(s.name) ? `the ${s.name}` : s.name)

/** The text and popover the previous chrome's box handed over (searchUi.ts carry), read when this box first renders. */
function readCarry(): { text: string; state: SearchState } | null {
  const c = freshCarry(useSearchUi.getState().carry, Date.now())
  return c ? { text: c.text, state: { ...INITIAL_SEARCH, popover: c.popover } } : null
}

/** `panel` (default): the labelled box of the fire chromes and Command's popover. `pill` (brief 4, Main.dc.html): the
 *  overview's centred 52 px pill; its label is kept for screen readers only and the placeholder names what it takes. */
export type SearchBoxVariant = 'panel' | 'pill'

export const PILL_PLACEHOLDER = 'Check an address, town, ZIP or coordinates'
/** Phones: the same, short enough for a 390 px screen beside the Search button. */
export const PILL_PLACEHOLDER_SHORT = 'Address, town or ZIP'

export function SearchBox({ variant = 'panel' }: { variant?: SearchBoxVariant } = {}) {
  const pill = variant === 'pill'
  const [carried] = useState(readCarry)
  const [text, setText] = useState(carried?.text ?? '')
  const [focused, setFocused] = useState(false)
  const [state, setState] = useState<SearchState>(carried?.state ?? INITIAL_SEARCH)
  const units = useWorkspace((s) => s.units)
  const hasSelection = useWorkspace((s) => s.selection != null)
  const summary = useStore((s) => s.summary)
  const incidentId = useStore((s) => s.incidentId)
  const narrow = useNarrow()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLFormElement | null>(null)
  const belowRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef(state)
  const ctrls = useRef(new Map<number, AbortController>())
  const inputId = useId()
  const listId = useId()
  const statusId = useId()

  /** Every transition goes through here: a cancelled lookup is aborted at once. */
  const dispatch = useCallback((e: SearchEvent) => {
    const prev = stateRef.current
    const next = searchReducer(prev, e)
    if (next === prev) return
    const c = cancelledLookup(prev, next)
    if (c != null) {
      ctrls.current.get(c)?.abort()
      ctrls.current.delete(c)
    }
    stateRef.current = next
    setState(next)
  }, [])

  // a fire opening or closing, or another preset, swaps the chrome and with it this box: hand the text and an open
  // message or result list to the next box (searchUi.ts carry). Zustand calls these before React renders the next
  // chrome, whose box reads the carry when it first renders and clears it once mounted.
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])
  useEffect(() => {
    useSearchUi.getState().setCarry(null) // taken (or stale)
    const save = () => {
      const p = stateRef.current.popover
      if (stateRef.current.pending == null && (p.kind === 'message' || p.kind === 'results'))
        useSearchUi.getState().setCarry({ text: textRef.current, popover: p, atMs: Date.now() })
    }
    const offFire = useStore.subscribe((s, p) => {
      if ((s.incidentId == null) !== (p.incidentId == null)) save()
    })
    const offPreset = useWorkspace.subscribe((s, p) => {
      if (s.preset !== p.preset) save()
    })
    return () => {
      offFire()
      offPreset()
    }
  }, [])

  // "/" focuses the box (not while typing elsewhere); unmount cancels a lookup in flight
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      inputRef.current?.focus()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const map = ctrls.current
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const c of map.values()) c.abort()
      map.clear()
    }
  }, [])

  // a new selection (map click, event, drag) closes the popover and cancels the lookup. A change of the open fire does
  // not: zooming focuses and leaves prepared fires on its own (brief 2 decision 10), which is not a new question.
  useEffect(
    () =>
      useWorkspace.subscribe((s, p) => {
        if (s.selection !== p.selection) dispatch({ type: 'close' })
      }),
    [dispatch],
  )

  // an outside pointer-down (the map included) closes the popover
  const open = state.popover.kind !== 'closed'
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) dispatch({ type: 'close' })
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, dispatch])

  // confirmations fade after a few seconds; warnings, errors and questions stay until the next action
  useEffect(() => {
    const p = state.popover
    if (p.kind !== 'message' || p.tone !== 'ok' || p.lists) return
    const t = window.setTimeout(() => {
      if (stateRef.current.popover === p) dispatch({ type: 'close' })
    }, 5000)
    return () => window.clearTimeout(t)
  }, [state.popover, dispatch])

  // publish the popover's box so the location card moves out of its way
  const setPopoverBox = useSearchUi((s) => s.setPopover)
  useLayoutEffect(() => {
    const el = belowRef.current
    if (!el || !open) {
      setPopoverBox(null)
      return
    }
    const measure = () => {
      const r = el.getBoundingClientRect()
      setPopoverBox(r.height > 0 ? { top: r.top, bottom: r.bottom } : null)
    }
    measure()
    // content changes resize the popover; the observer re-measures them
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, setPopoverBox])
  useEffect(() => () => setPopoverBox(null), [setPopoverBox])

  /** After a pick: phones drop the keyboard so the card and the map show. */
  const afterPick = () => {
    if (narrow) inputRef.current?.blur()
  }

  const show = (popover: Popover) => dispatch({ type: 'show', popover })
  const message = (tone: 'info' | 'ok' | 'warn' | 'error', textMsg: string, lists: ResultLists | null = null, fix: { lat: number; lon: number } | null = null, credit: string | null = null) =>
    show({ kind: 'message', tone, text: textMsg, lists: lists && listCount(lists) ? lists : null, fix, credit })

  const chooseCoords = (p: { lat: number; lon: number }, read?: ParsedLatLon) => {
    useWorkspace.getState().selectLocation({ lat: p.lat, lon: p.lon, source: 'coords' }, { fly: true, zoom: flyZoom() })
    const how = read?.fromLink ? ' (from the map link)' : read?.order === 'lon-lat' ? ' (read as longitude, latitude)' : ''
    const east = read && likelyMissingWestSign(read)
    if (east) message('warn', `Showing ${formatLat(p.lat)}, ${formatLon(p.lon)}${how}: east longitude, far from the lower 48 states.`, null, { lat: p.lat, lon: -p.lon })
    else if (read?.outsideLower48) message('warn', `Showing ${formatLat(p.lat)}, ${formatLon(p.lon)}${how}. ${OUTSIDE_LOWER48_WARNING}`)
    else message('ok', `Showing ${formatLat(p.lat)}, ${formatLon(p.lon)}${how}.`)
    afterPick()
  }

  const chooseAddress = (res: GeocodeResponse, m: GeocodeMatch) => {
    useAddressDetails.getState().setDetails(addressDetails(res, m))
    useWorkspace.getState().selectLocation(
      { lat: m.lat, lon: m.lon, source: 'address', label: prettyAddress(m.matched_address), matchedAddress: m.matched_address, approximate: true, adjustable: true },
      { fly: true, zoom: Math.max(15, flyZoom()) },
    )
    dispatch({ type: 'close' }) // the card says it is approximate and adjustable
    afterPick()
  }

  /** A town or ZIP area: fly there and ask for a street address or a map click (it is not a point check). */
  const chooseArea = (m: GeocodeMatch, others: ResultLists | null) => {
    const ws = useWorkspace.getState()
    ws.clearSelection() // the previous point belongs to another search
    const b = areaBounds(m)
    ws.requestMapFlyTo({ lon: m.lon, lat: m.lat, bounds: b })
    if (m.supported === false) message('warn', `Showing ${areaLabel(m)}. ${NOT_SUPPORTED_NOTE}`, others, null, GAZETTEER_CREDIT)
    else message('info', `Showing ${areaLabel(m)}. To check a spot, enter a street address with a house number, or click the map.`, others, null, GAZETTEER_CREDIT)
    afterPick()
  }

  const actOnIncident = (hit: IncidentHit) => {
    const s = hit.summary
    const act = incidentAction(s, useStore.getState().incidentId)
    if (act === 'show-current') {
      useWorkspace.getState().returnToIncident()
      setText('')
      message('ok', `Showing ${fireName(s)}.`)
      afterPick()
      return
    }
    if (act === 'open') {
      setText('')
      dispatch({ type: 'close' })
      openFromSearch(s.id) // an explicit open (framed, a history step); never a build
      afterPick()
      return
    }
    // not prepared: show it and open its card, which asks before preparing (1-3 min of public downloads)
    pickFireCard(s)
  }

  /** Fly to a fire and open its card (I3) the way the overview list does (state/fireCard.ts: an unprepared fire holds
   *  the map's zoom focus, so a nearby prepared fire does not open instead), then close the popover. Public opens the
   *  fire view instead (brief 4 decision b, pickFire). */
  const pickFireCard = (s: IncidentSummary) => {
    dispatch({ type: 'close' })
    pickFire(s.id, s)
    afterPick()
  }

  const lookup = async (plan: Extract<SearchPlan, { kind: 'lookup' }>) => {
    dispatch({ type: 'lookup', text: plan.expect === 'address' ? 'Looking up the address (U.S. Census Bureau)…' : 'Searching US towns and ZIP codes…' })
    const seq = stateRef.current.seq
    const ctrl = new AbortController()
    ctrls.current.set(seq, ctrl)
    const current = () => !ctrl.signal.aborted && stateRef.current.pending === seq
    try {
      const res = await geocodeAddress(plan.query, { signal: ctrl.signal })
      if (!current()) return // cancelled or superseded: a late reply is dropped
      ctrls.current.delete(seq)
      const d = decide(plan, res)
      if (d.kind === 'address') return chooseAddress(res, d.match)
      if (d.kind === 'area') return chooseArea(d.match, d.others)
      if (d.kind === 'incident') return actOnIncident(d.hit)
      if (d.kind === 'none') return dispatch({ type: 'reply', seq, popover: { kind: 'message', tone: 'warn', text: d.message, lists: null, fix: null } })
      dispatch({ type: 'reply', seq, popover: { kind: 'results', message: d.message, lists: d.lists, response: res } })
    } catch (e) {
      if (!current()) return
      ctrls.current.delete(seq)
      if (plan.candidate) return actOnIncident(plan.candidate) // incident search works without the geocoder
      const lists: ResultLists = { addresses: [], places: [], zips: [], incidents: plan.incidents }
      dispatch({ type: 'reply', seq, popover: { kind: 'message', tone: 'error', text: plainSearchError(e), lists: listCount(lists) ? lists : null, fix: null } })
    }
  }

  const submit = () => {
    const st = useStore.getState()
    // a fire list not arrived yet (first seconds after load): a search finding nothing says so (integration part 2)
    const pending = (['live', 'season', 'historical'] as const).some((k) => st.catalog.updatedMs[k] == null && st.catalog.listLoading[k])
    const plan = planSearch(text, incidentPool(st), pending)
    switch (plan.kind) {
      case 'empty':
        return dispatch({ type: 'close' })
      case 'coords':
        return chooseCoords(plan.parsed, plan.parsed)
      case 'invalid':
        return message('warn', plan.message)
      case 'incident':
        return actOnIncident(plan.hit)
      case 'lookup':
        return void lookup(plan)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.loc-result') ?? [])
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' && items.length) {
      items[Math.min(items.length - 1, i + 1)]?.focus()
      e.preventDefault()
    } else if (e.key === 'ArrowUp' && items.length && i >= 0) {
      if (i === 0) inputRef.current?.focus()
      else items[i - 1]?.focus()
      e.preventDefault()
    } else if (e.key === 'Escape') {
      // our popover (and its lookup) first; then an empty box lets go of the focus. Never the shell's drawers.
      if (stateRef.current.popover.kind !== 'closed' || stateRef.current.pending != null) {
        dispatch({ type: 'close' })
        if (document.activeElement !== inputRef.current) inputRef.current?.focus()
      } else if (document.activeElement === inputRef.current && !text) inputRef.current?.blur()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const fixSign = state.popover.kind === 'message' ? state.popover.fix : null
  // distance of each address candidate from the open fire's reported location (helps pick the right one)
  const near = summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon) ? { lat: summary.lat, lon: summary.lon, name: summary.name } : null
  const p = state.popover
  const busy = state.pending != null
  const lists = p.kind === 'results' ? p.lists : p.kind === 'message' ? p.lists : null
  const popText = p.kind === 'busy' ? p.text : p.kind === 'message' ? p.text : p.kind === 'results' ? p.message : null
  const tone = p.kind === 'message' ? p.tone : 'info'
  return (
    <form
      ref={rootRef}
      className={`loc-search${pill ? ' is-pill' : ''}${open ? ' is-open' : ''}`}
      role="search"
      aria-label="Check an address"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="mw-panel loc-search-box">
        {pill ? (
          <label className="loc-sr" htmlFor={inputId}>
            Check an address: street, town, ZIP code or coordinates
          </label>
        ) : (
          <label className="loc-search-label" htmlFor={inputId}>
            Check an address <span className="loc-search-label-sub">street, town, ZIP code or coordinates</span>
          </label>
        )}
        <div className="loc-search-bar">
          <Search size={pill ? 18 : 15} aria-hidden="true" className="loc-search-icon" />
          <input
            ref={inputRef}
            id={inputId}
            className="loc-search-input"
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={200}
            aria-describedby={statusId}
            aria-controls={lists ? listId : undefined}
            placeholder={pill ? (narrow ? PILL_PLACEHOLDER_SHORT : PILL_PLACEHOLDER) : 'e.g. 150 N Capitol Blvd, Boise, ID'}
            value={text}
            onFocus={() => {
              setFocused(true)
              // phones: an open sheet would hide the results
              if (narrow) {
                const ws = useWorkspace.getState()
                for (const k of SHEETS) if (ws.panels[k]) ws.setPanel(k, false)
              }
              if (!useWorkspace.getState().selection) dispatch({ type: 'focus', empty: !text })
            }}
            onBlur={() => {
              setFocused(false)
              dispatch({ type: 'blur' })
            }}
            onChange={(e) => {
              setText(e.target.value)
              dispatch({ type: 'edit', empty: !e.target.value, focused: focused && !hasSelection })
            }}
          />
          {busy && <LoaderCircle size={15} className="loc-spin" aria-hidden="true" />}
          {text && (
            <button
              type="button"
              className="mw-icon-btn is-sm"
              aria-label="Clear search"
              onClick={() => {
                setText('')
                dispatch({ type: 'close' })
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
      </div>
      <div ref={belowRef} id={statusId} className="loc-search-below" aria-live="polite">
        {p.kind === 'hint' && (
          <p className="mw-panel loc-search-hint">
            Enter a street address with a house number (<span className="mw-mono">150 N Capitol Blvd, Boise, ID</span>), a US town or ZIP code (
            <span className="mw-mono">Springfield, IL</span>; <span className="mw-mono">83702</span>), coordinates or a fire’s name, then press Enter. Or click the map.
          </p>
        )}
        {(p.kind === 'busy' || p.kind === 'message') && !lists && (
          <p className={`mw-panel loc-search-status is-${p.kind === 'busy' ? 'info' : tone}`} role={tone === 'error' ? 'alert' : undefined}>
            {p.kind === 'busy' && <LoaderCircle size={13} className="loc-spin" aria-hidden="true" />}
            <span>{popText}</span>
            {fixSign && (
              <button type="button" className="mw-link-btn" onClick={() => chooseCoords(fixSign)}>
                Use {formatLon(fixSign.lon)} instead?
              </button>
            )}
            {p.kind === 'message' && p.credit && <span className="loc-search-credit">{p.credit}</span>}
          </p>
        )}
        {lists && (
          <div className="mw-panel loc-results" id={listId}>
            {popText && (
              <p className={`loc-results-status is-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
                {popText}
                {p.kind === 'message' && p.credit && <span className="loc-search-credit">{p.credit}</span>}
              </p>
            )}
            <Results
              lists={lists}
              response={p.kind === 'results' ? p.response : null}
              others={p.kind === 'message'}
              units={units}
              near={near}
              currentId={incidentId}
              onAddress={(res, m) => chooseAddress(res, m)}
              onArea={(m) => chooseArea(m, null)}
              onIncident={(h) => actOnIncident(h)}
            />
          </div>
        )}
      </div>
    </form>
  )
}

interface ResultsProps {
  lists: ResultLists
  response: GeocodeResponse | null
  /** The lists are "other matches" after a town was shown. */
  others: boolean
  units: ReturnType<typeof useWorkspace.getState>['units']
  near: { lat: number; lon: number; name: string } | null
  currentId: string | null
  onAddress: (res: GeocodeResponse, m: GeocodeMatch) => void
  onArea: (m: GeocodeMatch) => void
  onIncident: (h: IncidentHit) => void
}

function Results({ lists, response, others, units, near, currentId, onAddress, onArea, onIncident }: ResultsProps) {
  const areas = [...lists.places, ...lists.zips]
  return (
    <>
      {lists.addresses.length > 0 && response && (
        <section aria-label="Street addresses">
          <h3 className="mw-eyebrow loc-results-head">Street addresses · approximate</h3>
          <ul>
            {lists.addresses.map((m) => {
              const range = addressRange(m.from_address, m.to_address)
              return (
                <li key={`${m.matched_address}|${m.lat}|${m.lon}`}>
                  <button type="button" className="loc-result" onClick={() => onAddress(response, m)}>
                    <MapPin size={14} aria-hidden="true" className="loc-result-icon is-select" />
                    <span className="loc-result-text">
                      <span className="loc-result-title">{prettyAddress(m.matched_address)}</span>
                      <span className="loc-result-sub">
                        {near && `${distance(distanceM(near, m), units).text} from ${near.name} · `}
                        Interpolated along {range ? <span className="loc-nowrap">house numbers {range}</span> : 'the address range'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="loc-results-note">{ADDRESS_NOTE}</p>
        </section>
      )}
      {areas.length > 0 && (
        <section aria-label="Towns and ZIP areas">
          <h3 className="mw-eyebrow loc-results-head">{others ? 'Other towns and ZIP areas' : 'Towns and ZIP areas · approximate'}</h3>
          <ul>
            {areas.map((m) => (
              <li key={`${m.kind}|${m.matched_address}|${m.lat}|${m.lon}`}>
                <button type="button" className="loc-result" onClick={() => onArea(m)}>
                  {m.kind === 'zip' ? <Hash size={14} aria-hidden="true" className="loc-result-icon" /> : <Building2 size={14} aria-hidden="true" className="loc-result-icon" />}
                  <span className="loc-result-text">
                    <span className="loc-result-title">{m.kind === 'zip' ? (m.zip ? `ZIP ${m.zip}${m.state ? `, ${m.state}` : ''}` : (m.name ?? m.matched_address)) : placeName(m)}</span>
                    <span className="loc-result-sub">{areaSub(m)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="loc-results-note">Towns and ZIP areas: U.S. Census Bureau Gazetteer Files. Picking one moves the map; then enter a street address or click the map.</p>
        </section>
      )}
      {lists.incidents.length > 0 && (
        <section aria-label="Fires">
          <h3 className="mw-eyebrow loc-results-head">{others ? 'Fires that match' : 'Fires'}</h3>
          <ul>
            {lists.incidents.map((h) => {
              const s = h.summary
              const r = readiness(s)
              const current = s.id === currentId
              const facts = fireResultFacts(s, units)
              const opensCard = !current && (r === 'not-prepared' || r === 'failed')
              return (
                <li key={s.id}>
                  <button type="button" className="loc-result" onClick={() => onIncident(h)} title={opensCard ? 'Shows the fire and its card; preparing the analysis is asked there' : undefined}>
                    <Flame size={14} aria-hidden="true" className="loc-result-icon is-fire" />
                    <span className="loc-result-text">
                      <span className="loc-result-title">
                        {s.name}{' '}
                        <span className={`loc-chip is-${current ? 'current' : r}`}>{current ? 'Showing' : READINESS_LABEL[r]}</span>
                      </span>
                      <span className="loc-result-sub">
                        {facts.join(' · ')}
                        {opensCard && ' · opens its card'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}
