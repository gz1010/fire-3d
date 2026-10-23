// Fire card (owner: us-web; brief 2 O-R6 / I3, CONTRACT §13 shell; brief 3 §14.4, §14.5): opens when a fire is clicked
// on the overview map, in the overview list, or on its own marker or label inside a fire (useWorkspace.fireCardId). It
// shows the agency's official record from the list summary only (no official fetch): CAL FIRE in California, NIFC
// WFIGS elsewhere, labelled by `recordIssuerLabel` and split into one block per agency when they disagree on whether the
// fire is active (`recordBlocks`, round 3 item 2); a CAL FIRE complex keeps CAL FIRE's heading and numbers and names its
// NIFC WFIGS member fires, each linked to its own record (round 3 item 3). Times are in the fire's own zone with the
// preset's clock. Below the record, outside it (model information, never the agency's), the per-region accuracy label of
// the experimental model (§14.4: words in Public with "How was it tested?", the score in Command) and the model note.
// "Prepare analysis (1-3 min)" is the only thing that starts a build. Model output never appears in the record.
import { Box, ChevronDown, ExternalLink, Hammer, LocateFixed, Map as MapIcon, Play, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordBlocks, recordIssuerLabel } from '../../api/records'
import type { IncidentSummary } from '../../api/types'
import { NWCG_AGENCY_CREDIT } from '../../lib/dataCredits'
import { fmtAcres, fmtNumber } from '../../lib/format'
import { accuracyLabel, type AccuracyLabel } from '../../lib/plainLanguage'
import { agencyIdLine, agencyNameShown, complexMembers, isHttps as https, partOfComplex, recordBlockText, recordStatus } from '../../lib/recordText'
import { fmtAt, fmtDayDate, fmtRelative, localYear, recordYearMode, type TimeFmt } from '../../lib/time'
import { findRegion, useAccuracyRegions } from '../../state/accuracy'
import { analysisReadyText, analysisState, findFire, fireWhere, isActiveFire, type AnalysisState } from '../../state/overview'
import { useStore } from '../../state/store'
import { useTimeFormatFor } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { Spinner } from '../controls'
import { useNow } from '../hooks'
import { openFire } from './fireActions'
import { useDrawerFocus } from './hooks'

const mapCanvas = () => document.querySelector<HTMLElement>('.mw-map canvas')

/** The analysis state of the card's fire: the open fire's live manifest and job win over the list's chip. `modelRuns`:
 *  the open fire's experimental model runs (null when the card's fire is not the open one with a ready bundle). */
function useAnalysis(fire: IncidentSummary | null): { state: AnalysisState; progress: number | null; modelRuns: number | null } {
  const cur = useStore(
    useShallow((s) => ({
      id: s.incidentId,
      manifest: s.manifest?.status ?? null,
      modelRuns: s.manifest?.status === 'ready' && s.manifest.id === s.incidentId ? (s.manifest.forecasts?.length ?? 0) : null,
      jobRunning: s.job != null && s.job.kind === 'build' && (s.job.status === 'queued' || s.job.status === 'running'),
      jobFailed: s.job != null && s.job.kind === 'build' && s.job.status === 'error',
      progress: s.job?.kind === 'build' ? s.job.progress : null,
    })),
  )
  if (!fire) return { state: 'none', progress: null, modelRuns: null }
  if (cur.id !== fire.id) return { state: analysisState(fire), progress: null, modelRuns: null }
  if (cur.manifest === 'ready') return { state: 'ready', progress: null, modelRuns: cur.modelRuns }
  if (cur.jobRunning || cur.manifest === 'building' || fire.bundle_status === 'building') return { state: 'building', progress: cur.progress, modelRuns: null }
  if (cur.jobFailed || cur.manifest === 'error' || fire.bundle_status === 'error') return { state: 'error', progress: null, modelRuns: null }
  return { state: analysisState(fire) === 'ready' ? 'ready' : 'none', progress: null, modelRuns: null }
}

