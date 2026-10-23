// Overlays (SPEC 9.4): bundle build progress (step, %, message), empty states (no live fires; bundle not built ->
// Build button), errors with retry, the forecast progress pill, toasts, and an error boundary for the 3D scene.
import { AlertTriangle, Check, Flame, Hammer, Info, RefreshCw, X } from 'lucide-react'
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { JobStatus } from '../api/types'
import { fmtAcres } from '../lib/format'
import { fmtDayDate } from '../lib/time'
import { listHealth, noLiveText } from '../state/overview'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { CornerMarks, ProgressBar, Spinner } from './controls'
import { JobProgress } from './AnalysisTab'
import { useToasts } from './toast'

const running = (j: JobStatus | null) => j != null && (j.status === 'queued' || j.status === 'running')

/** Centre-of-canvas status card: loading, building, not built, build failed, nothing to show. */
export function StatusOverlay() {
  const s = useStore(
    useShallow((st) => ({
      id: st.incidentId,
      summary: st.summary,
      manifest: st.manifest,
      job: st.job,
      loading: st.incidentLoading,
      error: st.incidentError,
      autoBuild: st.autoBuild,
      catalogLoading: st.catalog.loading,
      catalogError: st.catalog.error,
      nCatalog: st.catalog.live.length + st.catalog.historical.length,
    })),
  )
  let card: ReactNode = null
  const name = s.summary?.name ?? s.id ?? 'incident'
  const ready = s.manifest?.status === 'ready'
  if (!s.id) {
    if (s.catalogLoading) card = <LoadingCard text="Loading the fire lists…" />
    else if (s.catalogError) card = <CatalogErrorCard error={s.catalogError} />
    else if (s.nCatalog === 0) card = <NothingCard />
  } else if (ready) {
    card = null
  } else if (s.job && s.job.kind === 'build' && running(s.job)) {
    card = <BuildCard name={name} job={s.job} />
  } else if (s.manifest?.status === 'building' || s.summary?.bundle_status === 'building') {
    card = <BuildCard name={name} job={null} />
  } else if (s.loading) {
    card = <LoadingCard text={`Loading ${name}…`} />
  } else if (s.manifest?.status === 'error' || s.summary?.bundle_status === 'error' || (s.job?.kind === 'build' && s.job.status === 'error')) {
    card = <BuildFailedCard name={name} message={s.job?.error ?? s.manifest?.warnings.at(-1) ?? null} />
  } else if (s.summary && !s.manifest && !s.error) {
    card = <NotBuiltCard name={name} acres={s.summary.acres} started={s.summary.started_ms} autoBuild={s.autoBuild} />
  }
  if (!card) return null
  return <div className="center-overlay">{card}</div>
}

function LoadingCard({ text }: { text: string }) {
  return (
    <div className="ov-card glass is-compact">
      <Spinner size={14} />
      <span className="secondary">{text}</span>
    </div>
  )
}

