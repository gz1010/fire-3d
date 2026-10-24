// Collapsible right-side updates panel (owner: shell, CONTRACT §3; BRIEF §6, §10; brief 2 U-R3, U-R4, U-R9). The feed
// itself (<UpdatesFeed/>) arrives as `children`. Top to bottom: official-web's "Official now" block (evacuations,
// CAL FIRE status, NWS fire weather; never merged with model output), how current the data is (Command: the full
// "Data status" with every source's time; Public: one line, details on demand), then the feed, all in one scroll area.
// Desktop Public opens compact (map first, >= 75 % open map): three one-line official statuses (officialSummary.ts),
// the freshness line and "Official details and all updates", which expands the panel to the full block and the feed.
// Command and the expanded panel show the full block. Phones: a bottom sheet opened from the header's labelled
// "Updates" button, always the full block.
// Brief 4, Command on wider screens (CommandView.dc.html; PLAN-4 §3.2): no panel, the right column floats on the map's
// right edge gradient: "Official now" as one-line rows that expand (OfficialNow variant "command"), its foot, and "View
// all updates", which opens the column into a glass panel with the same rows, the data status (every source's time)
// and the updates feed, scrollable. Phones keep the Updates sheet (with Command's rows).
import { ChevronDown, ChevronRight, ChevronUp, Clock, Flag, ListChecks, Megaphone, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOfficialNow } from '../../official/hooks'
import { useStore } from '../../state/store'
import { zoneLine } from '../../lib/time'
import { useTimeFormat, useZoneSource } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { OfficialNow } from '../feed/OfficialNow'
import { useNow } from '../hooks'
import { buildDataStatus, freshnessLine, type StatusRow } from './dataStatus'
import { NARROW_QUERY, useDrawerFocus, useMediaQuery } from './hooks'
import { officialSummary, SUMMARY_NOT_AN_ORDER, type SummaryLine } from './officialSummary'

function useStatusRows() {
  const inp = useStore(
    useShallow((s) => ({
      summary: s.summary,
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      perimeters: s.perimeters,
      detections: s.detections,
      forecast: s.forecast,
      weather: s.weather,
    })),
  )
  const official = useOfficialNow()
  const nowMs = useNow(30_000)
  // the fire's zone and the preset's clock (CONTRACT §14.9): a Montana fire's rows read MDT, never PDT
  const tf = useTimeFormat()
  const rows = useMemo(() => buildDataStatus({ ...inp, official, tf }, nowMs), [inp, official, nowMs, tf])
  const checks = [official.evacuation.checkedMs, official.fireWeather.checkedMs, official.calfire.checkedMs].filter((t): t is number => t != null && Number.isFinite(t))
  return { manifest: inp.manifest, rows, nowMs, checkedMs: checks.length ? Math.max(...checks) : null, tf }
}

/** The time an open fire's panel is for: now for a live fire, else the replay time (to the minute). */
function usePanelTime(nowMs: number): number {
  const replayMinute = useStore((s) => {
    const live = (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)) === 'live'
    return live || s.incidentId == null ? null : Math.floor(s.timeMs / 60_000)
  })
  return replayMinute == null ? nowMs : replayMinute * 60_000
}

/** "Times: Mountain Time (MDT), the fire's local time" (CONTRACT §14.9.1): which zone the rows are in. A replay names
 *  the abbreviation at the replay time first, and today's too when it differs ("Pacific Time (PST/PDT)": a January
 *  replay's rows read PST, the checks read today's PDT; integration review UX-m4). */
function ZoneNote({ nowMs }: { nowMs: number }) {
  const tf = useTimeFormat()
  const whose = useZoneSource()
  const refMs = usePanelTime(nowMs)
  return <p className="mw-set-note mw-status-zone">{zoneLine(tf, refMs, whose, nowMs)}</p>
}

