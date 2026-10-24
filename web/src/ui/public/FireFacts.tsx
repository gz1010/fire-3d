// The fire view's official facts (brief 4 H4, FireView.dc.html "Official facts"; PLAN-4 §3.4, decisions a and i):
// "value — LABEL" rows (ui/shell/Readout.tsx ReadoutRow) from the agency record and the official answers of
// useOfficialNow (ui/public/fireView.ts fireFacts): acres burned, % contained, the start, the reported location (with
// copy), NWS fire weather, evacuation zones in the fire's state, local officials' alerts while one is in effect, and the
// record's last update. Each value is the issuer's own, with its own time and source under it; quiet states say so
// ("None in effect", "Not available in this state") and are never an all-clear. Under the rows: the OFFICIAL badge with
// the sources and when they were checked, "Not an all-clear. Follow local officials." and the record's link.
// Between the rows and that foot, the map data's state (decision a): an unprepared fire's "Prepare map data (1-3 min)"
// (this replaces the top notice in Public), the preparation's progress, a failed preparation, or a prepared fire without a
// perimeter. On short windows the rows scroll and the foot (sources, "Not an all-clear") stays in view.
import { Check, ChevronDown, Copy } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOfficialNow, useOfficialPanelTime } from '../../official/hooks'
import { newestPerimeter } from '../../map/fireProfile'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import { isDemoBundle, useWorkspace } from '../../state/workspace'
import { ProgressBar } from '../controls'
import { useNow } from '../hooks'
import { buildFailed, needsBuild, openFire } from '../shell/fireActions'
import { NOT_ALL_CLEAR } from '../shell/fixedCopy'
import { localAlertsLine } from '../shell/officialSummary'
import { ReadoutRow } from '../shell/Readout'
import { applyView } from '../shell/views'
import { ESTIMATE_IN_COMMAND, factsSource, fireFacts, NOT_PREPARED, PREPARE_AGAIN_LABEL, PREPARE_FAILED, PREPARE_LABEL, PREPARING, type FactRow } from './fireView'

function Sub({ r }: { r: FactRow }) {
  if (!r.sub && !r.link) return null
  return (
    <>
      {r.sub}
      {r.link && (
        <>
          {r.sub ? ' · ' : null}
          <a href={r.link.url} target="_blank" rel="noreferrer noopener">
            {r.link.label}
          </a>
        </>
      )}
    </>
  )
}

