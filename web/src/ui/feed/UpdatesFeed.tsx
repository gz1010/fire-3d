// Updates feed (owner: official-web since brief 2, earlier timeline-feed; CONTRACT §8, §13, BRIEF §10): Key Events
// promoted into the right panel, plus agency perimeters, satellite passes, the selected forecast run and the official
// and optional sources. Every item shows a plain title and detail, its time (with the time zone), its source and what
// kind of information it is; automated items say so; official items name their issuer, their own times and a link.
// Newest first.
//   Filters: Official (agencies' own updates) · All · Key events.
//   Live: everything, newest first; a day's satellite passes are one row; updates that arrive while the page is open
//   are marked "New"; a quiet-period row says when satellites last saw new heat (never an all-clear).
//   Replay: key events by default; the feed shows what had happened by the replay time, later updates sit behind a
//   "later" toggle.
// Clicking an item selects it, moves the timeline to its time and flies the map / Forensic camera to it
// (selectFeedItem; official items fit and highlight their area and never seek into a forecast); clicking it again
// closes its details. Items without a location stay usable, with no fake target.
// Keyboard: the list is one Tab stop (roving focus); ↑/↓ move between updates, Home/End jump, Enter opens one.
// Public is calm: plain words, no run ids, no "+ Note" (Command keeps them).
import { Archive, Check, ChevronDown, ChevronRight, Copy, ExternalLink, LocateFixed, MapPin, Plus, Search, Trash2, X } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as RKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agoText, fmtWhen } from '../../extras/format'
import { fmtLatLon } from '../../lib/format'
import { lonLatToLocal } from '../../lib/reproject'
import { fmtAt, fmtClock, fmtDayDate, fmtRelative, startOfLocalDay } from '../../lib/time'
import { fitOfficialBounds } from '../../official/select'
import { useOfficialRuntime } from '../../official/runtime'
import { useAnnotations, useIncidentAnnotations } from '../../state/annotations'
import { lastIndexAtOrBefore } from '../../state/selectors'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { prefersReducedMotion, useNow } from '../hooks'
import {
  buildFeedItems,
  extendFeedBaseline,
  feedBaseline,
  feedCompareMs,
  feedView,
  filterFeed,
  focusFeedItem,
  isLaterItem,
  isNewFeedItem,
  rovingIndex,
  rovingTabStop,
  selectFeedItem,
  selectionId,
  type FeedBaseline,
  type FeedFilter,
} from './feedModel'
import { AUTOMATED_NOTE, EMPTY_FEED, EMPTY_REPLAY, KIND_META, topicStyle } from './feedMeta'
import type { FeedItem, FeedTopic } from './types'
import './updatesFeed.css'

export interface UpdatesFeedProps {
  /** Updates from the optional and official sources in FeedItem form (`useExtrasFeedItems()`). Pass a memoised
   *  array: a new array rebuilds the feed. */
  extraItems?: readonly FeedItem[]
}

const NO_EXTRA: readonly FeedItem[] = []
const TEN_MIN = 600_000

