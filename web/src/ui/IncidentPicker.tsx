// Incident picker (SPEC 9.4): Live / 2025 segmented control, search, >= 100 ac toggle (2025), and rows with name,
// acres, containment, start date, status chip and bundle status. Keyboard: arrows + Enter, Esc closes.
import { ChevronDown, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { IncidentSummary, Mode } from '../api/types'
import { fmtAcresShort, fmtNumber } from '../lib/format'
import { fmtDate, fmtRelative } from '../lib/time'
import { useStore } from '../state/store'
import { Popover, Segmented, Spinner, Switch } from './controls'
import { useNow } from './hooks'

function statusChip(s: IncidentSummary): { label: string; cls: string } {
  if (s.mode === 'live' && s.is_active) return { label: 'Active', cls: 'chip-live' }
  if ((s.percent_contained ?? 0) >= 100 || s.contained_ms != null) return { label: 'Contained', cls: 'chip-ok' }
  return { label: s.is_active ? 'Active' : 'Out', cls: 'chip-muted' }
}

function bundleChip(s: IncidentSummary): { label: string; cls: string; tip: string } {
  switch (s.bundle_status) {
    case 'ready':
      return { label: 'Ready', cls: 'chip-ok', tip: s.bundle_built_ms ? `Bundle built ${fmtRelative(s.bundle_built_ms)}` : 'Bundle ready' }
    case 'building':
      return { label: 'Building', cls: 'chip-gold', tip: 'Bundle is being built' }
    case 'error':
      return { label: 'Error', cls: 'chip-danger', tip: 'The last build failed; select to retry' }
    default:
      return { label: 'Build needed', cls: 'chip-muted', tip: 'Not built yet; selecting it starts a build (a few minutes)' }
  }
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
        <PickerBody initialMode={summary?.mode ?? mode} onPicked={() => setOpen(false)} />
      </Popover>
    </>
  )
}

function PickerBody({ initialMode, onPicked }: { initialMode: Mode; onPicked: () => void }) {
  const catalog = useStore((s) => s.catalog)
  const currentId = useStore((s) => s.incidentId)
  const liveStatus = useStore((s) => s.liveStatus)
  const [tab, setTab] = useState<Mode>(initialMode)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const now = useNow(30_000)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const rows = useMemo(() => {
    const list = tab === 'live' ? catalog.live : catalog.historical
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((s) => [s.name, s.county, s.location, s.admin_unit, s.id].some((v) => v?.toLowerCase().includes(q)))
  }, [catalog.live, catalog.historical, tab, query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const pick = (s: IncidentSummary) => {
    onPicked()
    if (s.id !== currentId) void useStore.getState().selectIncident(s.id, { autoBuild: true })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setCursor((c) => Math.min(rows.length - 1, c + 1))
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setCursor((c) => Math.max(0, c - 1))
      e.preventDefault()
    } else if (e.key === 'Enter' && rows[cursor]) {
      pick(rows[cursor])
      e.preventDefault()
    }
  }

  const updated = catalog.updatedMs[tab]
  const minAcres = catalog.minAcres
  return (
    <div className="picker" onKeyDown={onKey}>
      <div className="picker-top">
        <Segmented
          value={tab}
          onChange={(v) => {
            setTab(v)
            setCursor(0)
          }}
          ariaLabel="Incident list"
          options={[
            {
              value: 'live',
              label: (
                <>
                  <i className="live-dot" /> Live <span className="seg-count mono">{catalog.live.length}</span>
                </>
              ),
            },
            { value: 'historical', label: <>2025 <span className="seg-count mono">{catalog.historical.length}</span></> },
          ]}
        />
        <label className="search">
          <Search size={13} />
          <input
            ref={searchRef}
            type="search"
            placeholder={tab === 'live' ? 'Search active incidents' : 'Search 2025 incidents'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            aria-label="Search incidents"
          />
        </label>
        {tab === 'historical' && (
          <span className="picker-acres" data-tip="Include 2025 fires of 100–300 acres">
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
        <span>Bundle</span>
      </div>
      <div className="picker-list" ref={listRef} role="listbox" aria-label="Incidents">
        {catalog.loading && rows.length === 0 && (
          <div className="picker-empty">
            <Spinner /> Loading CAL FIRE incidents…
          </div>
        )}
        {!catalog.loading && rows.length === 0 && (
          <div className="picker-empty">
            {query ? (
              <>No incidents match “{query}”.</>
            ) : tab === 'live' ? (
              <>
                <strong>No active CAL FIRE incidents right now.</strong>
                <button
                  type="button"
                  className="btn btn-sm btn-gold"
                  onClick={() => {
                    setTab('historical')
                    setCursor(0)
                  }}
                >
                  Browse 2025 fires
                </button>
              </>
            ) : (
              <>No 2025 incidents ≥ {minAcres} acres in the catalog.</>
            )}
          </div>
        )}
        {rows.map((s, i) => {
          const st = statusChip(s)
          const b = bundleChip(s)
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === currentId}
              data-row={i}
              className={`picker-row ${i === cursor ? 'is-cursor' : ''} ${s.id === currentId ? 'is-current' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => pick(s)}
            >
              <span className="pr-name">
                <span className="ellipsis pr-title">{s.name}</span>
                <span className="ellipsis pr-sub">
                  {[s.county ? `${s.county} Co.` : null, s.location].filter(Boolean).join(' · ') || s.admin_unit || '—'}
                  {s.mode === 'live' && s.detections_24h != null && <span className="pr-det mono"> · {fmtNumber(s.detections_24h)} det/24 h</span>}
                </span>
              </span>
              <span className="mono r">{fmtAcresShort(s.acres).replace(' ac', '')}</span>
              <ContainmentBar pct={s.percent_contained} />
              <span className="mono secondary">{fmtDate(s.started_ms).replace(/, \d{4}$/, '')}</span>
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
      </div>
      <div className="picker-foot">
        <span className="muted">
          {tab === 'live' ? 'CAL FIRE active wildfires' : `CAL FIRE 2025 incidents ≥ ${minAcres} ac, by size`}
          {updated ? <span className="mono"> · updated {fmtRelative(updated, now)}</span> : null}
          {tab === 'live' && liveStatus?.next_refresh_ms ? <span className="mono"> · next refresh {fmtRelative(liveStatus.next_refresh_ms, now)}</span> : null}
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