function modeChip(f: IncidentSummary): { label: string; cls: string } {
  return isActiveFire(f) ? { label: 'Active', cls: 'is-live' } : { label: String(f.year), cls: 'is-year' }
}

/** The agency's official record (§14.5): heading, numbers, its own status, update time in the fire's zone, link; one
 *  block per agency when they disagree; a complex's members. Only the record's own values: nothing from the model and
 *  nothing from another agency's record (the Timber Fire: CAL FIRE's section never says "Active" when only NIFC does). */
export function OfficialRecord({ fire, nowMs, tf }: { fire: IncidentSummary; nowMs: number; tf: TimeFmt }) {
  // this agency's own status and wording, never the merged listing's (the title's chip says whether Fire-3d lists the
  // fire as active, which it does when either agency does; round 3 item 2, the Timber Fire)
  const status = recordStatus(fire)
  const active = status.ownActive
  const issuer = recordIssuerLabel(fire)
  const blocks = recordBlocks(fire)
  const disagree = blocks.length > 1
  const updated = fire.updated_ms
  // years on every record time when any differs from the fire's year or today's (review UX-m1)
  const yearMode = recordYearMode([updated, fire.contained_ms], tf.tz, [fire.year, localYear(nowMs, tf.tz)])
  const members = complexMembers(fire)
  const idLine = agencyIdLine(fire)
  const wfigs = (fire.record_source ?? 'calfire') === 'wfigs'
  return (
    <section className="fc-official" aria-label={`${issuer} official record`}>
      <p className="fc-source">
        <span className="mw-tag is-official">Official</span>
        <span>{issuer} incident record</span>
      </p>
      <dl className="fc-facts">
        <div>
          <dt>Size</dt>
          <dd className="mw-mono">{fmtAcres(fire.acres)}</dd>
        </div>
        <div>
          <dt>Containment</dt>
          <dd className="mw-mono">{fire.percent_contained != null ? `${fmtNumber(fire.percent_contained)}%` : 'Not given'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className={`fc-status is-${status.key}`}>{status.label}</dd>
        </div>
      </dl>
      <p className="fc-updated">
        {updated != null ? (
          active ? (
            <>
              Updated by {issuer} <span className="mw-mono">{fmtAt(updated, tf, { zone: true, year: yearMode })}</span> ({fmtRelative(updated, nowMs)})
            </>
          ) : (
            <>
              {issuer} record last edited <span className="mw-mono">{fmtAt(updated, tf, { zone: true, year: yearMode })}</span>
              {fire.contained_ms != null && (
                <>
                  {' '}
                  · contained <span className="mw-mono">{fmtDayDate(fire.contained_ms, tf.tz, { year: 'always' })}</span>
                </>
              )}
            </>
          )
        ) : (
          `${issuer} gives no update time for this record.`
        )}
      </p>
      {disagree && (
        <div className="fc-records">
          <p className="fc-records-head">The agencies' records differ on whether the fire is active; each is shown as published:</p>
          <ul>
            {blocks.map((b, i) => (
              <li key={`${b.source}-${i}`} className={b.is_active ? 'is-active' : undefined}>
                {b.name && <span className="fc-record-name">{b.name}: </span>}
                {recordBlockText(b, tf, nowMs)}
                {https(b.url) && (
                  <>
                    {' '}
                    <a className="fc-link is-inline" href={b.url} target="_blank" rel="noopener noreferrer">
                      Record <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {members.length > 0 && (
        <p className="fc-members">
          Includes (NIFC WFIGS names):{' '}
          {members.map((m, i) => (
            <span key={`${m.name}-${i}`}>
              {i > 0 && ', '}
              {m.url ? (
                <a className="fc-link is-inline" href={m.url} target="_blank" rel="noopener noreferrer">
                  {m.name}
                </a>
              ) : (
                m.name
              )}
            </span>
          ))}
        </p>
      )}
      {https(fire.url) && (
        <a className="fc-link" href={fire.url} target="_blank" rel="noopener noreferrer">
          {wfigs ? 'NIFC WFIGS record' : `${issuer} incident page`} <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
      {idLine && <p className="fc-id mw-mono">{idLine}</p>}
      {agencyNameShown(fire) && <p className="fc-credit">{NWCG_AGENCY_CREDIT}</p>}
    </section>
  )
}

/** The accuracy label (§14.4) of the card's fire: model information, outside the official record. Public: the words
 *  and "How was it tested?"; Command: the score line. */
export function AccuracyNote({ label, command, loadFailed }: { label: AccuracyLabel | null; command: boolean; loadFailed?: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!label)
    return (
      <div className="fc-accuracy" aria-label="Model accuracy in this region">
        <p className="fc-accuracy-line">{loadFailed ? 'The accuracy of the model in this region could not be loaded right now.' : 'Loading the accuracy of the model in this region…'}</p>
        <p className="fc-accuracy-always">Outside the modeled area is unknown, not low.</p>
      </div>
    )
  return (
    <div className="fc-accuracy" aria-label="Model accuracy in this region">
      <p className="fc-accuracy-line">
        <span className="mw-tag is-model">Model</span> {command ? label.commandLine : label.publicLine}
      </p>
      {label.fuelCaveat && <p className="fc-accuracy-sub">{label.fuelCaveat}</p>}
      {!command && label.publicDetail && (
        <>
          <button type="button" className="mw-link-btn fc-accuracy-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
            How was it tested? <ChevronDown size={12} aria-hidden="true" className={open ? 'is-open' : undefined} />
          </button>
          {open && (
            <p id={id} className="fc-accuracy-sub">
              {label.publicDetail}
            </p>
          )}
        </>
      )}
      <p className="fc-accuracy-always">{label.always}</p>
    </div>
  )
}

/** The accuracy label of a fire, from the regional file (loaded once). */
function useAccuracyLabel(fire: IncidentSummary | null): { label: AccuracyLabel | null; failed: boolean } {
  const { status, data } = useAccuracyRegions()
  if (!fire) return { label: null, failed: false }
  if (status === 'error') return { label: null, failed: true }
  if (status !== 'ok' || !data) return { label: null, failed: false }
  return { label: accuracyLabel(findRegion(data, fire.accuracy_region ?? null), data.method), failed: false }
}

function AnalysisLine({ state, progress, modelRuns }: { state: AnalysisState; progress: number | null; modelRuns: number | null }) {
  if (state === 'ready')
    return (
      <p className="fc-analysis is-ready">
        <i className="fc-dot" aria-hidden="true" /> {analysisReadyText(modelRuns)}
      </p>
    )
  if (state === 'building')
    return (
      <p className="fc-analysis is-building" role="status">
        <Spinner size={11} /> Preparing the analysis{progress != null ? ` · ${Math.round(progress * 100)}%` : '…'}
      </p>
    )
  return (
    <div className={`fc-analysis is-${state}`}>
      <p>{state === 'error' ? 'The last preparation of the analysis failed.' : 'Fire-3d has not prepared an analysis of this fire yet.'}</p>
      <p className="fc-analysis-note">Preparing downloads terrain, fuels, satellite detections and weather from public services and takes about 1-3 minutes.</p>
    </div>
  )
}

export function FireCard() {
  const id = useWorkspace((s) => s.fireCardId)
  const fire = useStore((s) => findFire(id, s.summary, s.catalog))
  const catalogLoading = useStore((s) => s.catalog.loading)
  const currentId = useStore((s) => s.incidentId)
  const { state, progress, modelRuns } = useAnalysis(fire)
  const command = useWorkspace((s) => s.preset === 'command')
  const accuracy = useAccuracyLabel(fire)
  const nowMs = useNow(30_000)
  // the card's fire may not be the open one: its times are in its own zone (§14.9.1)
  const tf = useTimeFormatFor(fire?.time_zone)
  const heading = useRef<HTMLHeadingElement | null>(null)
  const close = () => useWorkspace.getState().setFireCard(null)
  // non-modal: focus moves to the heading when the card opens and back to its opener (a list row) when it closes, or to
  // the map when the opener is gone (a row's flight focused the fire and the list gave way to its updates)
  useDrawerFocus(id != null, heading, undefined, mapCanvas)

  if (!id) return null
  if (!fire)
    return (
      <section className="mw-panel fc-card" aria-label="Fire" data-drawer="firecard">
        <header className="fc-head">
          <h2 className="fc-title" ref={heading} tabIndex={-1}>
            {catalogLoading ? 'Loading the fire…' : 'Fire not listed'}
          </h2>
          <button type="button" className="mw-icon-btn" aria-label="Close the fire card" onClick={close}>
            <X size={15} />
          </button>
        </header>
        {!catalogLoading && <p className="fc-empty">The current fire lists (CAL FIRE and NIFC) do not include this fire.</p>}
      </section>
    )

  const isCurrent = fire.id === currentId
  const chip = modeChip(fire)
  const where = [fireWhere(fire), fire.county ? fire.location : null].filter(Boolean).join(' · ')
  const ready = state === 'ready'
  return (
    <section className="mw-panel fc-card" aria-labelledby="fc-title" data-fire={fire.id} data-drawer="firecard">
      <header className="fc-head">
        <div className="fc-titles">
          <h2 id="fc-title" className="fc-title" ref={heading} tabIndex={-1}>
            {fire.name}
          </h2>
          <p className="fc-sub">
            <span className={`fc-chip ${chip.cls}`}>{chip.label}</span>
            {where && <span className="fc-where">{where}</span>}
            <span className="fc-started">Started {fmtDayDate(fire.started_ms, tf.tz, { year: 'always' })}</span>
          </p>
          {fire.complex_name && <p className="fc-complex">{partOfComplex(fire.complex_name)}</p>}
        </div>
        <button type="button" className="mw-icon-btn" aria-label="Close the fire card" data-tip="Close (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </header>
      <OfficialRecord fire={fire} nowMs={nowMs} tf={tf} />
      <AnalysisLine state={state} progress={progress} modelRuns={modelRuns} />
      <div className="fc-actions">
        {!isCurrent && ready && (
          <button type="button" className="mw-btn is-primary fc-main" onClick={() => void openFire(fire.id)}>
            <MapIcon size={14} /> Open this fire
          </button>
        )}
        {(state === 'none' || state === 'error') && (
          <button type="button" className="mw-btn is-primary fc-main" onClick={() => void openFire(fire.id, 'prepare')}>
            <Hammer size={14} /> {state === 'error' ? 'Prepare analysis again (1-3 min)' : 'Prepare analysis (1-3 min)'}
          </button>
        )}
        {state === 'building' && !isCurrent && (
          <button type="button" className="mw-btn is-primary fc-main" onClick={() => void openFire(fire.id)}>
            <MapIcon size={14} /> Follow the preparation
          </button>
        )}
        {ready && (
          <button type="button" className="mw-btn" onClick={() => void openFire(fire.id, 'play')}>
            <Play size={13} /> Play spread
          </button>
        )}
        <button type="button" className="mw-btn" onClick={() => void openFire(fire.id, 'check')}>
          <LocateFixed size={13} /> Check a location
        </button>
        {ready && (
          <button type="button" className="mw-btn" onClick={() => void openFire(fire.id, '3d')}>
            <Box size={13} /> Open in 3D
          </button>
        )}
      </div>
      {!ready && <p className="fc-hint">Play spread and the 3D view need the analysis. Official information and address checks work without it.</p>}
      <AccuracyNote label={accuracy.label} command={command} loadFailed={accuracy.failed} />
      <p className="fc-note">Fire-3d's model output is experimental and is not an evacuation order. Follow local officials.</p>
    </section>
  )
}