/** Tooltips of the filters, naming only what this feed actually holds. */
function filterTips(items: readonly FeedItem[]): Record<FeedFilter, string> {
  const has = (t: FeedTopic) => items.some((i) => i.topic === t)
  const parts: [boolean, string][] = [
    [true, 'key events'],
    [has('perimeter'), 'mapped perimeters'],
    [has('detection'), 'satellite passes'],
    [has('forecast'), 'the forecast run'],
    [has('evacuation'), 'official evacuation status'],
    [has('record') || has('calfire'), 'agency record changes'],
    [has('fire-weather'), 'NWS fire weather alerts'],
    [has('camera'), 'public cameras'],
    [has('imagery'), 'new satellite images'],
  ]
  const all = parts.filter(([on]) => on).map(([, text]) => text)
  const list = all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}` : all[0]
  return {
    official: "Only agencies' own updates: evacuation status, CAL FIRE's record, NWS fire weather alerts, reported start and containment",
    all: `Everything: ${list}`,
    key: 'The key events detected for this fire, official updates and your notes',
  }
}

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'official', label: 'Official' },
  { id: 'all', label: 'All' },
  { id: 'key', label: 'Key events' },
]

function emptyText(filter: FeedFilter): string {
  if (filter === 'official') return "No official updates from Fire-3d's sources for this fire. That is not an all-clear: follow local officials."
  if (filter === 'key') return 'No key events were detected for this fire.'
  return EMPTY_FEED
}

export function UpdatesFeed({ extraItems = NO_EXTRA }: UpdatesFeedProps = {}) {
  const d = useStore(
    useShallow((s) => ({
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      events: s.events,
      timeseries: s.timeseries,
      weather: s.weather,
      perimeters: s.perimeters,
      detections: s.detections,
      forecast: s.forecast,
      incidentId: s.incidentId,
      selected: s.selectedEventId,
      loading: s.incidentLoading,
    })),
  )
  const units = useWorkspace((s) => s.units)
  const preset = useWorkspace((s) => s.preset)
  const command = preset === 'command'
  const feedTf = useTimeFormat()
  const notes = useIncidentAnnotations(d.incidentId)
  // default: everything for live fires (what changed recently), key events for replays (the story); a choice sticks
  const [userFilter, setFilter] = useState<FeedFilter | null>(null)
  const filter: FeedFilter = userFilter ?? (d.manifest?.mode === 'historical' ? 'key' : 'all')
  const [showLater, setShowLater] = useState(false)
  const [adding, setAdding] = useState(false)
  const nowMs = useNow(30_000)
  // the quiet-period row and "today" wording need the clock; rebuild at most every 10 minutes for them
  const wallMs = Math.floor(nowMs / TEN_MIN) * TEN_MIN
  const listRef = useRef<HTMLOListElement | null>(null)
  const live = d.manifest?.mode === 'live'

  const items = useMemo(
    () =>
      d.manifest
        ? buildFeedItems({
            manifest: d.manifest,
            events: d.events?.events ?? [],
            annotations: notes,
            timeseries: d.timeseries,
            weather: d.weather,
            perimeters: d.perimeters?.perimeters ?? null,
            detections: d.detections?.detections ?? null,
            forecast: d.forecast,
            units,
            extra: extraItems,
            preset,
            groupPasses: live,
            wallMs,
            tf: feedTf,
          })
        : [],
    [d.manifest, d.events, notes, d.timeseries, d.weather, d.perimeters, d.detections, d.forecast, units, extraItems, preset, live, wallMs, feedTf],
  )
  const shown = useMemo(() => filterFeed(items, filter), [items, filter])
  // re-render on the timeline only when it crosses an item's time (not every playback frame)
  const cmpSorted = useMemo(() => shown.map(feedCompareMs).sort((a, b) => a - b), [shown])
  const count = useStore((s) => lastIndexAtOrBefore(cmpSorted, s.timeMs) + 1)
  const threshold = count > 0 ? cmpSorted[count - 1] : -Infinity

  // "New" marks are relative to what was listed when the feed first showed this incident (state adjusted while
  // rendering: React's pattern for a value derived from an earlier render)
  const [baseline, setBaseline] = useState<FeedBaseline | null>(null)
  if (d.manifest && d.incidentId && baseline?.incidentId !== d.incidentId) setBaseline(feedBaseline(d.incidentId, items))
  else if (baseline && baseline.incidentId === d.incidentId) {
    const extended = extendFeedBaseline(baseline, items)
    if (extended) setBaseline(extended)
  }
  // roving focus: the row that was focused last keeps the list's single Tab stop
  const [focusId, setFocusId] = useState<string | null>(null)

  // keep the selected item in view (also when it was selected on the map or the timeline)
  useEffect(() => {
    if (!d.selected) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-feed-id="${CSS.escape(d.selected)}"]`)
    if (el) scrollItemIntoView(el, prefersReducedMotion() ? 'auto' : 'smooth')
  }, [d.selected])

  if (!d.manifest)
    return <p className="uf-empty">{d.loading ? 'Loading incident updates…' : d.incidentId ? 'Updates appear once the incident data is ready.' : 'Choose a fire to see its updates.'}</p>

  const { listed, later, currentId } = feedView(shown, threshold, live, showLater)
  const counts: Record<FeedFilter, number> = { official: items.filter((i) => i.kind === 'official').length, all: items.length, key: items.filter((i) => i.key).length }
  const tips = filterTips(items)
  const selectedRow = d.selected != null ? (listed.find((i) => selectionId(i) === d.selected)?.id ?? null) : null
  const tabStop = rovingTabStop(
    listed.map((i) => i.id),
    [focusId, selectedRow, currentId],
  )
  const onListKey = (e: RKeyboardEvent<HTMLOListElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLButtonElement>('.uf-row')
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return // keys inside an item's details work as usual
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > li > .uf-row')]
    const next = rovingIndex(e.key, rows.indexOf(row), rows.length)
    if (next == null) return
    e.preventDefault()
    const target = rows[next]
    target.focus({ preventScroll: true })
    const li = target.closest('li')
    if (li) scrollItemIntoView(li, 'auto')
  }

  return (
    <div className={`uf ${command ? 'is-command' : ''}`}>
      <div className="uf-bar">
        <div className="uf-seg" role="group" aria-label="Which updates to show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} data-tip={tips[f.id]}>
              {f.label} <span className="uf-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <span className="uf-order">Newest first</span>
        {command && (
          <button type="button" className="uf-add-btn" aria-expanded={adding} onClick={() => setAdding((a) => !a)} data-tip="Pin a note at the timeline time">
            <Plus size={13} /> Note
          </button>
        )}
      </div>
      {adding && command && d.incidentId && <AddNote incidentId={d.incidentId} onDone={() => setAdding(false)} />}
      {!live && later.length > 0 && (
        <button type="button" className="uf-later" aria-expanded={showLater} onClick={() => setShowLater((v) => !v)}>
          {showLater ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showLater ? 'Hide' : 'Show'} {later.length} later update{later.length === 1 ? '' : 's'}
          <span className="uf-later-hint">after the replay time</span>
        </button>
      )}
      {listed.length === 0 ? (
        <p className="uf-empty">{shown.length === 0 ? emptyText(filter) : `${EMPTY_REPLAY} Press play or move the timeline.`}</p>
      ) : (
        <>
          <span id="uf-keys-help" className="uf-sr">
            Use the up and down arrow keys to move between updates, Home and End to jump to the newest or oldest, Enter to select one.
          </span>
          <ol
            className="uf-list"
            ref={listRef}
            aria-label={`Incident updates, newest first${!live && !showLater ? ', up to the replay time' : ''}`}
            aria-describedby="uf-keys-help"
            onKeyDown={onListKey}
          >
            {listed.map((it) => (
              <FeedRow
                key={it.id}
                item={it}
                selected={d.selected != null && d.selected === selectionId(it)}
                later={isLaterItem(it, threshold, live)}
                current={it.id === currentId}
                isNew={isNewFeedItem(baseline, d.incidentId, it, live)}
                live={live}
                command={command}
                nowMs={nowMs}
                incidentId={d.incidentId}
                tabbable={it.id === tabStop}
                onFocusRow={setFocusId}
              />
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

/** Scroll the nearest scrolling ancestor so the item is fully visible, or its title when it is taller than the
 *  view; the sticky toolbar inside the scroller is accounted for. */
function scrollItemIntoView(el: HTMLElement, behavior: ScrollBehavior): void {
  let sc: HTMLElement | null = el.parentElement
  while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
  if (!sc) return
  const bar = sc.querySelector<HTMLElement>('.uf-bar')
  const barH = bar && sc.contains(bar) ? bar.getBoundingClientRect().height : 0
  const r = el.getBoundingClientRect()
  const v = sc.getBoundingClientRect()
  const top = r.top - v.top + sc.scrollTop
  let target = sc.scrollTop
  if (r.height > sc.clientHeight - barH || r.top < v.top + barH) target = top - barH
  else if (r.bottom > v.bottom) target = top + r.height - sc.clientHeight
  if (Math.abs(target - sc.scrollTop) > 1) sc.scrollTo({ top: target, behavior })
}

interface RowProps {
  item: FeedItem
  selected: boolean
  later: boolean
  current: boolean
  isNew: boolean
  live: boolean
  command: boolean
  nowMs: number
  incidentId: string | null
  /** Holds the list's single Tab stop (roving focus). */
  tabbable: boolean
  onFocusRow: (id: string) => void
}

const STATUS_LABEL: Partial<Record<NonNullable<FeedItem['status']>, string>> = { expired: 'Expired', cancelled: 'Cancelled', upcoming: 'Upcoming' }

const FeedRow = memo(function FeedRow({ item, selected, later, current, isNew, live, command, nowMs, incidentId, tabbable, onFocusRow }: RowProps) {
  const topic = topicStyle(item.topic)
  const kind = KIND_META[item.kind]
  const Icon = topic.Icon
  const KindIcon = kind.Icon
  const compact = !item.key && item.topic === 'detection' && !item.children?.length
  const ended = item.status === 'expired' || item.status === 'cancelled'
  const cls = ['uf-item', selected && 'is-selected', later && 'is-later', current && 'is-current', compact && 'is-compact', item.kind === 'official' && 'is-official', ended && 'is-ended']
    .filter(Boolean)
    .join(' ')
  const t = item.tMs
  // the fire's own zone and the preset's clock (CONTRACT §14.9): "3:40 PM MDT" (Public) / "15:40 MDT" (Command)
  const tf = useTimeFormat()
  // Clock time with the time zone over how long ago (live, today), the day (older live items) or the date (replay).
  const recent = live && startOfLocalDay(t, tf.tz) === startOfLocalDay(nowMs, tf.tz)
  const line1 = item.timeNotGiven ? 'Time not given' : fmtClock(t, tf, { zone: true })
  const line2 = item.timeNotGiven ? (item.checkedMs != null ? `checked ${agoText(item.checkedMs, nowMs)}` : null) : live ? (recent ? fmtRelative(t, nowMs) : fmtDayDate(t, tf.tz)) : fmtDayDate(t, tf.tz)
  const status = item.status ? STATUS_LABEL[item.status] : undefined
  return (
    <li className={cls} data-feed-id={selectionId(item)}>
      <button
        type="button"
        className="uf-row"
        tabIndex={tabbable ? 0 : -1}
        aria-expanded={selected}
        aria-controls={selected ? `uf-more-${item.id}` : undefined}
        onFocus={() => onFocusRow(item.id)}
        onClick={() => (selected ? useStore.getState().setSelectedEventId(null) : selectFeedItem(item))}
      >
        <span className="uf-icon" style={{ color: topic.color }} aria-hidden="true">
          <Icon size={14} strokeWidth={2.2} />
        </span>
        <span className="uf-main">
          <span className="uf-title">
            {item.title}
            {isNew && <span className="uf-new">New</span>}
          </span>
          {item.place && (
            <span className="uf-place">
              <MapPin size={11} aria-hidden="true" />
              {item.place}
            </span>
          )}
          {item.detail && !compact && <span className="uf-detail">{item.detail}</span>}
          <span className="uf-meta">
            <span className={`uf-kind uf-kind-${item.kind}`}>
              <KindIcon size={11} aria-hidden="true" />
              {kind.label}
            </span>
            {status && <span className={`uf-status is-${item.status}`}>{status}</span>}
            {item.archived && (
              <span className="uf-archived" data-tip="An archived copy of the official product (Iowa Environmental Mesonet), not the live source">
                <Archive size={10} aria-hidden="true" /> Archived copy
              </span>
            )}
            {item.automated && <span className="uf-auto" data-tip={AUTOMATED_NOTE}>Automated</span>}
            <span className="uf-src">{item.source}</span>
          </span>
          {command && item.location && (
            <span className="uf-coords">
              {fmtLatLon(item.location.lat, item.location.lon)}
              {item.approximate ? ' (approx.)' : ''}
            </span>
          )}
        </span>
        <span className="uf-time">
          <time dateTime={new Date(t).toISOString()} data-tip={item.timeNotGiven ? 'The source gives no time for this update' : fmtAt(t, tf, { zone: true })}>
            {line1}
          </time>
          {line2 && <span className="uf-rel">{line2}</span>}
          {later && <span className="uf-rel">later</span>}
        </span>
      </button>
      {selected && <FeedDetails item={item} incidentId={incidentId} command={command} nowMs={nowMs} />}
    </li>
  )
})

function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    )
  return Promise.resolve(false)
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="uf-link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

/** Issuer, the issuer's own times, Fire-3d's check time, notes and links of an official item. */
function OfficialDetails({ item, nowMs }: { item: FeedItem; nowMs: number }) {
  const tf = useTimeFormat()
  const times: { label: string; ms: number }[] = []
  if (item.issuedMs != null) times.push({ label: 'Issued', ms: item.issuedMs })
  if (item.updatedMs != null) times.push({ label: (item.topic === 'record' || item.topic === 'calfire') && item.issuer ? `Updated by ${item.issuer}` : 'Updated by the issuer', ms: item.updatedMs })
  if (item.expiresMs != null) times.push({ label: item.status === 'expired' ? 'Ended' : 'Until', ms: item.expiresMs })
  return (
    <>
      {item.issuer && (
        <p className="uf-note">
          <span className="uf-label">Issued by</span> <strong>{item.issuer}</strong>
        </p>
      )}
      {times.length > 0 && (
        <dl className="uf-facts">
          {times.map((t) => (
            <div key={t.label}>
              <dt>{t.label}</dt>
              <dd>{fmtWhen(t.ms, nowMs, tf)}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.notes
        ?.filter((n) => !item.detail?.includes(n))
        .map((n) => (
          <p key={n} className="uf-note">
            {n}
          </p>
        ))}
      {item.sections && item.sections.length > 0 && (
        <details className="uf-sections">
          <summary>Official text ({item.sections.map((s) => s.label).join(', ')})</summary>
          {item.sections.map((s) => (
            <p key={s.label} className="uf-quote">
              <span className="uf-label">{s.label}</span> {s.text}
            </p>
          ))}
        </details>
      )}
      <p className="uf-note uf-links">
        {item.url && <ExtLink href={item.url}>Open source</ExtLink>}
        {item.links?.map((l) => (
          <ExtLink key={l.url} href={l.url}>
            {l.label}
          </ExtLink>
        ))}
        {item.checkedMs != null && <span className="uf-muted">Checked by Fire-3d {agoText(item.checkedMs, nowMs)}</span>}
      </p>
    </>
  )
}

function FeedDetails({ item, incidentId, command, nowMs }: { item: FeedItem; incidentId: string | null; command: boolean; nowMs: number }) {
  const tf = useTimeFormat()
  const [copied, setCopied] = useState(false)
  const highlighted = useOfficialRuntime((s) => s.highlight?.id === item.id)
  const kind = KIND_META[item.kind]
  const loc = item.location
  const coords = loc ? fmtLatLon(loc.lat, loc.lon) : null
  const orig = item.original
  const showOrig = orig != null && (orig.detail !== item.detail || orig.title !== item.title) && (command || item.topic !== 'forecast')
  const official = item.kind === 'official'
  return (
    <div className="uf-more" id={`uf-more-${item.id}`}>
      {item.detail && item.topic === 'detection' && !item.children?.length && <p className="uf-more-detail">{item.detail}</p>}
      {item.facts && item.facts.length > 0 && (
        <dl className="uf-facts">
          {item.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>
                {f.text}
                {f.scientific && (command || !official) && <span className="uf-sci">{f.scientific}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {item.children && item.children.length > 0 && (
        <ul className="uf-children" aria-label="Satellite passes of this day">
          {item.children.map((c) => (
            <li key={c.id}>
              <button type="button" className="uf-child" onClick={() => focusFeedItem(c)} data-tip="Move the timeline to this pass and show it on the map">
                <span className="uf-child-time">{fmtClock(c.tMs, tf, { zone: true })}</span>
                <span className="uf-child-text">
                  {c.title.replace(/^Satellite pass: /, '')} · {c.source.replace(/^NASA FIRMS \(|\)$/g, '')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="uf-note">
        <strong>{kind.label}.</strong> {kind.meaning}
        {item.automated ? ` ${AUTOMATED_NOTE}` : ''}
      </p>
      {official && <OfficialDetails item={item} nowMs={nowMs} />}
      {item.kind !== 'annotation' && !official && (
        <p className="uf-note">
          <span className="uf-label">Source</span> {item.source}
          {orig && orig.source !== item.source && (command || item.topic !== 'forecast') && <span className="uf-sci"> ({orig.source})</span>}
        </p>
      )}
      {showOrig && (
        <p className="uf-note uf-sci">
          <span className="uf-label">Original</span> {orig.title}
          {orig.detail ? `: ${orig.detail}` : ''}
        </p>
      )}
      {loc && coords ? (
        <p className="uf-note uf-loc">
          <MapPin size={12} aria-hidden="true" />
          <span>
            {item.locationLabel ?? 'Location'}
            {item.approximate ? ' (approximate)' : ''}: <span className="uf-coord">{coords}</span>
          </span>
          <button
            type="button"
            className="uf-icon-btn"
            aria-label={copied ? 'Coordinates copied' : 'Copy coordinates'}
            data-tip={copied ? 'Copied' : 'Copy WGS84 coordinates'}
            onClick={() =>
              void copyText(`${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`).then((ok) => {
                setCopied(ok)
                if (ok) window.setTimeout(() => setCopied(false), 1500)
              })
            }
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </p>
      ) : (
        !item.bounds && <p className="uf-note uf-muted">No map location for this update.</p>
      )}
      {!item.seekable && (
        <p className="uf-note uf-muted">
          {official ? 'Shown as official status, not a point on the incident timeline: selecting it does not move the time.' : 'Not a point on the incident timeline, so selecting it does not move the time.'}
        </p>
      )}
      <div className="uf-actions">
        {item.bounds && (
          <button
            type="button"
            className="uf-btn"
            aria-pressed={highlighted}
            onClick={() => {
              if (item.highlight) useOfficialRuntime.getState().setHighlight(item.highlight)
              fitOfficialBounds(item.bounds)
            }}
          >
            <LocateFixed size={13} /> Show area on map
          </button>
        )}
        {loc && !item.bounds && (
          <button type="button" className="uf-btn" onClick={() => useStore.getState().requestFlyTo(loc.x, loc.z)}>
            <LocateFixed size={13} /> Show on map
          </button>
        )}
        {loc && (
          <button
            type="button"
            className="uf-btn"
            data-tip="Select this point and check it against the fire and the forecast"
            onClick={() =>
              useWorkspace
                .getState()
                .selectLocation({ lat: loc.lat, lon: loc.lon, source: 'event', eventId: item.eventId ?? item.id, label: item.title, approximate: item.approximate ?? item.confidence !== 'observed' }, { fly: true })
            }
          >
            <Search size={13} /> Check this location
          </button>
        )}
        {item.kind === 'annotation' && incidentId && (
          <button
            type="button"
            className="uf-btn uf-btn-danger"
            onClick={() => {
              useAnnotations.getState().remove(incidentId, item.id)
              useStore.getState().setSelectedEventId(null)
            }}
          >
            <Trash2 size={13} /> Delete note
          </button>
        )}
      </div>
    </div>
  )
}

/** Pin a note at the timeline time and at the selected point (else the map centre). Saved in this browser only. */
function AddNote({ incidentId, onDone }: { incidentId: string; onDone: () => void }) {
  const tf = useTimeFormat()
  const [title, setTitle] = useState('')
  // whole minute at or before the timeline time, so the new note is never "later" than the replay time
  const timeMs = useStore((s) => Math.floor(s.timeMs / 60_000) * 60_000)
  const grid = useStore((s) => (s.manifest?.status === 'ready' ? s.manifest.grid : null))
  const where = useWorkspace(
    useShallow((s) =>
      s.selection ? { lat: s.selection.lat, lon: s.selection.lon, what: 'the selected point' } : s.view ? { lat: s.view.centerLat, lon: s.view.centerLon, what: 'the map center' } : null,
    ),
  )
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const xz = where && grid ? lonLatToLocal(where.lon, where.lat, grid) : null
    const ann = useAnnotations.getState().add(incidentId, {
      t_ms: timeMs,
      title: title.trim() || 'Note',
      ...(xz ? { x: Math.round(xz[0]), z: Math.round(xz[1]) } : {}),
    })
    useStore.getState().setSelectedEventId(ann.id)
    setTitle('')
    onDone()
  }
  return (
    <form className="uf-add" onSubmit={submit}>
      <label className="uf-add-label" htmlFor="uf-add-input">
        New note
      </label>
      <div className="uf-add-row">
        <input id="uf-add-input" autoFocus className="uf-input" placeholder="e.g. Smoke visible from the highway" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" className="uf-btn uf-btn-primary">
          Add
        </button>
        <button type="button" className="uf-icon-btn" aria-label="Cancel" onClick={onDone}>
          <X size={13} />
        </button>
      </div>
      <span className="uf-add-hint">
        At {fmtAt(timeMs, tf, { zone: true })}
        {where ? `, pinned at ${where.what}` : ', without a map location'}. Saved only in this browser.
      </span>
    </form>
  )
}
