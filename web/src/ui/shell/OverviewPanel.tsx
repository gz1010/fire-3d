// National overview list (owner: us-web; brief 2 O-R3, CONTRACT §13 shell; brief 3 §14.11): the right column on
// desktop and a peek sheet on phones ("244 active fires · records updated 5 min ago"). Filters: Active / 2026 season /
// 2025 (state/overview.ts overviewFires, the same set the map's overview markers draw). The list shows the fires in the
// map view ("312 fires in this view · Show all 1,334"; round 2 default), with each row's county and state. Every value is
// an agency's official record (CAL FIRE in California, NIFC WFIGS elsewhere); the list-absence line of §14.14 says a
// place with no marker is not an all-clear. Picking a row opens the fire card and flies the map there. The panel uses
// the updates slot and its open flag (panels.updates): there are no incident updates without a fire.
import { ChevronDown, ChevronRight, ChevronUp, Flame, RefreshCw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentSummary } from '../../api/types'
import { fmtAcresShort, fmtNumber } from '../../lib/format'
import { fmtRelative } from '../../lib/time'
import { useMapRuntime } from '../../map/mapStore'
import {
  analysisState,
  EMPTY_VIEW,
  emptyListText,
  fireStatus,
  firesInView,
  fireWhere,
  inViewLabel,
  isActiveFire,
  LIST_ABSENCE,
  LIST_ABSENCE_SHORT,
  listSourceNotices,
  newestRecordMs,
  OVERVIEW_FILTERS,
  overviewCounts,
  overviewFires,
  type OverviewFilter,
} from '../../state/overview'
import { useStore, type CatalogList } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { Segmented, Spinner } from '../controls'
import { OfficialNow } from '../feed/OfficialNow'
import { useNow } from '../hooks'
import { showFireCard } from './fireActions'
import { NARROW_QUERY, useDrawerFocus, useMediaQuery } from './hooks'

const LIST_OF: Record<OverviewFilter, CatalogList[]> = { active: ['live'], season: ['live', 'season'], past: ['historical'] }
/** The overview panel's title and its collapsed button (brief 3: the lower 48). */
export const OVERVIEW_TITLE = 'Fires in the lower 48'

function useOverviewData() {
  const catalog = useStore((s) => s.catalog)
  const filter = useWorkspace((s) => s.overviewFilter)
  const rows = useMemo(() => overviewFires(catalog, filter), [catalog, filter])
  const lists = LIST_OF[filter]
  const loading = lists.some((l) => catalog.listLoading[l])
  const errors = lists.map((l) => catalog.listErrors[l]).filter((e): e is string => e != null)
  const checked = lists.map((l) => catalog.updatedMs[l]).filter((t): t is number => t != null)
  const notices = listSourceNotices(lists.map((l) => catalog.sources?.[l]))
  return { catalog, filter, rows, loading, notices, error: errors.length ? [...new Set(errors)].join('; ') : null, checkedMs: checked.length ? Math.min(...checked) : null }
}

/** The fires of the list in the map view (the whole list with "Show all", or when no map is shown). Memoised on the
 *  rows and the view. */
function useInView(rows: IncidentSummary[]) {
  const viewBox = useMapRuntime((s) => s.viewBox)
  const showAll = useWorkspace((s) => s.overviewShowAll)
  const inView = useMemo(() => (viewBox ? firesInView(rows, viewBox) : rows), [rows, viewBox])
  return { shown: showAll || !viewBox ? rows : inView, inViewCount: inView.length, hasView: viewBox != null, showAll }
}

function FireRow({ fire, index, cursor, current, onPick }: { fire: IncidentSummary; index: number; cursor: boolean; current: boolean; onPick: (f: IncidentSummary) => void }) {
  const status = fireStatus(fire)
  const ready = analysisState(fire) === 'ready'
  const where = fireWhere(fire)
  const contained = fire.percent_contained != null && status.key === 'active' ? `${fmtNumber(fire.percent_contained)}% contained` : null
  return (
    <li>
      <button
        type="button"
        className={`ov-row${current ? ' is-current' : ''}`}
        data-row={index}
        tabIndex={cursor ? 0 : -1}
        aria-current={current ? 'true' : undefined}
        onClick={() => onPick(fire)}
      >
        <span className={`ov-dot is-${status.key}`} aria-hidden="true" />
        <span className="ov-main">
          <span className="ov-name">{fire.name}</span>
          <span className="ov-sub">{[where, status.label, contained].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="ov-side">
          <span className="ov-acres mw-mono">{fmtAcresShort(fire.acres)}</span>
          {ready && <span className="ov-ready">Analysis ready</span>}
        </span>
      </button>
    </li>
  )
}

function FireList({ rows, onPick }: { rows: IncidentSummary[]; onPick: (f: IncidentSummary) => void }) {
  const cardId = useWorkspace((s) => s.fireCardId)
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLUListElement | null>(null)
  const c = Math.min(cursor, Math.max(0, rows.length - 1))
  const move = (i: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, i))
    setCursor(next)
    ref.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') move(c + 1)
    else if (e.key === 'ArrowUp') move(c - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(rows.length - 1)
    else return
    e.preventDefault()
  }
  return (
    <ul className="ov-list" ref={ref} aria-label="Fires" onKeyDown={onKey} onFocus={(e) => {
      const i = Number((e.target as HTMLElement).dataset.row)
      if (Number.isInteger(i) && i !== c) setCursor(i)
    }}>
      {rows.map((f, i) => (
        <FireRow key={f.id} fire={f} index={i} cursor={i === c} current={f.id === cardId} onPick={onPick} />
      ))}
    </ul>
  )
}

