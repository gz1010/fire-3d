// Recent satellite imagery panel (owner: official-web since brief 2, earlier optional-sources). One list, newest images
// of the fire first (acquired after it started), then images from before the fire (context) and GOES-West last
// (1-2 km pixels). Each row gives the acquisition time, the time relative to now or the selected time, latency,
// cloud cover, coverage and resolution; one image can be shown on the map at a time. Images that are listed but not
// yet displayable say why. Presentational: pass useImagery() state and the selected product id.
// Brief 2 (integration): the Satellite chip's "More images" popover holds the one image list on wide screens; the Layers
// drawer shows ImageryLayerSummary there (the image shown, opacity, credit). Phones keep the list in the drawer (the
// chip is hidden while a sheet is open). Each list has its own radio group, so two lists never uncheck each other.
import { RefreshCw } from 'lucide-react'
import { useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { forIncident } from '../official/guard'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { useNow } from '../ui/hooks'
import { ExtrasNotice, SourceFooter } from './ExtrasCommon'
import { envelopeStatusLine, freshnessText } from './format'
import type { ExtrasQueryState } from './hooks'
import { cloudText, coverageText, FAMILY_LABEL, IMAGERY_DISTINCTION, imageryCaption, orderedProducts, productLabel, resolutionText, withGroupHeadings } from './imagery'
import type { ImageryProduct, ImageryResponse } from './types'

const FIRST = 6

export interface ImageryPanelProps {
  state: ExtrasQueryState<ImageryResponse>
  selectedId: string | null
  onSelect: (id: string | null) => void
  opacity: number
  onOpacity: (v: number) => void
  /** Incident start (reported) for "before the fire" notes and the order of the list. */
  startedMs?: number | null
}

export function ImageryPanel({ state, selectedId, onSelect, opacity, onOpacity, startedMs = null }: ImageryPanelProps) {
  const now = useNow(60_000)
  const tf = useTimeFormat()
  const [all, setAll] = useState(false)
  // one radio group per list: the chip's popover and the phone drawer each have their own
  const group = useId()
  const data = state.data
  const line = envelopeStatusLine(data, 'Recent satellite imagery', state.error)
  const selected = data?.products.find((p) => p.id === selectedId) ?? null
  const ref = data?.reference_ms ?? now
  const live = data?.requested_at_ms == null
  const ordered = orderedProducts(data, startedMs)
  // keep the selected image visible even when it is further down
  const firstIds = new Set(ordered.slice(0, FIRST).map((p) => p.id))
  const shown = all ? ordered : ordered.filter((p) => firstIds.has(p.id) || p.id === selectedId)
  const down = (data?.families ?? []).filter((f) => f.status === 'unavailable')
  const rows = withGroupHeadings(shown, ref, startedMs, live)
  return (
    <section className="xs-panel" aria-label="Recent satellite imagery">
      <header className="xs-head">
        <h3>Recent satellite imagery</h3>
        <button type="button" className="xs-icon-btn" onClick={state.refresh} disabled={state.loading} aria-label="Refresh imagery list">
          <RefreshCw size={14} aria-hidden="true" className={state.loading ? 'xs-spin' : undefined} />
        </button>
      </header>
      <p className="xs-sub">{IMAGERY_DISTINCTION}</p>
      {data?.status === 'available' && !state.error ? (
        <p className="xs-meta">
          Images acquired up to {live ? 'now' : 'the selected time'}, newest first
          {freshnessText(data, now, 'newest listing', tf) ? ` · ${freshnessText(data, now, 'newest listing', tf)}` : ''}
        </p>
      ) : (
        <ExtrasNotice line={line} onRetry={state.error ? state.refresh : undefined} />
      )}
      {down.map((f) => (
        <p key={f.family} className="xs-warn-text">
          {FAMILY_LABEL[f.family]} unavailable: {f.reason}
        </p>
      ))}
      {data?.status === 'available' && (
        <div className="xs-img-groups" role="radiogroup" aria-label="Image shown on the map">
          <label className="xs-img-row xs-img-none">
            <input type="radio" name={group} checked={selectedId == null} onChange={() => onSelect(null)} />
            <span>No satellite image on the map</span>
          </label>
          {ordered.length === 0 && <p className="xs-dim">No images in the last weeks for this area.</p>}
          {rows.map(({ p, t, heading }) => {
            return (
              <div key={p.id} className="xs-img-group">
                {heading && <div className="xs-img-group-title">{heading}</div>}
                <label className={`xs-img-row${p.available ? '' : ' xs-disabled'}${p.id === selectedId ? ' xs-selected' : ''}`}>
                  <input type="radio" name={group} disabled={!p.available} checked={p.id === selectedId} onChange={() => onSelect(p.id)} />
                  <span className="xs-img-text">
                    <span className="xs-img-title">
                      {productLabel(p)} · {p.platform}
                      {t.beforeFire && <span className="xs-badge xs-badge-muted">before the fire</span>}
                    </span>
                    <span className="xs-img-line">{t.acquired}</span>
                    <span className="xs-img-line xs-dim">{t.relative}</span>
                    {p.available ? (
                      <span className="xs-img-line xs-dim">
                        {resolutionText(p)} · {coverageText(p)} · {cloudText(p)}
                      </span>
                    ) : (
                      <span className="xs-img-line xs-warn-text">Not shown yet: {p.unavailable_reason}</span>
                    )}
                    {t.latency && <span className="xs-img-line xs-dim">{t.latency}</span>}
                    {t.listedAfterRef && <span className="xs-img-line xs-warn-text">Listed after the selected time: not available yet at that time</span>}
                  </span>
                </label>
              </div>
            )
          })}
          {ordered.length > FIRST && (
            <button type="button" className="xs-link-btn" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer' : `Show all ${ordered.length} images`}
            </button>
          )}
        </div>
      )}
      {selected && selected.available && (
        <div className="xs-img-detail">
          {selected.notes.map((n) => (
            <p key={n} className="xs-dim">
              {n}
            </p>
          ))}
          <label className="xs-opacity">
            Image opacity
            <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} />
          </label>
          <p className="xs-dim">Credit: {selected.attribution}</p>
        </div>
      )}
      <SourceFooter sources={data?.sources ?? []} />
    </section>
  )
}

