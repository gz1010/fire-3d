// Analysis tab (SPEC 9.4): forecast runner (start = timeline time for historical, now for live; horizon 24/48/72 h;
// ensemble Auto / GFS 31 / ECMWF 51 / Perturbed / None) with job progress, the run list, the selected run's p50 area
// at +24/48/72 h with the p10–p90 range, the hindcast skill table and the disclaimer.
import { AlertTriangle, CircleSlash, Flame, Info, Play } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { EnsembleKind, EnsembleRequest, ForecastManifest, ForecastSummary, IncidentManifest, JobStatus } from '../api/types'
import { fmtAcres, fmtNumber } from '../lib/format'
import { HOUR_MS, fmtAt, fmtDuration, fmtRelative, fmtTPlus } from '../lib/time'
import { forecastAtLead, observedAreaAt } from '../state/selectors'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { EmptyNote, ProgressBar, Section, Segmented, Spinner } from './controls'
import { useNow } from './hooks'
import { ENSEMBLE_LABEL, ENSEMBLE_SHORT } from './options'
import { toast } from './toast'
import { RegionAccuracy } from './RegionAccuracy'

const HORIZONS = [24, 48, 72]

const isRunning = (j: JobStatus | null) => j != null && (j.status === 'queued' || j.status === 'running')

export function AnalysisTab() {
  const { manifest, forecast, job } = useStore(useShallow((s) => ({ manifest: s.manifest, forecast: s.forecast, job: s.job })))
  if (!manifest || manifest.status !== 'ready')
    return (
      <div className="tab-pad">
        <EmptyNote icon={<Info size={16} />} title="No bundle yet">
          Forecasts run on a built incident bundle. Select an incident and build it first.
        </EmptyNote>
        <Disclaimer />
      </div>
    )
  return (
    <div className="tab-pad analysis">
      <Runner key={manifest.id} manifest={manifest} job={job} />
      <RunList manifest={manifest} />
      {forecast && <RunSummary manifest={manifest} forecast={forecast} />}
      {forecast?.skill && forecast.skill.length > 0 && <SkillTable skill={forecast.skill} />}
      <RegionAccuracy />
      <Disclaimer />
    </div>
  )
}

export function Disclaimer() {
  return (
    <p className="disclaimer">
      <AlertTriangle size={12} />
      <span>
        <strong>Research prototype — not for operational use.</strong> Forecasts come from a physics model (Rothermel + level set) driven by
        coarse weather; they do not simulate suppression and simplify spotting.
      </span>
    </p>
  )
}

