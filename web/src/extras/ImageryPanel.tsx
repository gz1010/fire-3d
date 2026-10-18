// Recent satellite imagery panel (owner: optional-sources). Lists images by sensor with acquisition time, time
// relative to the selected time and to the fire start, latency, cloud cover, coverage and resolution; one image can
// be shown on the map at a time. Images that are listed but not yet displayable say why. Presentational: pass
// useImagery() state and the selected product id.
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNow } from '../ui/hooks'
import { ExtrasNotice, SourceFooter } from './ExtrasCommon'
import { envelopeStatusLine, freshnessText } from './format'
import type { ExtrasQueryState } from './hooks'
import { cloudText, coverageText, FAMILY_LABEL, FAMILY_ORDER, IMAGERY_DISTINCTION, imageryTiming, productsByFamily, resolutionText } from './imagery'
import type { ImageryResponse } from './types'

const PER_FAMILY = 3

export interface ImageryPanelProps {
  state: ExtrasQueryState<ImageryResponse>
  selectedId: string | null
  onSelect: (id: string | null) => void
  opacity: number
  onOpacity: (v: number) => void
  /** Incident start (reported) for "before the fire" notes. */
  startedMs?: number | null
}

export function ImageryPanel({ state, selectedId, onSelect, opacity, onOpacity, startedMs = null }: ImageryPanelProps) {
  const now = useNow(60_000)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const data = state.data
  const line = envelopeStatusLine(data, 'Recent satellite imagery', state.error)
  const groups = productsByFamily(data)
  const selected = data?.products.find((p) => p.id === selectedId) ?? null
  const ref = data?.reference_ms ?? now
  const fams = data?.families ?? []
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
          Images acquired up to {data.requested_at_ms != null ? 'the selected time' : 'now'}
          {freshnessText(data, now, 'newest listing') ? ` · ${freshnessText(data, now, 'newest listing')}` : ''}
        </p>
      ) : (
        <ExtrasNotice line={line} onRetry={state.error ? state.refresh : undefined} />
      )}
      {data?.status === 'available' && (
        <div className="xs-img-groups" role="radiogroup" aria-label="Image shown on the map">
          <label className="xs-img-row xs-img-none">
            <input type="radio" name="xs-imagery" checked={selectedId == null} onChange={() => onSelect(null)} />
            <span>No satellite image on the map</span>
          </label>
          {FAMILY_ORDER.map((fam) => {
            const status = fams.find((f) => f.family === fam)
            const list = groups[fam]
            if (!status && list.length === 0) return null
            const expanded = open[fam] ?? false
            const shown = expanded ? list : list.slice(0, PER_FAMILY)
            return (
              <div key={fam} className="xs-img-group">
                <div className="xs-img-group-title">{FAMILY_LABEL[fam]}</div>
                {status?.status === 'unavailable' && <p className="xs-warn-text">Unavailable: {status.reason}</p>}
                {status?.status !== 'unavailable' && list.length === 0 && <p className="xs-dim">No images in the last weeks for this area.</p>}
                {shown.map((p) => {
                  const t = imageryTiming(p, ref, startedMs, data.requested_at_ms == null)
                  return (
                    <label key={p.id} className={`xs-img-row${p.available ? '' : ' xs-disabled'}${p.id === selectedId ? ' xs-selected' : ''}`}>
                      <input type="radio" name="xs-imagery" disabled={!p.available} checked={p.id === selectedId} onChange={() => onSelect(p.id)} />
                      <span className="xs-img-text">
                        <span className="xs-img-title">
                          {p.label} · {p.platform}
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
                  )
                })}
                {list.length > PER_FAMILY && (
                  <button type="button" className="xs-link-btn" onClick={() => setOpen((o) => ({ ...o, [fam]: !expanded }))}>
                    {expanded ? 'Show fewer' : `Show ${list.length - PER_FAMILY} more`}
                  </button>
                )}
              </div>
            )
          })}
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
