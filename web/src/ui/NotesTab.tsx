// Notes tab (SPEC 9.4): a textarea saved to localStorage per incident (debounced), with an "insert timeline time"
// helper, plus the incident's timeline annotations ("+ Add" in Key Events) with jump / delete.
import { Clock3, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fmtAt, fmtClock } from '../lib/time'
import { loadNotes, saveNotes, useAnnotations, useIncidentAnnotations } from '../state/annotations'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { EmptyNote, Section } from './controls'

export function NotesTab() {
  const id = useStore((s) => s.incidentId)
  if (!id)
    return (
      <div className="tab-pad">
        <EmptyNote icon={<StickyNote size={16} />} title="No incident selected" />
      </div>
    )
  return <NotesBody key={id} incidentId={id} />
}

function NotesBody({ incidentId }: { incidentId: string }) {
  const tf = useTimeFormat()
  const [text, setText] = useState(() => loadNotes(incidentId))
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const latest = useRef(text)
  useEffect(() => {
    latest.current = text
  }, [text])

  const schedule = (v: string) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const ok = saveNotes(incidentId, v)
      setFailed(!ok)
      if (ok) setSavedAt(Date.now())
    }, 400)
  }
  // flush pending edits when switching incidents / unmounting
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      saveNotes(incidentId, latest.current)
    },
    [incidentId],
  )

  const insertTime = () => {
    const t = useStore.getState().timeMs
    const stamp = `[${fmtAt(t, tf, { zone: true })}] `
    const el = area.current
    const pos = el ? el.selectionStart : text.length
    const before = text.slice(0, pos)
    const pre = before.length && !before.endsWith('\n') ? '\n' : ''
    const next = before + pre + stamp + text.slice(pos)
    setText(next)
    schedule(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const c = pos + pre.length + stamp.length
      el.setSelectionRange(c, c)
    })
  }

  return (
    <div className="tab-pad notes">
      <Section
        title="Analyst notes"
        aside={
          <span className={`mono small ${failed ? 'danger' : 'muted'}`}>
            {failed ? 'storage blocked' : savedAt ? `saved ${fmtClock(savedAt, tf)}` : 'local only'}
          </span>
        }
      >
        <textarea
          ref={area}
          className="notes-area"
          value={text}
          spellCheck
          placeholder="Observations, hypotheses, follow-ups… Saved in this browser for this incident."
          onChange={(e) => {
            setText(e.target.value)
            schedule(e.target.value)
          }}
        />
        <div className="notes-bar">
          <button type="button" className="btn btn-sm" onClick={insertTime} data-tip="Insert the current timeline time at the cursor">
            <Clock3 size={12} /> Insert time
          </button>
          <span className="mono muted small">{text.length.toLocaleString('en-US')} chars</span>
        </div>
      </Section>
      <Annotations incidentId={incidentId} />
    </div>
  )
}

function Annotations({ incidentId }: { incidentId: string }) {
  const tf = useTimeFormat()
  const list = useIncidentAnnotations(incidentId)
  const st = useStore.getState
  return (
    <Section title="Timeline annotations" aside={<span className="mono muted">{list.length}</span>}>
      {list.length === 0 ? (
        <p className="muted small">Use “+ Add” in Key Events to pin a note at the current time and view.</p>
      ) : (
        <ul className="ann-list">
          {list.map((a) => (
            <li key={a.id} className="ann">
              <button
                type="button"
                className="ann-main"
                onClick={() => {
                  st().setPlaying(false)
                  st().setTimeMs(a.t_ms)
                  if (a.x != null && a.z != null) st().requestFlyTo(a.x, a.z)
                }}
              >
                <StickyNote size={12} className="ann-icon" />
                <span className="ellipsis">{a.title}</span>
                <span className="mono muted">{fmtAt(a.t_ms, tf)}</span>
              </button>
              <button type="button" className="icon-btn ann-del" aria-label="Delete annotation" data-tip="Delete" onClick={() => useAnnotations.getState().remove(incidentId, a.id)}>
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
