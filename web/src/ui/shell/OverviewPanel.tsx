// National overview list (owner: us-web; brief 2 O-R3, CONTRACT §13 shell; brief 3 §14.11): the right column on
// desktop and a peek sheet on phones ("244 active fires · newest record 5 min old"). Filters: Active / 2026 season /
// 2025 (state/overview.ts overviewFires, the same set the map's overview markers draw). The list shows the fires in the
// map view ("312 fires in this view · Show all 1,334"; round 2 default), with each row's county and state. Every value is
// an agency's official record (CAL FIRE in California, NIFC WFIGS elsewhere); the list-absence line of §14.14 says a
// place with no marker is not an all-clear. Picking a row opens the fire card and flies the map there. The panel uses
// the updates slot and its open flag (panels.updates): there are no incident updates without a fire.
// Brief 4 (H3, Main.dc.html "Fires in the lower 48"): restyled (styles/overview.css); in Public a row opens the fire
// view (decision b, fireActions.pickFire) and the panel's close button hides the overview's details (decision d); on
// Public phones the "Show details" pill replaces the peek bar.
import { ChevronDown, ChevronRight, ChevronUp, Flame, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentSummary } from '../../api/types'
import { fmtAcresShort, fmtNumber } from '../../lib/format'
import { fmtRelative } from '../../lib/time'
import { useMapRuntime } from '../../map/mapStore'
import {
  ALL_LISTS_DOWN_SHORT,
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
  listCheckedText,
  listHealth,
  newestRecordMs,
  newestRecordText,
  OVERVIEW_FILTERS,
  overviewCounts,
  type ListHealth,
} from '../../state/overview'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { Segmented, Spinner } from '../controls'
import { OfficialNow } from '../feed/OfficialNow'
import { useNow } from '../hooks'
import { useListWindow } from '../useListWindow'
import { pickFire } from './fireActions'
import { LIST_OF, useOverviewData } from './useOverviewData'
import { NARROW_QUERY, useDrawerFocus, useMediaQuery } from './hooks'

/** The overview panel's title and its collapsed button (brief 3: the lower 48). */
export const OVERVIEW_TITLE = 'Fires in the lower 48'

/** The fires of the list in the map view (the whole list with "Show all", or when no map is shown). Memoised on the
 *  rows and the view. */
function useInView(rows: IncidentSummary[]) {
  const viewBox = useMapRuntime((s) => s.viewBox)
  const showAll = useWorkspace((s) => s.overviewShowAll)
  const inView = useMemo(() => (viewBox ? firesInView(rows, viewBox) : rows), [rows, viewBox])
  return { shown: showAll || !viewBox ? rows : inView, inViewCount: inView.length, hasView: viewBox != null, showAll }
}

function FireRow({ fire, index, size, cursor, current, onPick }: { fire: IncidentSummary; index: number; size: number; cursor: boolean; current: boolean; onPick: (f: IncidentSummary) => void }) {
  const units = useWorkspace((s) => s.units)
  const status = fireStatus(fire)
  const ready = analysisState(fire) === 'ready'
  const where = fireWhere(fire)
  const contained = fire.percent_contained != null && status.key === 'active' ? `${fmtNumber(fire.percent_contained)}% contained` : null
  return (
    // the row's place in the whole list: a windowed list renders only some rows (W11)
    <li aria-setsize={size} aria-posinset={index + 1}>
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
          <span className="ov-acres mw-mono">{fmtAcresShort(fire.acres, units)}</span>
          {ready && <span className="ov-ready">Analysis ready</span>}
        </span>
      </button>
    </li>
  )
}

/** The list's own top and bottom padding (styles/overview.css .ov-list). */
const LIST_PAD_PX = 4

/** The fire rows. Above LIST_WINDOW_MIN rows only the rows near the visible part of the scroller (.ov-body) are
 *  rendered (ui/useListWindow.ts), so 1,300 national rows stay fast (W11). Arrow keys, Home and End move a roving
 *  focus over the whole list, scrolling an unrendered row in first; every row carries its place in the whole list
 *  (aria-posinset / aria-setsize). */
