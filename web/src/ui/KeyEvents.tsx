// Key Events (SPEC 9.4), Forensic's list (owner: official-web since brief 2): one row per event (type icon + colour,
// title, a visible kind glyph whose corner dot marks automated detections, Pacific time). Click -> the shared
// selectFeedItem (pause, set time, select, fly the camera there). The kind (observation / estimate / model output /
// official update / your note) comes from the same feed model as the Public/Command updates feed; the tooltip spells
// it out. "+ Add" pins an annotation (localStorage, per incident) at the current time and the camera's orbit target;
// annotations show here and on the timeline.
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { fmtAt } from '../lib/time'
import { useSceneStore } from '../scene/sceneStore'
import { useAnnotations, useIncidentAnnotations } from '../state/annotations'
import { lastIndexAtOrBefore } from '../state/selectors'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { Popover } from './controls'
import { CONFIDENCE_LABEL, EVENT_STYLE } from './eventMeta'
import { buildFeedItems, selectFeedItem } from './feed/feedModel'
import { AUTOMATED_NOTE, KIND_META } from './feed/feedMeta'
import './feed/keyEvents.css'
import { goToItem, mergeEvents, type TimelineItem } from './timelineModel'

export function KeyEvents() {
  const tf = useTimeFormat()
  const { events, incidentId, selected, manifest } = useStore(
    useShallow((s) => ({ events: s.events, incidentId: s.incidentId, selected: s.selectedEventId, manifest: s.manifest?.status === 'ready' ? s.manifest : null })),
  )
  const ready = manifest != null
  const notes = useIncidentAnnotations(incidentId)
  const items = useMemo(() => mergeEvents(events?.events, notes), [events, notes])
  const feed = useMemo(() => new Map(buildFeedItems({ manifest, events: events?.events ?? [], annotations: notes, tf }).map((f) => [f.id, f])), [manifest, events, notes, tf])
  const times = useMemo(() => items.map((i) => i.t), [items])
  const current = useStore((s) => lastIndexAtOrBefore(times, s.timeMs))
  const listRef = useRef<HTMLDivElement | null>(null)
  const byId = useMemo(() => new Map((events?.events ?? []).map((e) => [e.id, e])), [events])

  // keep the selected row in view (e.g. selected from a timeline marker)
  useEffect(() => {
    if (!selected) return
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="ke">
      <div className="ke-head">
        <span className="dock-title">Key Events</span>
        <span className="mono muted small">{items.length || ''}</span>
        <span className="flex-1" />
        <AddAnnotation incidentId={incidentId} disabled={!ready} />
      </div>
      <div className="ke-list" ref={listRef}>
        {items.length === 0 && (
          <div className="ke-empty muted">{ready ? 'No key events detected for this fire. No update does not mean no danger; follow local officials.' : 'Events appear once the bundle is built.'}</div>
        )}
        {items.map((it, i) => {
          const style = EVENT_STYLE[it.kind]
          const Icon = style.Icon
          const ev = byId.get(it.id)
          const fi = feed.get(it.id)
          const meta = fi ? KIND_META[fi.kind] : null
          const KindIcon = meta?.Icon
          const kind = fi && meta ? `${meta.label}${fi.automated ? ' (automated)' : ''}` : null
          const tip = [it.detail, ev ? [kind, CONFIDENCE_LABEL[ev.confidence] ?? ev.confidence, ev.source].filter(Boolean).join(' · ') : 'Your annotation'].filter(Boolean).join(' — ')
          return (
            <div key={it.id} data-id={it.id} className={`ke-row ${selected === it.id ? 'is-selected' : ''} ${i === current ? 'is-current' : ''} ${i > current ? 'is-future' : ''}`}>
              <button type="button" className="ke-main" onClick={() => (fi ? selectFeedItem(fi) : goToItem(it))} data-tip={tip}>
                <span className="ke-icon" style={{ color: style.color }}>
                  <Icon size={12} strokeWidth={2.2} />
                </span>
                <span className="ke-title ellipsis">{it.title}</span>
                <span className="ke-end">
                  {KindIcon && meta && (
                    <span
                      className={`ke-kind is-${fi?.kind}${fi?.automated ? ' is-auto' : ''}`}
                      aria-label={fi?.automated ? `${meta.label}, automated` : meta.label}
                      role="img"
                      data-tip={`${meta.label}${fi?.automated ? ` · automated: ${AUTOMATED_NOTE}` : ''}`}
                    >
                      <KindIcon size={11} aria-hidden="true" />
                    </span>
                  )}
                  <span className="ke-time mono">{fmtAt(it.t, tf)}</span>
                </span>
              </button>
              {it.kind === 'annotation' && incidentId && (
                <button type="button" className="icon-btn ke-del" aria-label="Delete annotation" data-tip="Delete annotation" onClick={() => useAnnotations.getState().remove(incidentId, it.id)}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AddAnnotation({ incidentId, disabled }: { incidentId: string | null; disabled: boolean }) {
  const tf = useTimeFormat()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const anchor = useRef<HTMLButtonElement | null>(null)
  const timeMs = useStore((s) => (open ? s.timeMs : 0))
  const submit = () => {
    if (!incidentId) return
    const s = useStore.getState()
    const target = useSceneStore.getState().camera?.target
    const ann = useAnnotations.getState().add(incidentId, {
      // whole minute at or before the time, so the new note is never listed after the current time
      t_ms: Math.floor(s.timeMs / 60_000) * 60_000,
      title: title.trim() || 'Note',
      ...(target ? { x: Math.round(target[0]), z: Math.round(target[2]) } : {}),
    })
    s.setSelectedEventId(ann.id)
    setTitle('')
    setOpen(false)
  }
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-sm btn-ghost ke-add" disabled={disabled || !incidentId} onClick={() => setOpen((o) => !o)} data-tip="Pin a note at the current time and view">
        <Plus size={12} /> Add
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-end" width={280} label="Add annotation" className="menu-pop add-pop">
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <span className="eyebrow">New annotation</span>
          <input autoFocus className="text-input" placeholder="e.g. Spot fire across the river" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          <div className="add-row">
            <span className="mono muted small">
              {fmtAt(timeMs, tf, { zone: true })}
            </span>
            <button type="submit" className="btn btn-sm btn-gold">
              Add
            </button>
          </div>
        </form>
      </Popover>
    </>
  )
}

export type { TimelineItem }
