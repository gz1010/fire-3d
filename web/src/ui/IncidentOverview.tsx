// Incident Overview card (SPEC 9.4): name, incident ID, location, start, end / containment, total acres, cause and
// analysis status. The CAL FIRE feed has no cause field, so "Cause" shows a value only when the summary carries one.
import { ExternalLink } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentManifest, IncidentSummary, JobStatus } from '../api/types'
import { fmtAcres, fmtLatLon } from '../lib/format'
import { fmtAt, fmtDuration, zoneAbbr } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { Card, Spinner } from './controls'
import { ContainmentBar } from './IncidentPicker'

function cause(s: IncidentSummary): string | null {
  const v = (s as unknown as Record<string, unknown>).cause ?? (s as unknown as Record<string, unknown>).fire_cause
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function AnalysisStatus({ summary, manifest, job }: { summary: IncidentSummary; manifest: IncidentManifest | null; job: JobStatus | null }) {
  const running = job != null && (job.status === 'queued' || job.status === 'running')
  if (running && job)
    return (
      <span className="status-line">
        <Spinner size={9} />
        <span>
          {job.kind === 'forecast' ? 'Forecast' : job.kind === 'build' ? 'Building' : 'Refreshing'} <span className="mono">{Math.round(job.progress * 100)}%</span>
        </span>
      </span>
    )
  const st = manifest?.status ?? (summary.bundle_status === 'none' ? null : summary.bundle_status)
  if (st === 'ready') {
    const n = manifest?.forecasts.filter((f) => f.status === 'ready').length ?? 0
    return (
      <span className="status-line">
        <i className="dot dot-ok" />
        <span>
          Replay ready · <span className="mono">{n}</span> forecast{n === 1 ? '' : 's'}
        </span>
      </span>
    )
  }
  if (st === 'building')
    return (
      <span className="status-line">
        <Spinner size={9} /> Building bundle
      </span>
    )
  if (st === 'error')
    return (
      <span className="status-line danger">
        <i className="dot dot-danger" /> Build failed
      </span>
    )
  return (
    <span className="status-line muted">
      <i className="dot" /> Not built
    </span>
  )
}

export function IncidentOverview() {
  const tf = useTimeFormat()
  const { summary, manifest, job } = useStore(useShallow((s) => ({ summary: s.summary, manifest: s.manifest, job: s.job })))
  if (!summary) return null
  const start = manifest?.ignition?.t_ms ?? summary.started_ms
  const contained = summary.contained_ms
  const live = summary.mode === 'live'
  const loc = [summary.location, summary.county ? `${summary.county} County` : null].filter(Boolean).join(', ')
  const mapped = manifest?.stats.final_acres_observed
  const c = cause(summary)
  return (
    <Card
      className="ov"
      title="Incident Overview"
      collapsible
      storageKey="overview"
      defaultOpen={typeof window === 'undefined' || window.innerHeight >= 960}
      aside={
        summary.url ? (
          <a className="card-link" href={summary.url} target="_blank" rel="noreferrer" data-tip="Open the CAL FIRE incident page">
            CAL FIRE <ExternalLink size={11} />
          </a>
        ) : undefined
      }
    >
      <dl className="kv ov-kv">
        <dt>Incident</dt>
        <dd className="ov-name ellipsis">{summary.name}</dd>
        <dt>Incident ID</dt>
        <dd className="mono ellipsis" data-tip={`CAL FIRE UID ${summary.calfire_uid}`}>
          {summary.id}
        </dd>
        <dt>Location</dt>
        <dd className="ellipsis" data-tip={`${loc} · ${fmtLatLon(summary.lat, summary.lon, 4)}`}>
          {loc || fmtLatLon(summary.lat, summary.lon, 3)}
        </dd>
        <dt>{manifest?.ignition ? 'Start (est.)' : 'Start'}</dt>
        <dd className="mono">
          {fmtAt(start, tf, { year: 'always' })} <span className="muted">{zoneAbbr(start, tf.tz)}</span>
        </dd>
        <dt>{live ? 'Containment' : 'Contained'}</dt>
        <dd className="mono">
          {live ? (
            <ContainmentBar pct={summary.percent_contained} />
          ) : contained ? (
            <>
              {fmtAt(contained, tf, { year: 'always' })} <span className="muted">· {fmtDuration(contained - start)}</span>
            </>
          ) : (
            <span className="muted">not reported</span>
          )}
        </dd>
        <dt>Total acres</dt>
        <dd className="mono">
          <span className="gold-strong">{fmtAcres(summary.acres)}</span>
          {mapped != null && summary.acres != null && Math.abs(mapped - summary.acres) / Math.max(1, summary.acres) > 0.02 && (
            <span className="muted" data-tip="Burned area mapped in this bundle (perimeters + detections)">
              {' '}
              · {fmtAcres(mapped)} mapped
            </span>
          )}
        </dd>
        <dt>Cause</dt>
        <dd className={c ? '' : 'muted'} data-tip={c ? undefined : 'The CAL FIRE incident feed does not report a cause'}>
          {c ?? 'Not reported'}
        </dd>
        <dt>Analysis</dt>
        <dd>
          <AnalysisStatus summary={summary} manifest={manifest} job={job} />
        </dd>
      </dl>
    </Card>
  )
}