function Runner({ manifest, job }: { manifest: IncidentManifest; job: JobStatus | null }) {
  const tf = useTimeFormat()
  const live = manifest.mode === 'live'
  const [horizon, setHorizon] = useState(72)
  const [ensemble, setEnsemble] = useState<EnsembleRequest>('auto')
  // start time: live = latest observation; historical = timeline time floored to the hour (re-renders hourly)
  const startHour = useStore((s) => Math.floor(s.timeMs / HOUR_MS) * HOUR_MS)
  const tr = manifest.time_range
  const lo = Math.max(tr.start_ms, manifest.ignition?.t_ms ?? tr.start_ms)
  const startMs = live ? tr.now_ms : Math.min(Math.max(startHour, Math.floor(lo / HOUR_MS) * HOUR_MS), tr.end_ms)
  const beforeIgnition = !live && manifest.ignition != null && startHour < manifest.ignition.t_ms
  const running = isRunning(job)
  const fcJob = job?.kind === 'forecast' ? job : null
  const ensOptions = [
    { value: 'auto' as const, label: 'Auto', tip: live ? 'Live: GFS 0.25° (31 members)' : 'Historical: perturbed HRRR (31 members)' },
    { value: 'gfs025' as const, label: 'GFS 31', disabled: !live, tip: live ? 'GFS 0.25° ensemble, 31 members' : 'Open-Meteo ensembles cover only the last ~90 days' },
    { value: 'ecmwf_ifs025' as const, label: 'ECMWF 51', disabled: !live, tip: live ? 'ECMWF IFS 0.25° ensemble, 51 members' : 'Open-Meteo ensembles cover only the last ~90 days' },
    { value: 'perturbed' as const, label: 'Perturbed', tip: '31 members: AR(1) perturbations of wind, RH and temperature' },
    { value: 'none' as const, label: 'None', tip: 'Single deterministic run' },
  ]
  const resolved: EnsembleKind = ensemble === 'auto' ? (live ? 'gfs025' : 'perturbed') : ensemble
  const members = resolved === 'gfs025' ? 31 : resolved === 'ecmwf_ifs025' ? 51 : resolved === 'perturbed' ? 31 : 1
  const run = async () => {
    const j = await useStore.getState().startForecast({ horizon_h: horizon, ensemble, ...(live ? {} : { start_ms: startMs }) })
    if (j) toast(`${live ? 'Forecast' : 'Hindcast'} queued · ${horizon} h · ${ENSEMBLE_SHORT[resolved]}`, 'info')
  }
  return (
    <Section title={live ? 'Run forecast' : 'Run hindcast'} aside={<span className={`chip ${live ? 'chip-live' : 'chip-gold'}`}>{live ? 'from now' : 'from timeline'}</span>}>
      <div className="runner">
        <div className="runner-row">
          <span className="label">Start</span>
          <span className="runner-start">
            <span className="mono gold">
              {fmtAt(startMs, tf, { zone: true })}
            </span>
            {manifest.ignition && <span className="mono muted">{fmtTPlus((startMs - manifest.ignition.t_ms) / HOUR_MS)}</span>}
          </span>
        </div>
        {!live && <p className="runner-hint muted">{beforeIgnition ? 'Timeline is before ignition: the run starts at ignition.' : 'Scrub the timeline to choose the start; the run is scored against what actually burned.'}</p>}
        <div className="runner-row">
          <span className="label">Horizon</span>
          <Segmented size="sm" value={horizon} onChange={setHorizon} ariaLabel="Forecast horizon" options={HORIZONS.map((h) => ({ value: h, label: `${h} h` }))} />
        </div>
        <div className="runner-row runner-row-col">
          <span className="label">Ensemble</span>
          <Segmented size="sm" className="seg-fill" value={ensemble} onChange={setEnsemble} ariaLabel="Weather ensemble" options={ensOptions} />
          <span className="runner-ens muted">
            {ENSEMBLE_LABEL[resolved]} · <span className="mono">{members}</span> member{members > 1 ? 's' : ''}
          </span>
        </div>
        <button type="button" className="btn btn-solid runner-go" disabled={running} onClick={() => void run()}>
          {running && fcJob ? <Spinner size={12} /> : <Play size={13} />}
          {running ? (fcJob ? 'Forecast running…' : 'Bundle job running…') : `Run ${horizon} h ${live ? 'forecast' : 'hindcast'}`}
        </button>
        {fcJob && <JobProgress job={fcJob} />}
      </div>
    </Section>
  )
}

export function JobProgress({ job, compact }: { job: JobStatus; compact?: boolean }) {
  const now = useNow(1000)
  const running = isRunning(job)
  const elapsed = (job.finished_ms ?? now) - (job.started_ms ?? job.created_ms)
  const tone = job.status === 'error' ? 'danger' : job.kind === 'forecast' ? 'fire' : 'gold'
  return (
    <div className={`jobp ${compact ? 'is-compact' : ''} is-${job.status}`}>
      <div className="jobp-head">
        <span className="jobp-step">
          {running && <Spinner size={10} />}
          <span className="ellipsis">{job.status === 'queued' ? 'Queued' : job.status === 'done' ? 'Done' : job.status === 'error' ? 'Failed' : job.step || 'Running'}</span>
        </span>
        <span className="mono">{job.status === 'queued' ? '' : `${Math.round(job.progress * 100)}%`}</span>
        <span className="mono muted">{fmtDuration(Math.max(0, elapsed))}</span>
      </div>
      <ProgressBar value={job.status === 'queued' ? null : job.progress} tone={tone} label={`${job.kind} progress`} />
      {(job.error || job.message) && <div className={`jobp-msg ${job.status === 'error' ? 'danger' : 'muted'}`}>{job.error ?? job.message}</div>}
    </div>
  )
}