function FireList({ rows, onPick }: { rows: IncidentSummary[]; onPick: (f: IncidentSummary) => void }) {
  const cardId = useWorkspace((s) => s.fireCardId)
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLUListElement | null>(null)
  const scroller = useRef<HTMLElement | null>(null)
  /** A row to focus once it is rendered (a keyboard jump to a row outside the window). */
  const focusRow = useRef<number | null>(null)
  const n = rows.length
  const c = Math.min(cursor, Math.max(0, n - 1))
  // focus on a row that leaves the window moves to the list itself (the arrow keys still work from there)
  const onWindow = useCallback((start: number, end: number) => {
    const ul = ref.current
    const active = document.activeElement as HTMLElement | null
    const i = ul && active && ul.contains(active) ? Number(active.dataset.row) : NaN
    if (ul && Number.isInteger(i) && (i < start || i >= end)) ul.focus({ preventScroll: true })
  }, [])
  const win = useListWindow(n, scroller, ref, { padPx: LIST_PAD_PX, rowSelector: ':scope > li', onWindow })

  // the scroller is the list's parent (.ov-body)
  useLayoutEffect(() => {
    scroller.current = ref.current?.parentElement ?? null
  }, [])

  // a row asked for by the keyboard is focused as soon as it is rendered
  useLayoutEffect(() => {
    const i = focusRow.current
    if (i == null) return
    const el = ref.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)
    if (el) {
      focusRow.current = null
      el.focus()
    }
  })

  const move = (i: number) => {
    const next = Math.max(0, Math.min(n - 1, i))
    setCursor(next)
    if (!win.reveal(next)) {
      focusRow.current = next
      return
    }
    ref.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') move(c + 1)
    else if (e.key === 'ArrowUp') move(c - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(n - 1)
    else return
    e.preventDefault()
  }
  const shown = win.windowed ? rows.slice(win.start, win.end) : rows
  return (
    <ul
      className={`ov-list${win.windowed ? ' is-windowed' : ''}`}
      ref={ref}
      aria-label="Fires"
      data-size={n}
      // windowed: the list itself holds focus when the focused row scrolls out of the window
      tabIndex={win.windowed ? -1 : undefined}
      style={win.style}
      onKeyDown={onKey}
      onFocus={(e) => {
        const i = Number((e.target as HTMLElement).dataset.row)
        if (Number.isInteger(i) && i !== c) setCursor(i)
      }}
    >
      {shown.map((f, k) => {
        const i = win.start + k
        return <FireRow key={f.id} fire={f} index={i} size={n} cursor={i === c} current={f.id === cardId} onPick={onPick} />
      })}
    </ul>
  )
}

/** One line under the filter: where the list comes from and how fresh it is (relative: the rows span many zones). When
 *  both lists are down the rows are prepared fires' saved records, not the agencies' lists (§14.16). A list served from
 *  an older copy is "fetched" at that copy's time, never "checked just now" (panel F2). */