export interface ImageryLayerSummaryProps {
  state: ExtrasQueryState<ImageryResponse>
  /** The image drawn on the map (useExtrasRuntime.product), if any. */
  product: ImageryProduct | null
  opacity: number
  onOpacity: (v: number) => void
}

/** The Layers drawer's entry for the recent-imagery layer on wide screens, where the Satellite chip holds the one image
 *  list ("More images"): the image shown with its time, age, pixel size and cloud cover ("not live"), its opacity and
 *  credit, and where to pick another. */
export function ImageryLayerSummary({ state, product, opacity, onOpacity }: ImageryLayerSummaryProps) {
  const now = useNow(60_000)
  const st = useStore(
    useShallow((s) => ({ incidentId: s.incidentId, live: (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)) === 'live', minute: Math.floor(s.timeMs / 60_000) })),
  )
  const refMs = st.live ? now : st.minute * 60_000
  // only the open fire's image (the list of a fire just left never shows under the new one)
  const shown = forIncident(state.data, st.incidentId) ? product : null
  const caption = shown ? imageryCaption(shown, refMs, st.live) : null
  const line = envelopeStatusLine(state.data, 'Recent satellite imagery', state.error)
  return (
    <section className="xs-panel" aria-label="Recent satellite imagery">
      {caption && shown ? (
        <>
          <p className="xs-sub xs-img-title">
            {caption.title} <span className="xs-badge xs-badge-muted">not live</span>
          </p>
          <p className="xs-sub">{caption.parts.join(' · ')}</p>
          <label className="xs-opacity">
            Image opacity
            <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} />
          </label>
          <p className="xs-dim">Credit: {shown.attribution}</p>
        </>
      ) : state.data?.status === 'available' && !state.error ? (
        <p className="xs-sub">{state.loading ? 'Checking for satellite images…' : 'No satellite image shown on the map.'}</p>
      ) : (
        <ExtrasNotice line={line} onRetry={state.error ? state.refresh : undefined} />
      )}
      <p className="xs-sub">{IMAGERY_DISTINCTION}</p>
      <p className="xs-dim">To pick another image, open "More images" on the Satellite chip at the top of the map.</p>
    </section>
  )
}