function RunList({ manifest }: { manifest: IncidentManifest }) {
  const selected = useStore((s) => s.forecastRunId)
  const now = useNow(30_000)
  const runs = manifest.forecasts
  return (
    <Section title="Runs" aside={<span className="mono muted">{runs.length}</span>}>
      {runs.length === 0 ? (
        <EmptyNote icon={<Flame size={15} />} title="No forecast runs yet">
          Run one above. Each run simulates every ensemble member and stores arrival-time quantiles.
        </EmptyNote>
      ) : (
        <div className="runs" role="radiogroup" aria-label="Forecast runs">
          {runs.map((r) => (
            <RunRow key={r.run_id} run={r} selected={r.run_id === selected} now={now} originIgn={manifest.ignition?.t_ms ?? null} />
          ))}
          <button type="button" role="radio" aria-checked={selected == null} className={`run run-none ${selected == null ? 'is-selected' : ''}`} onClick={() => void useStore.getState().selectForecast(null)}>
            <span className="run-radio" />
            <CircleSlash size={12} className="muted" />
            <span className="secondary">No forecast overlay</span>
          </button>
        </div>
      )}
    </Section>
  )
}

function RunRow({ run, selected, now, originIgn }: { run: ForecastSummary; selected: boolean; now: number; originIgn: number | null }) {
  const tf = useTimeFormat()
  const ready = run.status === 'ready'
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`run ${selected ? 'is-selected' : ''}`}
      disabled={!ready}
      onClick={() => void useStore.getState().selectForecast(run.run_id)}
      data-tip={`Issued ${fmtAt(run.issued_ms, tf, { zone: true })} (${fmtRelative(run.issued_ms, now)})`}
    >
      <span className="run-radio" />
      <span className="run-main">
        <span className="run-line">
          <span className="mono run-id">{run.run_id}</span>
          <span className="run-ens">
            {ENSEMBLE_SHORT[run.ensemble]} <span className="mono">×{run.members}</span>
          </span>
          <span className="mono run-h">{run.horizon_h} h</span>
        </span>
        <span className="run-sub mono">
          {fmtAt(run.start_ms, tf)}
          {originIgn != null && <span className="muted"> · {fmtTPlus((run.start_ms - originIgn) / HOUR_MS)}</span>}
        </span>
      </span>
      <span className={`chip ${run.status === 'ready' ? 'chip-ok' : run.status === 'running' ? 'chip-gold' : 'chip-danger'}`}>
        {run.status === 'running' && <Spinner size={8} />}
        {run.status}
      </span>
    </button>
  )
}

