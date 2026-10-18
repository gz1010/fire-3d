// Scene-dev bundle loader: fetches an incident + its bundle files with api/client and writes them into the app store
// with setState (no dependency on the UI's async store actions, so the scene can be developed in isolation).
import { bundleUrl, fetchJson, getIncident } from '../../api/client'
import type { DetectionsFile, EventsFile, ForecastManifest, IncidentManifest, PerimetersFile, TimeseriesFile, WeatherFile } from '../../api/types'
import { defaultTimeFor, getTimeBounds, useStore } from '../../state/store'

async function optionalJson<T>(url: string): Promise<T | null> {
  try {
    return await fetchJson<T>(url)
  } catch (e) {
    console.warn('[scene-dev] optional file failed', url, e)
    return null
  }
}

export async function fetchForecastManifest(m: IncidentManifest, runId: string): Promise<ForecastManifest | null> {
  const fs = m.forecasts.find((f) => f.run_id === runId)
  if (!fs) return null
  return fetchJson<ForecastManifest>(bundleUrl(m.id, fs.file, `${m.built_ms}-${fs.issued_ms}`))
}

/** Load incident `id` into the store. `timeMs` (optional) overrides the default time; `forecastRunId` = null skips
 *  the forecast, undefined picks the newest ready run. */
export async function loadIncidentIntoStore(id: string, opts: { timeMs?: number | null; forecastRunId?: string | null } = {}): Promise<IncidentManifest> {
  useStore.setState({ incidentId: id, incidentLoading: true, incidentError: null })
  try {
    const detail = await getIncident(id)
    const m = detail.manifest
    if (!m || m.status !== 'ready') throw new Error(`bundle for ${id} is not ready (${m?.status ?? 'missing'})`)
    const url = (p: string) => bundleUrl(m.id, p, m.built_ms)
    const runId = opts.forecastRunId === undefined ? (m.forecasts.find((f) => f.status === 'ready')?.run_id ?? null) : opts.forecastRunId
    const [timeseries, events, weather, detections, perimeters, forecast] = await Promise.all([
      optionalJson<TimeseriesFile>(url('timeseries.json')),
      optionalJson<EventsFile>(url('events.json')),
      optionalJson<WeatherFile>(url('weather.json')),
      optionalJson<DetectionsFile>(url('detections.json')),
      optionalJson<PerimetersFile>(url('perimeters.json')),
      runId ? fetchForecastManifest(m, runId).catch(() => null) : Promise.resolve(null),
    ])
    const timeMs = opts.timeMs && opts.timeMs > 0 ? opts.timeMs : defaultTimeFor(m)
    useStore.setState({
      incidentId: id,
      summary: detail.summary,
      manifest: m,
      mode: m.mode,
      job: null,
      timeseries,
      events,
      weather,
      detections,
      perimeters,
      forecast,
      forecastRunId: forecast?.run_id ?? null,
      timeMs,
      timeWindow: getTimeBounds({ manifest: m, forecast }),
      profilePath: m.default_profile_path ?? [],
      incidentLoading: false,
    })
    return m
  } catch (e) {
    useStore.setState({ incidentLoading: false, incidentError: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/** Switch the forecast run (null = none) without touching the rest of the incident. */
export async function selectForecastRun(runId: string | null): Promise<void> {
  const m = useStore.getState().manifest
  if (!m) return
  const forecast = runId ? await fetchForecastManifest(m, runId) : null
  useStore.setState({ forecast, forecastRunId: forecast?.run_id ?? null, timeWindow: getTimeBounds({ manifest: m, forecast }) })
}