/** The reported location's copy button (the row's own words: "Copy the reported coordinates"). */
function CopyCoords({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () =>
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => undefined)
  return (
    <button type="button" className="ro-copy" aria-label={copied ? 'Reported coordinates copied' : 'Copy the reported coordinates'} data-tip={copied ? 'Copied' : 'Copy the reported coordinates'} onClick={copy}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

/** The map data's state under the facts: prepare, preparing, failed, or a prepared fire without a perimeter. */
export function MapDataState() {
  const s = useStore(
    useShallow((st) => ({
      id: st.incidentId,
      manifest: st.manifest,
      summary: st.summary,
      job: st.job,
      loading: st.incidentLoading,
      perimeters: st.perimeters,
    })),
  )
  if (!s.id || !s.summary || s.loading) return null
  const job = s.job && s.job.kind === 'build' && (s.job.status === 'queued' || s.job.status === 'running') ? s.job : null
  const building = job != null || s.manifest?.status === 'building' || s.summary.bundle_status === 'building'
  if (building)
    return (
      <div className="pfv-prep is-building" role="status" aria-live="polite">
        <p className="pfv-prep-text">
          {PREPARING}
          {job ? <span className="pfv-prep-step"> · {job.status === 'queued' ? 'queued' : job.step || 'running'}</span> : null}
        </p>
        <ProgressBar value={job && job.status === 'running' ? job.progress : null} tone="fire" label="Map data preparation" />
      </div>
    )
  if (s.manifest?.status === 'ready') {
    // prepared, but no agency perimeter: the burned-area estimate is not put in its place (decision a)
    if (newestPerimeter(s.perimeters?.perimeters)) return null
    return (
      <p className="pfv-prep is-note">
        <button type="button" className="mw-link-btn" onClick={() => applyView('command')}>
          {ESTIMATE_IN_COMMAND} ›
        </button>
      </p>
    )
  }
  if (!needsBuild(s)) return null
  const failed = buildFailed(s)
  const id = s.id
  return (
    <div className="pfv-prep">
      <p className="pfv-prep-text">{failed ? PREPARE_FAILED : NOT_PREPARED}</p>
      <button type="button" className="pfv-prep-btn" onClick={() => void openFire(id, 'prepare')}>
        {failed ? PREPARE_AGAIN_LABEL : PREPARE_LABEL}
      </button>
    </div>
  )
}

/** The official rows describe a past time once the panel time is this far before now (a past fire's replay). */
const PAST_VIEW_MS = 60 * 60_000

/** `more` (the desktop column, PublicFireChrome useFactsFit): rows are hidden below; the foot shows "More below", which
 *  scrolls them into view with `onMore`. */
export function FireFacts({ rowsOnly = false, peek = false, more = false, onMore }: { rowsOnly?: boolean; peek?: boolean; more?: boolean; onMore?: () => void } = {}) {
  const info = useOfficialNow()
  const panelMs = useOfficialPanelTime()
  const metric = useWorkspace((s) => s.units === 'metric')
  const { summary, demo } = useStore(useShallow((s) => ({ summary: s.summary && s.summary.id === s.incidentId ? s.summary : null, demo: isDemoBundle(s.incidentId, s.manifest) })))
  const tf = useTimeFormat()
  const nowMs = useNow(30_000)
  const local = useMemo(() => localAlertsLine(info.local, tf, panelMs, metric), [info.local, tf, panelMs, metric])
  // a past fire's official rows describe the panel time (PAST_VIEW_MS or more before now), not today
  const pastMs = nowMs - panelMs >= PAST_VIEW_MS ? panelMs : null
  const input = { summary, record: info.calfire, evacuation: info.evacuation, fireWeather: info.fireWeather, local, pastMs, demo, tf, nowMs }
  const rows = fireFacts(input)
  const src = factsSource(input)
  const shown = peek ? rows.filter((r) => r.key === 'burned' || r.key === 'contained') : rows
  const foot = (
    <div className="pfv-facts-foot">
      {more && onMore && (
        <button type="button" className="pfv-more" onClick={onMore} data-tip="More official facts below: scroll the list">
          More below <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      <p className="pfv-src">
        {src.badge === 'official' && <span className="pfv-badge">Official</span>}
        {src.badge === 'demo' && <span className="pfv-badge is-demo">Demo</span>}
        <span>{src.line}</span>
      </p>
      <p className="pfv-clear">
        {NOT_ALL_CLEAR}
        {src.link && (
          <>
            {' '}
            <a href={src.link.url} target="_blank" rel="noreferrer noopener">
              {src.link.label}
            </a>
          </>
        )}
      </p>
    </div>
  )
  return (
    <section className={`pfv-facts${peek ? ' is-peek' : ''}`} aria-label="Official information">
      <div className="pfv-facts-rows">
        {shown.map((r) =>
          r.key === 'reported' ? (
            // the row's shape (ui/shell/Readout.tsx) with its own copy wording
            <div key={r.key} className="ro-row ro-22 pfv-reported" data-tip="Where the incident was reported in the agency record. It is not necessarily where the fire started.">
              <span className="ro-value">{r.value}</span>
              <span className="ro-label">— {r.label}</span>
              {r.copy && <CopyCoords text={r.copy} />}
            </div>
          ) : (
            <ReadoutRow key={r.key} value={r.value} unit={r.unit} label={r.label} size={r.size} tone={r.tone} sub={r.sub || r.link ? <Sub r={r} /> : undefined} />
          ),
        )}
      </div>
      {!rowsOnly && !peek && <MapDataState />}
      {!rowsOnly && foot}
    </section>
  )
}