/** Build progress with a trail of the steps seen so far (step names come from the server). */
function BuildCard({ name, job }: { name: string; job: JobStatus | null }) {
  const [steps, setSteps] = useState<string[]>([])
  const last = useRef<string | null>(null)
  useEffect(() => {
    const step = job?.step
    if (!step || step === last.current || step === 'queued' || step === 'done') return
    last.current = step
    setSteps((s) => (s.includes(step) ? s : [...s, step]))
  }, [job?.step])
  return (
    <div className="ov-card glass build-card" role="status" aria-live="polite">
      <CornerMarks />
      <div className="ov-eyebrow eyebrow">Preparing the analysis</div>
      <div className="ov-title">{name}</div>
      <p className="ov-text secondary">
        Downloading elevation (USGS 3DEP), aerial photos (NAIP), vegetation fuels (LANDFIRE), satellite heat detections (NASA FIRMS), mapped perimeters (NIFC) and weather, then
        reconstructing how the fire spread. This takes about 1-3 minutes.
      </p>
      {job ? <JobProgress job={job} /> : <ProgressBar value={null} label="Build progress" />}
      {steps.length > 0 && (
        <ol className="build-steps">
          {steps.map((st, i) => {
            const current = i === steps.length - 1 && job != null && running(job)
            return (
              <li key={st} className={current ? 'is-current' : 'is-done'}>
                {current ? <Spinner size={9} /> : <Check size={11} />}
                <span>{st}</span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function NotBuiltCard({ name, acres, started, autoBuild }: { name: string; acres: number | null; started: number; autoBuild: boolean }) {
  const tf = useTimeFormat()
  return (
    <div className="ov-card glass">
      <CornerMarks />
      <div className="ov-eyebrow eyebrow">Analysis not prepared</div>
      <div className="ov-title">{name}</div>
      <p className="ov-text secondary">
        <span className="mono">{fmtAcres(acres)}</span> · started <span className="mono">{fmtDayDate(started, tf.tz, { year: 'always' })}</span>. Prepare the analysis (incident bundle) to replay the fire in 3D and run
        forecasts{autoBuild ? '.' : ' (the setting “Prepare analysis when I pick an unprepared fire” is off).'}
      </p>
      <div className="ov-actions">
        <button type="button" className="btn btn-solid" onClick={() => void useStore.getState().startBuild(false)}>
          <Hammer size={13} /> Prepare analysis (1-3 min)
        </button>
      </div>
    </div>
  )
}

function BuildFailedCard({ name, message }: { name: string; message: string | null }) {
  return (
    <div className="ov-card glass is-error">
      <CornerMarks />
      <div className="ov-eyebrow eyebrow danger">Build failed</div>
      <div className="ov-title">{name}</div>
      {message && <p className="ov-text mono small danger-soft">{message}</p>}
      <div className="ov-actions">
        <button type="button" className="btn btn-gold" onClick={() => void useStore.getState().startBuild(true)}>
          <RefreshCw size={13} /> Retry build
        </button>
      </div>
    </div>
  )
}

function CatalogErrorCard({ error }: { error: string }) {
  return (
    <div className="ov-card glass is-error">
      <div className="ov-eyebrow eyebrow danger">Cannot load incidents</div>
      <p className="ov-text secondary">{error}</p>
      <div className="ov-actions">
        <button type="button" className="btn btn-gold" onClick={() => void useStore.getState().loadCatalog()}>
          <RefreshCw size={13} /> Retry
        </button>
      </div>
    </div>
  )
}

function NothingCard() {
  return (
    <div className="ov-card glass">
      <div className="ov-eyebrow eyebrow">No incidents</div>
      <p className="ov-text secondary">The fire list is empty: no active fires listed by CAL FIRE or NIFC and no 2025 fires above the size threshold. That is not an all-clear: follow local officials.</p>
      <div className="ov-actions">
        <button type="button" className="btn btn-gold" onClick={() => void useStore.getState().loadCatalog({ minAcres: 100 })}>
          Include fires ≥ 100 ac
        </button>
      </div>
    </div>
  )
}

/** Error banner (top centre) for incident / job errors, with retry. */
export function ErrorBanner() {
  const { error, id } = useStore(useShallow((s) => ({ error: s.incidentError, id: s.incidentId })))
  if (!error) return null
  return (
    <div className="banner banner-error" role="alert">
      <AlertTriangle size={14} />
      <span className="banner-text">{error}</span>
      {id && (
        <button
          type="button"
          className="btn btn-sm btn-gold"
          onClick={() => {
            useStore.getState().setIncidentError(null)
            void useStore.getState().selectIncident(id, { keepTime: true })
          }}
        >
          <RefreshCw size={12} /> Retry
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => useStore.getState().setIncidentError(null)}>
        <X size={13} />
      </button>
    </div>
  )
}

/** "No active fires listed" notice when live mode has nothing and a replay is shown instead. The replay's year is the
 *  open fire's; when a list could not be reached it says so, never "no active fires" (§14.16). */
export function NoLiveNotice() {
  const show = useStore((s) => !s.catalog.loading && s.catalog.updatedMs.live != null && s.catalog.live.length === 0 && s.summary?.mode === 'historical')
  const year = useStore((s) => s.summary?.year ?? null)
  const sources = useStore((s) => s.catalog.sources?.live ?? null)
  const [dismissed, setDismissed] = useState(false)
  if (!show || dismissed) return null
  return (
    <div className="banner banner-info">
      <Info size={13} />
      <span className="banner-text">{noLiveText(listHealth([sources]), year)}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        <X size={13} />
      </button>
    </div>
  )
}

/** Compact job pill (top centre) while a forecast runs, or while a loaded bundle is rebuilt / refreshed (the
 *  replay stays usable; a first build uses the centre card instead). */
export function ForecastPill() {
  const job = useStore((s) => {
    const j = s.job
    if (!j || !running(j)) return null
    if (j.kind === 'forecast') return j
    return s.manifest?.status === 'ready' ? j : null
  })
  if (!job) return null
  const label = job.kind === 'forecast' ? 'Forecast' : job.kind === 'build' ? 'Rebuilding bundle' : 'Refreshing live data'
  return (
    <button
      type="button"
      className={`fc-pill glass is-${job.kind}`}
      onClick={() => useStore.getState().setRightTab(job.kind === 'forecast' ? 'analysis' : 'evidence')}
      data-tip={job.message || (job.kind === 'forecast' ? 'Open the Analysis tab' : 'Open the Evidence tab')}
    >
      {job.kind === 'forecast' ? <Flame size={13} className="fire" /> : <Hammer size={13} className="gold" />}
      <span>{label}</span>
      <span className="secondary ellipsis">{job.status === 'queued' ? 'queued' : job.step}</span>
      <span className="mono">{Math.round(job.progress * 100)}%</span>
      <span className="fc-pill-bar">
        <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </span>
    </button>
  )
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass toast-${t.tone}`}>
          {t.tone === 'ok' ? <Check size={13} /> : t.tone === 'error' ? <AlertTriangle size={13} /> : <Info size={13} />}
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => useToasts.getState().dismiss(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Keeps the UI alive if the 3D scene throws (shader / WebGL failures); offers a retry. */
export class SceneBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[scene] crashed', error, info.componentStack)
  }
  render() {
    if (this.state.error)
      return (
        <div className="scene-placeholder">
          <div className="ov-card glass is-error scene-error">
            <div className="ov-eyebrow eyebrow danger">3D view unavailable</div>
            <p className="ov-text mono small">{this.state.error.message}</p>
            <p className="ov-text secondary small">Panels, timeline and charts keep working.</p>
            <div className="ov-actions">
              <button type="button" className="btn btn-gold" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
                <RefreshCw size={13} /> Retry 3D view
              </button>
            </div>
          </div>
        </div>
      )
    return <div key={this.state.attempt} className="scene-host">{this.props.children}</div>
  }
}