function StatusRows({ rows }: { rows: StatusRow[] }) {
  return (
    <dl className="mw-status-rows">
      {rows.map((r) => (
        <div key={r.key} className={`mw-status-row ${r.stale ? 'is-stale' : ''} ${r.tMs == null ? 'is-missing' : ''}`}>
          <dt>{r.label}</dt>
          <dd>
            <span className="mw-mono mw-status-time">{r.value}</span>
            {r.age && <span className="mw-status-age">{r.age}</span>}
            {r.stale && <span className="mw-chip mw-chip-stale">Stale</span>}
            {r.detail && (
              <span className="mw-status-detail" data-tip={r.tip ?? r.detail}>
                {r.detail}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Command: every source's newest time, open by default. */
function DataStatus() {
  const { manifest, rows, nowMs } = useStatusRows()
  const [open, setOpen] = useState(true)
  if (!manifest) return null
  return (
    <section className="mw-status" aria-label="Data status">
      <button type="button" className="mw-status-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mw-eyebrow">Data status</span>
        <span className="mw-status-mode">{manifest.mode === 'live' ? 'Live data' : 'Archived replay'}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <>
          <StatusRows rows={rows} />
          <ZoneNote nowMs={nowMs} />
        </>
      )}
    </section>
  )
}

/** Public: one freshness line ("Sources checked 2 min ago · satellite data 16 h old"), the same rows on demand. The
 *  compact panel shows the line in its summary list; the expanded panel shows it here with the rows. */
function Freshness({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const { manifest, rows, nowMs, checkedMs, tf } = useStatusRows()
  const [open, setOpen] = useState(defaultOpen)
  if (!manifest) return null
  const line = freshnessLine(rows, manifest.mode === 'live', nowMs, checkedMs, tf)
  return (
    <section className="mw-status is-public" aria-label="How current the data is">
      <button type="button" className="mw-status-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`mw-fresh-line${line.stale ? ' is-stale' : ''}`}>{line.text}</span>
        {line.stale && <span className="mw-chip mw-chip-stale">Stale</span>}
        <span className="mw-fresh-more">{open ? 'Hide' : 'Sources'}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <>
          <StatusRows rows={rows} />
          <ZoneNote nowMs={nowMs} />
        </>
      )}
    </section>
  )
}

const SUMMARY_ICON: Record<SummaryLine['key'], ReactNode> = {
  evacuation: <TriangleAlert size={14} />,
  local: <Megaphone size={14} />,
  calfire: <ShieldAlert size={14} />,
  'fire-weather': <Flag size={14} />,
}

/** Desktop Public, compact panel (titled "Official now"): the three official statuses, short, then how current the
 *  data is in one line (the rows are in the expanded panel). */
function OfficialSummary() {
  const info = useOfficialNow()
  const metric = useWorkspace((s) => s.units === 'metric')
  const hasIncident = useStore((s) => s.incidentId != null)
  const { manifest, rows, nowMs, checkedMs, tf } = useStatusRows()
  const refMs = usePanelTime(nowMs)
  const lines = useMemo(() => officialSummary(info, nowMs, metric, tf, refMs), [info, nowMs, metric, tf, refMs])
  if (!hasIncident) return null
  const fresh = manifest ? freshnessLine(rows, manifest.mode === 'live', nowMs, checkedMs, tf) : null
  return (
    <div className="os">
      <ul className="os-rows">
        {lines.map((l) => (
          <li key={l.key} className={`os-row is-${l.tone}`}>
            <span className="os-icon" aria-hidden="true">
              {SUMMARY_ICON[l.key]}
            </span>
            <span className="os-text">
              <span className="os-label">{l.label}</span> {l.text}
              {l.source && <span className="os-src"> ({l.source})</span>}
              {l.link && (
                <>
                  {' · '}
                  <a className="os-link" href={l.link.url} target="_blank" rel="noreferrer noopener">
                    {l.link.label}
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
        {fresh && (
          <li className={`os-row is-fresh${fresh.stale ? ' is-stale' : ''}`}>
            <span className="os-icon" aria-hidden="true">
              <Clock size={14} />
            </span>
            <span className="os-text">
              <span className="os-label">Data</span> {fresh.text}
              {fresh.stale && <span className="mw-chip mw-chip-stale os-stale">Stale</span>}
            </span>
          </li>
        )}
      </ul>
      <p className="os-foot">{SUMMARY_NOT_AN_ORDER}</p>
    </div>
  )
}

/** Whether the element `selector` inside `root` scrolls with more below its visible part (Command's column: its rows'
 *  bottom edge then fades). Follows the rows' sizes (a row opening), their number and the scroll position. */
function useMoreBelow(root: RefObject<HTMLElement | null>, selector: string, active: boolean): boolean {
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const el = active ? root.current?.querySelector<HTMLElement>(selector) : null
    if (!el) return
    const check = () => setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 4)
    const ro = new ResizeObserver(check)
    const observe = () => {
      ro.disconnect()
      ro.observe(el)
      for (const c of Array.from(el.children)) ro.observe(c)
    }
    observe()
    check()
    const mo = new MutationObserver(() => {
      observe()
      check()
    })
    mo.observe(el, { childList: true })
    el.addEventListener('scroll', check, { passive: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', check)
      setMore(false)
    }
  }, [root, selector, active])
  return more
}

/** Command, wider screens: the right column (no panel) or, after "View all updates", the glass panel with the data
 *  status and the feed. Focus follows the switch: into the panel's heading, back to "View all updates". */
function CommandUpdates({ children, heading }: { children: ReactNode; heading: RefObject<HTMLHeadingElement | null> }) {
  const setPanel = useWorkspace((s) => s.setPanel)
  const [expanded, setExpanded] = useState(false)
  const viewAll = useRef<HTMLButtonElement | null>(null)
  const focusNext = useRef<'heading' | 'view-all' | null>(null)
  // the rows scroll between the column's head and its foot when open rows make them taller than the room left; their
  // bottom edge fades while more is below
  const column = useRef<HTMLElement | null>(null)
  const moreBelow = useMoreBelow(column, '.on-rows', !expanded)
  useEffect(() => {
    const t = focusNext.current
    focusNext.current = null
    if (t === 'heading') heading.current?.focus({ preventScroll: true })
    else if (t === 'view-all') viewAll.current?.focus({ preventScroll: true })
  }, [expanded, heading])
  const toggle = (open: boolean) => {
    const a = document.activeElement
    if (a instanceof HTMLElement && a.closest('.mw-updates-panel')) focusNext.current = open ? 'heading' : 'view-all'
    setExpanded(open)
  }
  const collapse = (
    <button type="button" className="mw-link-btn cmd-hide" aria-label="Collapse updates panel" data-tip="Hide this column (the Updates button brings it back)" aria-expanded={true} onClick={() => setPanel('updates', false)}>
      Hide
    </button>
  )
  if (!expanded)
    return (
      <section ref={column} className={`mw-updates-panel is-column${moreBelow ? ' has-more' : ''}`} aria-labelledby="mw-updates-title" data-drawer="updates">
        <h2 id="mw-updates-title" className="mw-sr-only" ref={heading} tabIndex={-1}>
          Incident updates
        </h2>
        <OfficialNow variant="command" />
        <div className="cmd-col-foot">
          <button ref={viewAll} type="button" className="mw-link-btn cmd-view-all" aria-expanded={false} onClick={() => toggle(true)}>
            View all updates
            <ChevronRight size={12} aria-hidden="true" />
          </button>
          {collapse}
        </div>
      </section>
    )
  return (
    <section className="mw-updates-panel is-expanded is-command-panel" aria-labelledby="mw-updates-title" data-drawer="updates">
      <header className="mw-panel-head">
        <h2 id="mw-updates-title" ref={heading} tabIndex={-1}>
          Incident updates
        </h2>
        <button type="button" className="mw-link-btn mw-panel-more" aria-expanded={true} onClick={() => toggle(false)}>
          Show fewer
          <ChevronUp size={13} />
        </button>
        {collapse}
      </header>
      <div className="mw-updates-scroll">
        <div className="mw-official-slot">
          <OfficialNow variant="command" />
        </div>
        <DataStatus />
        <div className="mw-updates-body">{children}</div>
      </div>
      <footer className="mw-panel-foot">
        <button type="button" className="mw-link-btn" aria-expanded={true} onClick={() => toggle(false)}>
          Show fewer updates
          <ChevronUp size={13} />
        </button>
      </footer>
    </section>
  )
}

export function UpdatesPanel({ children }: { children: ReactNode }) {
  const open = useWorkspace((s) => s.panels.updates)
  const setPanel = useWorkspace((s) => s.setPanel)
  const command = useWorkspace((s) => s.preset === 'command')
  const narrow = useMediaQuery(NARROW_QUERY)
  const [expanded, setExpanded] = useState(false)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'updates')
  // desktop Public opens on the short official summary; everything else shows the full block and the feed
  const compact = !command && !narrow && !expanded
  if (!open) {
    if (narrow) return null // phones: opened from the header
    return (
      <button type="button" className="mw-btn mw-updates-open" data-panel-toggle="updates" aria-expanded={false} onClick={() => setPanel('updates', true)}>
        <ListChecks size={14} /> Updates
      </button>
    )
  }
  if (command && !narrow) return <CommandUpdates heading={heading}>{children}</CommandUpdates>
  return (
    <section className={`mw-updates-panel${expanded ? ' is-expanded' : ''}${compact ? ' is-compact' : ''}`} aria-labelledby="mw-updates-title" data-drawer="updates">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className={`mw-panel-head${compact ? ' is-official' : ''}`}>
        {compact && <span className="mw-tag is-official">Official</span>}
        <h2 id="mw-updates-title" ref={heading} tabIndex={-1}>
          {compact ? 'Official now' : 'Incident updates'}
        </h2>
        {/* desktop Public: the short summary opens into the full official block, data status and feed */}
        {!command && !narrow && (
          <button
            type="button"
            className="mw-link-btn mw-panel-more"
            aria-expanded={expanded}
            data-tip={expanded ? 'Back to the short official summary' : 'Official details, data status and all updates'}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Less' : 'Details'}
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        <button
          type="button"
          className="mw-icon-btn"
          aria-label={narrow ? 'Close updates' : 'Collapse updates panel'}
          data-tip={narrow ? undefined : 'Collapse'}
          aria-expanded={true}
          onClick={() => setPanel('updates', false)}
        >
          {narrow ? <X size={15} /> : <ChevronRight size={15} />}
        </button>
      </header>
      <div className="mw-updates-scroll">
        {compact ? (
          <OfficialSummary />
        ) : (
          <div className="mw-official-slot">
            <OfficialNow variant={command ? 'command' : 'panel'} />
          </div>
        )}
        {command ? <DataStatus /> : !compact && <Freshness defaultOpen={!narrow} />}
        {!compact && <div className="mw-updates-body">{children}</div>}
      </div>
    </section>
  )
}