/** One line under the filter: where the list comes from and how fresh it is (relative: the rows span many zones). */
function SourceLine({ rows, checkedMs, loading, nowMs, past }: { rows: IncidentSummary[]; checkedMs: number | null; loading: boolean; nowMs: number; past: boolean }) {
  const newest = newestRecordMs(rows)
  return (
    <p className="ov-source">
      <span className="mw-tag is-official">Official</span>
      <span>
        {past ? 'Final records' : 'Records'}: CAL FIRE (California), NIFC WFIGS
        {newest != null && <> · updated {fmtRelative(newest, nowMs)}</>}
        {checkedMs != null && <> · checked {fmtRelative(checkedMs, nowMs)}</>}
      </span>
      <button
        type="button"
        className="mw-icon-btn is-sm ov-refresh"
        aria-label="Reload the fire lists"
        data-tip="Reload the fire lists (CAL FIRE and NIFC)"
        disabled={loading}
        onClick={() => void useStore.getState().loadCatalog()}
      >
        {loading ? <Spinner size={11} /> : <RefreshCw size={12} />}
      </button>
    </p>
  )
}

/** "312 fires in this view · Show all 1,334" (or the way back), above the list (§14.11). */
function ViewLine({ total, inViewCount, showAll }: { total: number; inViewCount: number; showAll: boolean }) {
  const set = useWorkspace((s) => s.setOverviewShowAll)
  const t = inViewLabel(inViewCount, total)
  return (
    <p className="ov-viewline" aria-live="polite">
      {showAll ? (
        <>
          <span>All {total.toLocaleString('en-US')} listed fires</span> ·{' '}
          <button type="button" className="mw-link-btn" onClick={() => set(false)}>
            Show the fires in this view
          </button>
        </>
      ) : (
        <>
          <span>{t.inView}</span>
          {total > inViewCount && (
            <>
              {' · '}
              <button type="button" className="mw-link-btn" onClick={() => set(true)}>
                {t.all}
              </button>
            </>
          )}
        </>
      )}
    </p>
  )
}

/** Phones, sheet closed: one line above the coordinates, and the short list-absence line. */
export function PeekBar() {
  const { live, loading, error, liveLoaded } = useStore(
    useShallow((s) => ({ live: s.catalog.live, loading: s.catalog.listLoading.live, error: s.catalog.listErrors.live, liveLoaded: s.catalog.updatedMs.live != null })),
  )
  const nowMs = useNow(30_000)
  const newest = newestRecordMs(live)
  const open = () => useWorkspace.getState().setPanel('updates', true)
  let text: ReactNode
  if (!liveLoaded && loading) text = 'Loading the active fires…'
  else if (!liveLoaded && error) text = 'Could not load the fire list · open to retry'
  else if (live.length === 0) text = 'No active fires listed by CAL FIRE or NIFC'
  else
    text = (
      <>
        <b>
          {live.length.toLocaleString('en-US')} active fire{live.length === 1 ? '' : 's'}
        </b>
        {newest != null ? ` · records updated ${fmtRelative(newest, nowMs)}` : ''}
      </>
    )
  return (
    <button type="button" className="ov-peek" data-panel-toggle="updates" aria-expanded={false} onClick={open}>
      <Flame size={14} className="ov-peek-icon" aria-hidden="true" />
      <span className="ov-peek-lines">
        <span className="ov-peek-text">{text}</span>
        <span className="ov-peek-absence" title={LIST_ABSENCE}>
          {LIST_ABSENCE_SHORT}
        </span>
      </span>
      {loading && <Spinner size={11} />}
      <ChevronUp size={15} aria-hidden="true" />
    </button>
  )
}

/** Filter, source line, list and its loading / error / empty states (the overview panel and Forensic's "Open a fire
 *  first" screen). */