function RunSummary({ manifest, forecast }: { manifest: IncidentManifest; forecast: ForecastManifest }) {
  const tf = useTimeFormat()
  const timeseries = useStore((s) => s.timeseries)
  const base = observedAreaAt(timeseries, forecast.start_ms)
  const leads = HORIZONS.filter((h) => h <= forecast.horizon_h)
  const rows = leads.map((h) => ({ h, q: forecastAtLead(forecast, h) }))
  const maxHi = Math.max(1, ...rows.map((r) => r.q?.p90 ?? 0))
  const m = forecast.model
  return (
    <Section
      title={
        <>
          Selected run · <span className="mono run-id-inline">{forecast.run_id}</span>
        </>
      }
      aside={<span className="mono muted">{forecast.weather.members} members</span>}
    >
      <table className="qt">
        <thead>
          <tr>
            <th>Lead</th>
            <th className="r">P50 area</th>
            <th>P10–P90</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ h, q }) => (
            <tr key={h}>
              <td className="mono">+{h} h</td>
              <td className="mono r gold-strong">{q ? fmtAcres(q.p50) : '—'}</td>
              <td>
                {q ? (
                  <span className="qbar" data-tip={`P10 ${fmtAcres(q.p10)} · P50 ${fmtAcres(q.p50)} · P90 ${fmtAcres(q.p90)}`}>
                    <span className="qbar-track">
                      <i className="qbar-range" style={{ left: `${(q.p10 / maxHi) * 100}%`, width: `${Math.max(1, ((q.p90 - q.p10) / maxHi) * 100)}%` }} />
                      <i className="qbar-mid" style={{ left: `${(q.p50 / maxHi) * 100}%` }} />
                    </span>
                    <span className="mono qbar-txt">
                      {fmtNumber(q.p10)}–{fmtNumber(q.p90)}
                    </span>
                  </span>
                ) : (
                  <span className="muted">beyond horizon</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv kv-tight">
        <dt>Start area</dt>
        <dd className="mono">{base != null ? fmtAcres(base) : '—'} <span className="muted">observed</span></dd>
        <dt>Weather</dt>
        <dd className="ellipsis" data-tip={forecast.weather.source}>
          {ENSEMBLE_LABEL[forecast.weather.ensemble]} <span className="muted mono">· {forecast.weather.source}</span>
        </dd>
        <dt>Model</dt>
        <dd className="mono">
          {m.engine} {m.version} · {m.surface_lw_ratio_model}
        </dd>
        <dt>Physics</dt>
        <dd className="mono">
          crown {m.crown ? 'on' : 'off'} · spotting {m.spotting ? 'on' : 'off'} · adj ×{fmtNumber(m.spread_adjustment, 2)}
        </dd>
        <dt>Grid</dt>
        <dd className="mono">
          {fmtNumber(m.grid_res_m)} m · runtime {forecast.runtime_s < 90 ? `${fmtNumber(forecast.runtime_s, forecast.runtime_s < 10 ? 1 : 0)} s` : fmtDuration(forecast.runtime_s * 1000)}
        </dd>
        <dt>Window</dt>
        <dd className="mono">
          {fmtAt(forecast.start_ms, tf)} → {fmtAt(forecast.start_ms + forecast.horizon_h * HOUR_MS, tf)}
        </dd>
      </dl>
      {forecast.warnings.length > 0 && (
        <ul className="warn-list">
          {forecast.warnings.map((w, i) => (
            <li key={i}>
              <AlertTriangle size={11} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
      {manifest.mode === 'historical' && !forecast.skill?.length && <p className="muted small">No skill scores: the observed record ends before the first lead time.</p>}
    </Section>
  )
}

/** The per-run skill table (brief 3, V-R13, CONTRACT §14.4): the growth score first when the run has it (the new spread
 *  only), the total relabelled as total-area overlap (it includes the area already burned at the start: said in the
 *  header, or in a note under the table when the growth column makes the header short), and no green / amber / red
 *  tone (a colour would read as a verdict on the model). */
export function SkillTable({ skill }: { skill: NonNullable<ForecastManifest['skill']> }) {
  const growth = skill.some((k) => typeof k.growth_sorensen === 'number')
  return (
    <Section
      title="Hindcast skill"
      aside={
        <span
          className="muted small"
          data-tip="Sørensen = 2|F∩O| / (|F|+|O|). Growth: the new spread after the start only (forecast P50 vs observed). Total-area overlap: the whole burned area, including what had already burned at the start."
        >
          Sørensen <Info size={11} />
        </span>
      }
    >
      <table className="qt skill">
        <thead>
          <tr>
            <th>Lead</th>
            {growth && <th>Growth</th>}
            <th>{growth ? 'Total-area overlap' : 'Total-area overlap (includes the area already burned at the start)'}</th>
            <th className="r">Observed</th>
            <th className="r">P50</th>
            <th className="r">Bias</th>
          </tr>
        </thead>
        <tbody>
          {skill.map((k) => {
            const bias = k.observed_acres > 0 ? ((k.forecast_acres_p50 - k.observed_acres) / k.observed_acres) * 100 : null
            const g = typeof k.growth_sorensen === 'number' && Number.isFinite(k.growth_sorensen) ? k.growth_sorensen : null
            return (
              <tr key={k.lead_h}>
                <td className="mono">+{k.lead_h} h</td>
                {growth && (
                  <td>
                    {g != null ? (
                      <span className="sbar">
                        <span className="sbar-track">
                          <i className="sbar-fill tone-neutral" style={{ width: `${Math.max(0, Math.min(1, g)) * 100}%` }} />
                        </span>
                        <span className="mono">{g.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="muted mono">—</span>
                    )}
                  </td>
                )}
                <td>
                  <span className="sbar">
                    <span className="sbar-track">
                      <i className="sbar-fill tone-neutral" style={{ width: `${Math.max(0, Math.min(1, k.sorensen)) * 100}%` }} />
                    </span>
                    <span className="mono secondary">{k.sorensen.toFixed(2)}</span>
                  </span>
                </td>
                <td className="mono r">{fmtNumber(k.observed_acres)}</td>
                <td className="mono r">{fmtNumber(k.forecast_acres_p50)}</td>
                <td className="mono r secondary">{bias == null ? '—' : `${bias > 0 ? '+' : bias < 0 ? '−' : '±'}${fmtNumber(Math.abs(bias))}%`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {growth ? (
        <p className="muted small">Growth scores only the new spread after the start. Total-area overlap includes the area already burned at the start.</p>
      ) : (
        <p className="muted small">The growth score (new spread only) is not stored for this run.</p>
      )}
      <p className="muted small">Scored against the reconstructed observed arrival time (acres).</p>
    </Section>
  )
}
