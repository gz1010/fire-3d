// Incident picker (SPEC 9.4; brief 2): Active / 2026 season / 2025 lists (the overview's filters, state/overview.ts),
// search (name, county, state, place, id), >= 100 ac toggle (2025), and rows with name, county and state, acres,
// containment, start date (in the fire's own zone), the agency's status and whether Fire-3d's analysis is prepared. Picking a fire never starts a build by itself: in the map workspace an unprepared fire
// opens its fire card ("Prepare analysis (1-3 min)"); in Forensic it opens with the Build button (or builds when the
// Forensic setting "Prepare analysis when I pick an unprepared fire" is on). Keyboard: arrows + Enter, Esc closes.
import { ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { IncidentSummary } from '../api/types'
import { fmtAcresShort, fmtNumber } from '../lib/format'
import { fmtDayDate, fmtRelative, timeFmt } from '../lib/time'
import { analysisState, emptyListText, fireStatus, isActiveFire, pickerMatches, pickerWhere, OVERVIEW_FILTERS, overviewFires, PAST_YEAR, SEASON_MIN_ACRES, SEASON_YEAR, type OverviewFilter } from '../state/overview'
import { useStore } from '../state/store'
import { useWorkspace } from '../state/workspace'
import { Popover, Segmented, Spinner, Switch } from './controls'
import { useNow } from './hooks'
import { showFireCard } from './shell/fireActions'
import { useListWindow } from './useListWindow'

/** The list's own top and bottom padding (styles/header.css .picker-list). */
const LIST_PAD_PX = 4

const STATUS_CLS = { active: 'chip-live', contained: 'chip-ok', out: 'chip-muted' } as const

function statusChip(s: IncidentSummary): { label: string; cls: string } {
  const st = fireStatus(s)
  return { label: st.label, cls: s.mode === 'live' || st.key !== 'active' ? STATUS_CLS[st.key] : 'chip-muted' }
}

function bundleChip(s: IncidentSummary): { label: string; cls: string; tip: string } {
  switch (analysisState(s)) {
    case 'ready':
      return { label: 'Ready', cls: 'chip-ok', tip: s.bundle_built_ms ? `Analysis prepared ${fmtRelative(s.bundle_built_ms)}` : 'Analysis ready' }
    case 'building':
      return { label: 'Preparing', cls: 'chip-gold', tip: 'The analysis is being prepared' }
    case 'error':
      return { label: 'Failed', cls: 'chip-danger', tip: 'The last preparation failed; pick the fire to prepare it again' }
    default:
      return { label: 'Not prepared', cls: 'chip-muted', tip: "No analysis yet: pick the fire to see its agency record and prepare the analysis (1-3 min)" }
  }
}

/** The picker's first list: where the open fire is listed. */
function initialFilter(s: IncidentSummary | null): OverviewFilter {
  if (!s) return 'season'
  if (isActiveFire(s)) return 'active'
  return s.year === PAST_YEAR ? 'past' : 'season'
}

export function ContainmentBar({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="muted mono">—</span>
  return (
    <span className="cont">
      <span className="cont-bar">
        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      <span className="mono">{fmtNumber(pct)}%</span>
    </span>
  )
}

export function IncidentPicker() {
  const summary = useStore((s) => s.summary)
  const mode = useStore((s) => s.mode)
  const loading = useStore((s) => s.incidentLoading)
  const catalogLoading = useStore((s) => s.catalog.loading)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const isLive = (summary?.mode ?? mode) === 'live'
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`picker-btn ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-tip={open ? undefined : 'Choose an incident'}
      >
        {summary ? (
          isLive ? (
            <span className="chip chip-live live-chip">
              <i className="live-dot" />
              LIVE
            </span>
          ) : (
            <span className="chip chip-gold mono">{summary.year}</span>
          )
        ) : null}
        <span className="picker-name ellipsis">{summary?.name ?? (loading || catalogLoading ? 'Loading incidents…' : 'Select an incident')}</span>
        <ChevronDown size={14} className="picker-caret" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={600} className="picker-pop" label="Incident picker">
        <PickerBody initial={initialFilter(summary)} onPicked={() => setOpen(false)} />
      </Popover>
    </>
  )
}

function PickerBody({ initial, onPicked }: { initial: OverviewFilter; onPicked: () => void }) {
  const catalog = useStore((s) => s.catalog)
  const currentId = useStore((s) => s.incidentId)
  const liveStatus = useStore((s) => s.liveStatus)
  const [tab, setTab] = useState<OverviewFilter>(initial)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const now = useNow(30_000)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const rows = useMemo(() => {
    const list = overviewFires(catalog, tab)
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((s) => pickerMatches(s, q))
  }, [catalog, tab, query])

  // long lists render only the rows near the view (W11: 1,300 national rows)
  const win = useListWindow(rows.length, listRef, listRef, { padPx: LIST_PAD_PX, rowSelector: ':scope > [data-row]' })
  /** Move the cursor by the keyboard and keep its row in view (an unrendered row is scrolled in first). */
  const step = (d: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, cursor + d))
    setCursor(next)
    if (win.reveal(next)) listRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  /** A new tab or query starts at the top of its list. */
  const restart = () => {
    setCursor(0)
    listRef.current?.scrollTo({ top: 0 })
  }

  const pick = (s: IncidentSummary) => {
    onPicked()
    if (s.id === currentId) return
    // never a build because a fire was picked: an unprepared fire shows its card (map) or the Build button (Forensic)
    if (analysisState(s) !== 'ready' && useWorkspace.getState().workspace === 'map') showFireCard(s.id)
    else void useStore.getState().selectIncident(s.id, { autoBuild: useStore.getState().autoBuild, source: 'picker' })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      step(1)
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      step(-1)
      e.preventDefault()
    } else if (e.key === 'Enter' && rows[cursor]) {
      pick(rows[cursor])
      e.preventDefault()
    }
  }

  const checked = tab === 'active' ? catalog.updatedMs.live : tab === 'season' ? catalog.updatedMs.season : catalog.updatedMs.historical
  const minAcres = catalog.minAcres
  const counts: Record<OverviewFilter, number> = { active: catalog.live.length, season: overviewFires(catalog, 'season').length, past: catalog.historical.length }
  return (
    <div className="picker" onKeyDown={onKey}>
      <div className="picker-top">
        <Segmented
          value={tab}
          onChange={(v) => {
            setTab(v)
            restart()
          }}
          ariaLabel="Incident list"
          options={OVERVIEW_FILTERS.map((o) => ({
            value: o.value,
            tip: o.tip,
            label: (
              <>
                {o.value === 'active' && <i className="live-dot" />} {o.label} <span className="seg-count mono">{counts[o.value]}</span>
              </>
            ),
          }))}
        />
        <label className="search">
          <Search size={13} />
          <input
            ref={searchRef}
            type="search"
            placeholder={tab === 'active' ? 'Search active fires' : tab === 'season' ? `Search ${SEASON_YEAR} fires` : `Search ${PAST_YEAR} fires`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              restart()
            }}
            aria-label="Search incidents"
          />
        </label>
        {tab === 'past' && (
          <span className="picker-acres" data-tip={`Include ${PAST_YEAR} fires of 100–300 acres`}>
            <span className="label">≥ 100 ac</span>
            <Switch checked={minAcres <= 100} onChange={(v) => void useStore.getState().loadCatalog({ minAcres: v ? 100 : 300, modes: ['historical'] })} label="Include fires of at least 100 acres" />
          </span>
        )}
      </div>
      <div className="picker-head" aria-hidden>
        <span>Incident</span>
        <span className="r">Acres</span>
        <span>Contained</span>
        <span>Started</span>
        <span>Status</span>
        <span>Analysis</span>
      </div>
      <div className="picker-list" ref={listRef} role="listbox" aria-label="Incidents" data-size={rows.length}>
        {catalog.loading && rows.length === 0 && (
          <div className="picker-empty">
            <Spinner /> Loading the fire lists…
          </div>
        )}
        {!catalog.loading && rows.length === 0 && (
          <div className="picker-empty">
            {query ? (
              <>No incidents match “{query}”.</>
            ) : tab === 'active' ? (
              <>
                <strong>{emptyListText('active', minAcres)} That is not an all-clear: follow local officials.</strong>
                <button
                  type="button"
                  className="btn btn-sm btn-gold"
                  onClick={() => {
                    setTab('season')
                    restart()
                  }}
                >
                  Browse {SEASON_YEAR} fires
                </button>
              </>
            ) : tab === 'season' ? (
              <>{emptyListText('season', minAcres)} That is not an all-clear: follow local officials.</>
            ) : (
              <>{emptyListText('past', minAcres)}</>
            )}
          </div>
        )}
        {win.before > 0 && <div className="picker-spacer" aria-hidden="true" style={{ height: win.before }} />}
        {(win.windowed ? rows.slice(win.start, win.end) : rows).map((s, k) => {
          const i = win.start + k
          const st = statusChip(s)
          const b = bundleChip(s)
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === currentId}
              aria-setsize={rows.length}
              aria-posinset={i + 1}
              data-row={i}
              className={`picker-row ${i === cursor ? 'is-cursor' : ''} ${s.id === currentId ? 'is-current' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(s)}
            >
              <span className="pr-name">
                <span className="ellipsis pr-title">{s.name}</span>
                <span className="ellipsis pr-sub">
                  {pickerWhere(s)}
                  {s.mode === 'live' && s.detections_24h != null && <span className="pr-det mono"> · {fmtNumber(s.detections_24h)} det/24 h</span>}
                </span>
              </span>
              <span className="mono r">{fmtAcresShort(s.acres).replace(' ac', '')}</span>
              <ContainmentBar pct={s.percent_contained} />
              <span className="mono secondary">{fmtDayDate(s.started_ms, timeFmt(s.time_zone, '24h').tz)}</span>
              <span>
                <span className={`chip ${st.cls}`}>{st.label}</span>
              </span>
              <span data-tip={b.tip}>
                <span className={`chip ${b.cls}`}>
                  {s.bundle_status === 'building' ? <Spinner size={8} /> : s.bundle_status === 'ready' ? <i className="dot dot-ok" /> : null}
                  {b.label}
                </span>
              </span>
            </button>
          )
        })}
        {win.after > 0 && <div className="picker-spacer" aria-hidden="true" style={{ height: win.after }} />}
      </div>
      <div className="picker-foot">
        <span className="muted">
          {tab === 'active'
            ? 'Active fires (CAL FIRE, NIFC WFIGS)'
            : tab === 'season'
              ? `Active and ${SEASON_YEAR} fires ≥ ${SEASON_MIN_ACRES} ac (CAL FIRE, NIFC WFIGS)`
              : `${PAST_YEAR} fires ≥ ${minAcres} ac, by size (CAL FIRE, NIFC WFIGS)`}
          {checked ? <span className="mono"> · list checked {fmtRelative(checked, now)}</span> : null}
          {tab === 'active' && liveStatus?.next_refresh_ms ? <span className="mono"> · next refresh {fmtRelative(liveStatus.next_refresh_ms, now)}</span> : null}
        </span>
        {catalog.error && <span className="danger ellipsis" data-tip={catalog.error}>{catalog.error}</span>}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void useStore.getState().loadCatalog()}
          disabled={catalog.loading}
          data-tip="Reload both lists"
        >
          {catalog.loading ? <Spinner size={11} /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>
    </div>
  )
}