export function OverviewList({ onPick }: { onPick: (f: IncidentSummary) => void }) {
  const { catalog, filter, rows, loading, error, checkedMs, notices } = useOverviewData()
  const { shown, inViewCount, hasView, showAll } = useInView(rows)
  const nowMs = useNow(30_000)
  // the 2025 list is large: load it on demand when it failed or was never loaded
  useEffect(() => {
    if (filter === 'past' && catalog.updatedMs.historical == null && !catalog.listLoading.historical && !catalog.listErrors.historical) void useStore.getState().loadCatalog({ lists: ['historical'] })
  }, [filter, catalog.updatedMs.historical, catalog.listLoading.historical, catalog.listErrors.historical])
  const { live, season, historical } = catalog
  const counts = useMemo(() => overviewCounts({ live, season, historical }), [live, season, historical])
  return (
    <>
      <div className="ov-filters">
        <Segmented
          value={filter}
          onChange={(v) => useWorkspace.getState().setOverviewFilter(v)}
          ariaLabel="Which fires"
          size="sm"
          className="mw-seg-fill"
          options={OVERVIEW_FILTERS.map((o) => ({
            value: o.value,
            tip: o.tip,
            label: (
              <>
                {o.label} {counts[o.value] > 0 && <span className="seg-count mono">{counts[o.value].toLocaleString('en-US')}</span>}
              </>
            ),
          }))}
        />
      </div>
      <SourceLine rows={rows} checkedMs={checkedMs} loading={loading} nowMs={nowMs} past={filter === 'past' && !rows.some((r) => isActiveFire(r))} />
      {notices.map((n) => (
        <p key={n} className="ov-warn" role="status">
          {n}
        </p>
      ))}
      {error && rows.length > 0 && (
        <p className="ov-warn" role="status">
          Could not refresh: {error}. Showing the last list.
        </p>
      )}
      {hasView && rows.length > 0 && <ViewLine total={rows.length} inViewCount={inViewCount} showAll={showAll} />}
      <div className="ov-body">
        {shown.length > 0 ? (
          <FireList rows={shown} onPick={onPick} />
        ) : rows.length > 0 ? (
          <div className="ov-state is-empty">
            <p>{EMPTY_VIEW}</p>
            <p className="ov-absence">{LIST_ABSENCE}</p>
          </div>
        ) : loading ? (
          <p className="ov-state">
            <Spinner size={12} /> Loading the fire lists…
          </p>
        ) : error ? (
          <div className="ov-state is-error" role="alert">
            <p>Could not load the fire list: {error}</p>
            <button type="button" className="mw-btn is-sm" onClick={() => void useStore.getState().loadCatalog({ lists: LIST_OF[filter] })}>
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        ) : (
          <div className="ov-state is-empty">
            <p>{emptyListText(filter, catalog.minAcres)}</p>
            <p className="ov-absence">{LIST_ABSENCE}</p>
          </div>
        )}
      </div>
      <footer className="ov-foot">
        <p className="ov-absence">{LIST_ABSENCE}</p>
      </footer>
    </>
  )
}

/** The overview gives way to a fire (opened, or focused by zoom) while focus is in its list: hand focus to the fire's
 *  updates panel heading (else the map), never to the page body. */
function useFocusHandOff() {
  useLayoutEffect(
    () => () => {
      const slot = document.getElementById('mw-updates')
      if (!slot || !slot.contains(document.activeElement)) return
      requestAnimationFrame(() => {
        const a = document.activeElement
        if (a && a !== document.body) return
        document.querySelector<HTMLElement>('#mw-updates h2[tabindex], .mw-map canvas')?.focus({ preventScroll: true })
      })
    },
    [],
  )
}

export function OverviewPanel() {
  const open = useWorkspace((s) => s.panels.updates)
  const setPanel = useWorkspace((s) => s.setPanel)
  const narrow = useMediaQuery(NARROW_QUERY)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'updates')
  useFocusHandOff()
  if (!open) {
    if (narrow) return <PeekBar />
    return (
      <button type="button" className="mw-btn mw-updates-open" data-panel-toggle="updates" aria-expanded={false} onClick={() => setPanel('updates', true)}>
        <Flame size={14} /> {OVERVIEW_TITLE}
      </button>
    )
  }
  const pick = (f: IncidentSummary) => {
    showFireCard(f.id)
    if (narrow) setPanel('updates', false) // phones: show the map and the card
  }
  return (
    <section className="mw-updates-panel ov-panel" aria-labelledby="ov-title" data-drawer="updates">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className="mw-panel-head">
        <h2 id="ov-title" ref={heading} tabIndex={-1} data-tip="Lower 48 states; Alaska and Hawaii are not supported yet">
          {OVERVIEW_TITLE}
        </h2>
        <button
          type="button"
          className="mw-icon-btn"
          aria-label={narrow ? 'Close the fire list' : 'Collapse the fire list'}
          data-tip={narrow ? undefined : 'Collapse'}
          aria-expanded={true}
          onClick={() => setPanel('updates', false)}
        >
          {narrow ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </header>
      {/* official information for the overview (us-official): NWS fire weather alerts and a pointer to a fire's details */}
      <div className="mw-official-slot ov-official">
        <OfficialNow />
      </div>
      <OverviewList onPick={pick} />
    </section>
  )
}

/** Overview notice: the link named a fire Fire-3d cannot find (useStore.missingIncidentId). */
export function MissingFireNotice() {
  const id = useStore((s) => s.missingIncidentId)
  if (!id) return null
  return (
    <div className="banner banner-info mw-missing" role="status">
      <span className="banner-text">
        Fire-3d could not find the fire in this link (<span className="mw-mono">{id}</span>). CAL FIRE or NIFC may no longer list it, or the link is wrong.
        Showing all listed fires.
      </span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => useStore.getState().setMissingIncidentId(null)}>
        <X size={13} />
      </button>
    </div>
  )
}
