// Fire card (owner: shell; brief 2 O-R6 / I3, CONTRACT §13 shell): opens when a fire is clicked on the overview map,
// in the overview list, or on its own marker or label inside a fire (useWorkspace.fireCardId). It shows CAL FIRE's
// official record (acres, containment, status, CAL FIRE's update time, incident page) and whether Fire-3d's analysis
// exists. "Prepare analysis (1-3 min)" is the only thing that starts a build. Model output never appears here.
import { Box, ExternalLink, Hammer, LocateFixed, Map as MapIcon, Play, X } from 'lucide-react'
import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentSummary } from '../../api/types'
import { fmtAcres, fmtNumber } from '../../lib/format'
import { fmtDayDate, fmtRelative } from '../../lib/time'
import { analysisState, findFire, fireStatus, isActiveFire, type AnalysisState } from '../../state/overview'
import { useStore } from '../../state/store'
import { useTimeFormatFor } from '../../state/timeZone'
import { useWorkspace } from '../../state/workspace'
import { Spinner } from '../controls'
import { useNow } from '../hooks'
import { fmtStatusTime } from './dataStatus'
import { openFire } from './fireActions'
import { useDrawerFocus } from './hooks'

const mapCanvas = () => document.querySelector<HTMLElement>('.mw-map canvas')

/** The analysis state of the card's fire: the open fire's live manifest and job win over the list's chip. */
function useAnalysis(fire: IncidentSummary | null): { state: AnalysisState; progress: number | null } {
  const cur = useStore(
    useShallow((s) => ({
      id: s.incidentId,
      manifest: s.manifest?.status ?? null,
      jobRunning: s.job != null && s.job.kind === 'build' && (s.job.status === 'queued' || s.job.status === 'running'),
      jobFailed: s.job != null && s.job.kind === 'build' && s.job.status === 'error',
      progress: s.job?.kind === 'build' ? s.job.progress : null,
    })),
  )
  if (!fire) return { state: 'none', progress: null }
  if (cur.id !== fire.id) return { state: analysisState(fire), progress: null }
  if (cur.manifest === 'ready') return { state: 'ready', progress: null }
  if (cur.jobRunning || cur.manifest === 'building' || fire.bundle_status === 'building') return { state: 'building', progress: cur.progress }
  if (cur.jobFailed || cur.manifest === 'error' || fire.bundle_status === 'error') return { state: 'error', progress: null }
  return { state: analysisState(fire) === 'ready' ? 'ready' : 'none', progress: null }
}

function modeChip(f: IncidentSummary): { label: string; cls: string } {
  return isActiveFire(f) ? { label: 'Active', cls: 'is-live' } : { label: String(f.year), cls: 'is-year' }
}

function OfficialRecord({ fire, nowMs }: { fire: IncidentSummary; nowMs: number }) {
  const tf = useTimeFormatFor(fire.time_zone)
  const status = fireStatus(fire)
  const active = isActiveFire(fire)
  const updated = fire.updated_ms
  return (
    <section className="fc-official" aria-label="CAL FIRE official record">
      <p className="fc-source">
        <span className="mw-tag is-official">Official</span>
        <span>CAL FIRE incident record</span>
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
              Updated by CAL FIRE <span className="mw-mono">{fmtStatusTime(updated, nowMs)}</span> ({fmtRelative(updated, nowMs)})
            </>
          ) : (
            <>
              CAL FIRE record last edited <span className="mw-mono">{fmtStatusTime(updated, nowMs)}</span>
              {fire.contained_ms != null && (
                <>
                  {' '}
                  · contained <span className="mw-mono">{fmtDayDate(fire.contained_ms, tf.tz, { year: 'always' })}</span>
                </>
              )}
            </>
          )
        ) : (
          'CAL FIRE gives no update time for this record.'
        )}
      </p>
      {fire.url && /^https:\/\//.test(fire.url) && (
        <a className="fc-link" href={fire.url} target="_blank" rel="noopener noreferrer">
          CAL FIRE incident page <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </section>
  )
}

function AnalysisLine({ state, progress }: { state: AnalysisState; progress: number | null }) {
  if (state === 'ready')
    return (
      <p className="fc-analysis is-ready">
        <i className="fc-dot" aria-hidden="true" /> Analysis ready: spread reconstruction and the experimental model
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
  const { state, progress } = useAnalysis(fire)
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
        {!catalogLoading && <p className="fc-empty">CAL FIRE's current lists do not include this fire.</p>}
      </section>
    )

  const isCurrent = fire.id === currentId
  const chip = modeChip(fire)
  const where = [fire.county ? `${fire.county} County` : null, fire.location].filter(Boolean).join(' · ')
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
        </div>
        <button type="button" className="mw-icon-btn" aria-label="Close the fire card" data-tip="Close (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </header>
      <OfficialRecord fire={fire} nowMs={nowMs} />
      <AnalysisLine state={state} progress={progress} />
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
      <p className="fc-note">Fire-3d's model output is experimental and is not an evacuation order. Follow local officials.</p>
    </section>
  )
}
