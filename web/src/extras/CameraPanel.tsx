// Public cameras panel (owner: optional-sources). Lists ALERTCalifornia wildfire cameras and Caltrans traffic
// cameras near the incident; an image is fetched only when the user presses "Show latest image", shown unmodified
// (object-fit: contain keeps the information bar) with the source credit, licence and the image's own time. No video
// is ever played automatically. Presentational: pass useCameras() and useCameraFrame() state.
import { Camera, ExternalLink, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useTimeFormat } from '../state/timeZone'
import { useNow } from '../ui/hooks'
import { cameraServiceText, cameraViewText, compassWord, frameTimeText, sortCameras } from './cameras'
import { apiPath } from './client'
import { CameraGlyph, ExtrasNotice, SourceFooter } from './ExtrasCommon'
import { envelopeStatusLine, freshnessText } from './format'
import type { CameraFrameState, ExtrasQueryState } from './hooks'
import type { CamerasResponse } from './types'

const MAX_LIST = 8

export interface CameraPanelProps {
  state: ExtrasQueryState<CamerasResponse>
  frame: CameraFrameState
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Incident reported location (lon, lat) for distances, if known. */
  centre?: [number, number] | null
  /** Use miles / feet (US customary) or km / m. */
  units?: 'us' | 'metric'
}

function distText(m: number, units: 'us' | 'metric'): string {
  if (units === 'metric') return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
  const mi = m / 1609.344
  return mi < 0.2 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`
}

export function CameraPanel({ state, frame, selectedId, onSelect, centre = null, units = 'us' }: CameraPanelProps) {
  const now = useNow(15_000)
  const tf = useTimeFormat()
  const [all, setAll] = useState(false)
  const data = state.data
  const items = sortCameras(data, centre)
  const shown = all ? items : items.slice(0, MAX_LIST)
  const selected = items.find((i) => i.feature.properties.id === selectedId) ?? null
  const line = envelopeStatusLine(data, 'Public cameras', state.error)
  const f = frame.cameraId === selectedId ? frame.frame : null
  return (
    <section className="xs-panel" aria-label="Public cameras">
      <header className="xs-head">
        <h3>Public cameras</h3>
        <span className="xs-badge">Live views</span>
        <button type="button" className="xs-icon-btn" onClick={state.refresh} disabled={state.loading} aria-label="Refresh camera list">
          <RefreshCw size={14} aria-hidden="true" className={state.loading ? 'xs-spin' : undefined} />
        </button>
      </header>
      <p className="xs-sub">Wildfire cameras (ALERTCalifornia) and traffic cameras (Caltrans). An image loads only when you ask for it.</p>
      {data?.status === 'available' && !state.error ? (
        <p className="xs-meta">{freshnessText(data, now, 'Cal OES list last changed', tf)}</p>
      ) : (
        <ExtrasNotice line={line} onRetry={state.error ? state.refresh : undefined} />
      )}
      {data?.status === 'available' && items.length === 0 && <p className="xs-empty">No public cameras are listed in this area.</p>}
      {shown.length > 0 && (
        <ul className="xs-list xs-cam-list" aria-label="Cameras">
          {shown.map(({ feature, distanceM, bearingDeg }) => {
            const p = feature.properties
            const active = p.id === selectedId
            return (
              <li key={p.id} className={active ? 'xs-selected' : undefined}>
                <button type="button" className="xs-cam-btn" aria-pressed={active} onClick={() => onSelect(active ? null : p.id)}>
                  <CameraGlyph variant={p.kind} />
                  <span className="xs-cam-name">{p.name}</span>
                  <span className="xs-cam-meta">
                    {p.kind === 'wildfire' ? 'Wildfire camera' : 'Traffic camera'}
                    {distanceM != null && bearingDeg != null ? ` · ${distText(distanceM, units)} ${compassWord(bearingDeg)} of the fire` : ''}
                    {p.in_service === false ? ' · out of service' : ''}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {items.length > MAX_LIST && (
        <button type="button" className="xs-link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer cameras' : `Show all ${items.length} cameras`}
        </button>
      )}
      {selected && (
        <div className="xs-cam-detail" aria-live="polite">
          <div className="xs-cam-detail-head">
            <strong>{selected.feature.properties.name}</strong>
            <button type="button" className="xs-icon-btn" onClick={() => onSelect(null)} aria-label="Close camera">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="xs-zone-meta">{cameraViewText(selected.feature)}</div>
          {cameraServiceText(selected.feature) && <div className="xs-zone-meta">{cameraServiceText(selected.feature)}</div>}
          <div className="xs-zone-meta">Credit: {selected.feature.properties.credit}</div>
          <button type="button" className="xs-btn" onClick={() => frame.request(selected.feature.properties.id)} disabled={frame.loading && frame.cameraId === selectedId}>
            <Camera size={14} aria-hidden="true" /> {f ? 'Load a newer image' : 'Show latest image'}
          </button>
          {frame.cameraId === selectedId && frame.loading && <p className="xs-meta">Loading the latest image…</p>}
          {frame.cameraId === selectedId && frame.error && <ExtrasNotice line={{ tone: 'error', title: 'Camera image could not load', detail: frame.error }} />}
          {f && f.status === 'unavailable' && <ExtrasNotice line={{ tone: 'warn', title: 'No image right now', detail: f.reason }} />}
          {f && f.status === 'available' && f.image_url && (
            <figure className="xs-frame">
              <img src={apiPath(f.image_url)} alt={`Latest image from ${selected.feature.properties.name} (${f.credit})`} width={f.width ?? undefined} height={f.height ?? undefined} />
              <figcaption>
                <span className="xs-frame-credit">{f.credit}</span>
                <span>{frameTimeText(f, now, tf)}. The camera's own capture time is printed on the image.</span>
                <span className="xs-dim">{f.license}</span>
                {f.viewer_url && (
                  <a href={f.viewer_url} target="_blank" rel="noreferrer noopener" className="xs-ext">
                    Open on ALERTCalifornia <ExternalLink size={11} aria-hidden="true" />
                  </a>
                )}
              </figcaption>
            </figure>
          )}
          {selected.feature.properties.streaming_video && <p className="xs-dim">Caltrans also streams video from this camera; Fire-3d never plays video automatically.</p>}
        </div>
      )}
      {data && Object.keys(data.excluded).length > 0 && (
        <p className="xs-caveat">Not shown: {Object.entries(data.excluded).map(([k, v]) => `${k} (${v})`).join(', ')}: terms not verified by Fire-3d.</p>
      )}
      <SourceFooter sources={data?.sources ?? []} />
    </section>
  )
}