function SourceLine({
  rows,
  checkedMs,
  checkedNewestMs,
  listCount,
  loading,
  nowMs,
  past,
  health,
}: {
  rows: IncidentSummary[]
  checkedMs: number | null
  checkedNewestMs: number | null
  listCount: number
  loading: boolean
  nowMs: number
  past: boolean
  health: ListHealth
}) {
  const newest = newestRecordMs(rows)
  return (
    <p className="ov-source">
      <span className="mw-tag is-official">Official</span>
      <span>
        {health.allDown ? (
          <>Fire lists unavailable · prepared fires&apos; saved records</>
        ) : (
          <>
            {past ? 'Final records' : 'Records'}: CAL FIRE (California), NIFC WFIGS
            {/* the newest agency time inside the list as an age, then when Fire-3d fetched the lists (final fixes R7) */}
            {newest != null && <> · {newestRecordText(newest, nowMs)}</>}
            {checkedMs != null && <> · {listCheckedText(checkedMs, checkedNewestMs, nowMs, { lists: listCount, stale: health.stale.size > 0 })}</>}
          </>
        )}
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
  const { live, loading, error, liveLoaded, sources } = useStore(
    useShallow((s) => ({ live: s.catalog.live, loading: s.catalog.listLoading.live, error: s.catalog.listErrors.live, liveLoaded: s.catalog.updatedMs.live != null, sources: s.catalog.sources?.live ?? null })),
  )
  const nowMs = useNow(30_000)
  const newest = newestRecordMs(live)
  const health = listHealth([sources])
  const open = () => useWorkspace.getState().setPanel('updates', true)
  const n = live.length
  const count = (
    <b>
      {n.toLocaleString('en-US')} active fire{n === 1 ? '' : 's'}
    </b>
  )
  const staleMs = health.stale.size ? Math.min(...[...health.stale.values()].map((t) => t ?? nowMs)) : null
  let text: ReactNode
  if (!liveLoaded && loading) text = 'Loading the active fires…'
  else if (!liveLoaded && error) text = 'Could not load the fire list · open to retry'
  // both lists down: never "no active fires" (the agencies could not be asked; §14.16)
  else if (health.allDown) text = n ? `${ALL_LISTS_DOWN_SHORT} · ${n.toLocaleString('en-US')} prepared fire${n === 1 ? '' : 's'}` : ALL_LISTS_DOWN_SHORT
  else if (n === 0 && health.down.size) text = 'Some fire lists are unavailable right now · open for details'
  else if (n === 0) text = 'No active fires listed by CAL FIRE or NIFC'
  else if (staleMs != null)
    text = (
      <>
        {/* short enough for a phone's one line: the qualifier must not be cut off */}
        {count} · not refreshed ({fmtRelative(staleMs, nowMs)})
      </>
    )
  else
    text = (
      <>
        {count}
        {newest != null ? ` · ${newestRecordText(newest, nowMs)}` : ''}
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
  const { catalog, filter, rows, loading, error, checkedMs, checkedNewestMs, listCount, notices, health, errorLines, nowMs } = useOverviewData()
  const { shown, inViewCount, hasView, showAll } = useInView(rows)
  // the 2025 list is large: load it on demand when it failed or was never loaded
  useEffect(() => {
    if (filter === 'past' && catalog.updatedMs.historical == null && !catalog.listLoading.historical && !catalog.listErrors.historical) void useStore.getState().loadCatalog({ lists: ['historical'] })
  }, [filter, catalog.updatedMs.historical, catalog.listLoading.historical, catalog.listErrors.historical])
  const { live, season, historical } = catalog
  const counts = useMemo(() => overviewCounts({ live, season, historical }), [live, season, historical])
  // an empty view or filter carries the list-absence line itself: the footer would repeat it right below
  const emptyShown = shown.length === 0 && (rows.length > 0 || (!loading && !error))
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
      <SourceLine
        rows={rows}
        checkedMs={checkedMs}
        checkedNewestMs={checkedNewestMs}
        listCount={listCount}
        loading={loading}
        nowMs={nowMs}
        past={filter === 'past' && !rows.some((r) => isActiveFire(r))}
        health={health}
      />
      {notices.map((n) => (
        <p key={n} className="ov-warn" role="status">
          {n}
        </p>
      ))}
      {error &&
        rows.length > 0 &&
        errorLines.map((t) => (
          <p key={t} className="ov-warn" role="status">
            {t}
          </p>
        ))}
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
            <p>{emptyListText(filter, catalog.minAcres, health)}</p>
            <p className="ov-absence">{LIST_ABSENCE}</p>
          </div>
        )}
      </div>
      {!emptyShown && (
        <footer className="ov-foot">
          <p className="ov-absence">{LIST_ABSENCE}</p>
        </footer>
      )}
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

/** `closeHidesDetails` (Public, wide screens): the head's button is "Hide details" (the list is part of the overview's
 *  details). `sheetPeek` (phones): the closed sheet shows the peek bar (Command); Public's "Show details" pill opens it
 *  instead. */
export function OverviewPanel({ closeHidesDetails = false, sheetPeek = true }: { closeHidesDetails?: boolean; sheetPeek?: boolean } = {}) {
  const open = useWorkspace((s) => s.panels.updates)
  const setPanel = useWorkspace((s) => s.setPanel)
  const narrow = useMediaQuery(NARROW_QUERY)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'updates')
  useFocusHandOff()
  if (!open) {
    if (narrow) return sheetPeek ? <PeekBar /> : null
    return (
      <button type="button" className="mw-btn mw-updates-open" data-panel-toggle="updates" aria-expanded={false} onClick={() => setPanel('updates', true)}>
        <Flame size={14} /> {OVERVIEW_TITLE}
      </button>
    )
  }
  const pick = (f: IncidentSummary) => {
    pickFire(f.id)
    if (narrow) setPanel('updates', false) // phones: show the map and the card
  }
  return (
    <section className="mw-updates-panel ov-panel" aria-labelledby="ov-title" data-drawer="updates">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className="mw-panel-head">
        <h2 id="ov-title" ref={heading} tabIndex={-1} data-tip="Lower 48 states; Alaska and Hawaii are not supported yet">
          {OVERVIEW_TITLE}
        </h2>
        {closeHidesDetails ? (
          <button
            type="button"
            className="mw-icon-btn ov-close"
            aria-label="Hide details"
            data-tip="Hide details (the fire list, map controls, readout, scale and legend)"
            onClick={() => useWorkspace.getState().setOverviewDetails(false)}
          >
            <X size={16} />
          </button>
        ) : (
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
        )}
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
