// Collapsible right-side updates panel (owner: shell, CONTRACT §3; BRIEF §6, §10). The feed itself (<UpdatesFeed/>)
// belongs to timeline-feed and arrives as `children`. Desktop: a compact panel showing the latest updates with "View
// all updates" to expand it, collapsible to a small button. Phones: a bottom sheet opened from the header. Command
// adds a "Data status" block with each source's newest timestamp (dataStatus.ts).
import { ChevronDown, ChevronRight, ChevronUp, ListChecks, X } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { useNow } from '../hooks'
import { buildDataStatus } from './dataStatus'
import { NARROW_QUERY, useDrawerFocus, useMediaQuery, useOverflowing } from './hooks'

function DataStatus() {
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
  const nowMs = useNow(30_000)
  const rows = useMemo(() => buildDataStatus(inp, nowMs), [inp, nowMs])
  const [open, setOpen] = useState(true)
  if (!inp.manifest) return null
  return (
    <section className="mw-status" aria-label="Data status">
      <button type="button" className="mw-status-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mw-eyebrow">Data status</span>
        <span className="mw-status-mode">{inp.manifest.mode === 'live' ? 'Live data' : 'Archived replay'}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
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
      )}
    </section>
  )
}

export function UpdatesPanel({ children }: { children: ReactNode }) {
  const open = useWorkspace((s) => s.panels.updates)
  const setPanel = useWorkspace((s) => s.setPanel)
  const command = useWorkspace((s) => s.preset === 'command')
  const narrow = useMediaQuery(NARROW_QUERY)
  const [expanded, setExpanded] = useState(false)
  const [bodyRef, overflowing] = useOverflowing<HTMLDivElement>(open)
  const heading = useRef<HTMLHeadingElement | null>(null)
  useDrawerFocus(open, heading, 'updates')
  if (!open) {
    if (narrow) return null // phones: opened from the header
    return (
      <button type="button" className="mw-btn mw-updates-open" data-panel-toggle="updates" aria-expanded={false} onClick={() => setPanel('updates', true)}>
        <ListChecks size={14} /> Updates
      </button>
    )
  }
  return (
    <section className={`mw-updates-panel ${expanded ? 'is-expanded' : ''}`} aria-labelledby="mw-updates-title" data-drawer="updates">
      <span className="mw-sheet-handle" aria-hidden="true" />
      <header className="mw-panel-head">
        <h2 id="mw-updates-title" ref={heading} tabIndex={-1}>
          Incident updates
        </h2>
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
      {command && <DataStatus />}
      <div className="mw-updates-body" ref={bodyRef}>
        {children}
      </div>
      {!narrow && (overflowing || expanded) && (
        <footer className="mw-panel-foot">
          <button type="button" className="mw-link-btn" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Show fewer updates' : 'View all updates'}
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </footer>
      )}
    </section>
  )
}
