// Official evacuation zones panel (owner: us-official in brief 3; earlier optional-sources). Shows the issuing
// jurisdictions, the official wording verbatim (Oregon's levels flagged as Fire-3d's wording of OEM's level number,
// with OEM's definition), the issuer's update time per zone, each state source's own update time (Cal OES, Oregon
// OEM), county coverage (California) and an honest state when the status cannot be shown (past dates, not available
// in this state, county not in the statewide layer, outage). Presentational: pass the state from useEvacuations().
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTimeFormat } from '../state/timeZone'
import { useNow } from '../ui/hooks'
import { aggregatorOf, answeredNames, answeredSources, evacStatusCounts, zoneDetail } from './evacuation'
import { ExtrasNotice, LegendSwatch, SourceFooter } from './ExtrasCommon'
import { envelopeStatusLine, fmtWhen, freshnessText } from './format'
import type { ExtrasQueryState } from './hooks'
import { EVAC_GROUP_COLOR, EVAC_GROUP_HATCH, EVAC_GROUP_LINE } from './style'
import type { EvacuationsResponse } from './types'

const MAX_ZONES = 6

/** "Current status issued by local officials and listed by Cal OES." / "… by Oregon OEM." / not available. */
function panelSub(data: EvacuationsResponse | null): string {
  if (data?.reason_code === 'state_not_available') return 'Official evacuation zones are shown only where a state publishes them (California, Oregon).'
  const who = answeredNames(data) ?? (data?.sources.length ? [...new Set(data.sources.filter((s) => s.id !== 'caloes_evacuation_inventory').map((s) => aggregatorOf(data, s.id)))].join(' and ') : null)
  return `Current status issued by local officials and listed by ${who || 'the state'}. Shown as current status only.`
}

export interface EvacuationPanelProps {
  state: ExtrasQueryState<EvacuationsResponse>
  /** Called with a zone id when the user asks to see it on the map (fit its bounds). */
  onShowZone?: (zoneId: string) => void
  /** Zone highlighted from the map, if any. */
  selectedZoneId?: string | null
}

export function EvacuationPanel({ state, onShowZone, selectedZoneId }: EvacuationPanelProps) {
  const now = useNow(30_000)
  const tf = useTimeFormat()
  const [all, setAll] = useState(false)
  const data = state.data
  const line = envelopeStatusLine(data, 'Official evacuation zones', state.error)
  const counts = evacStatusCounts(data).filter((c) => c.group !== 'hidden')
  const zones = data?.status === 'available' ? data.zones.features.filter((f) => !['normal', 'training'].includes(f.properties.status_key)) : []
  const shown = all ? zones : zones.slice(0, MAX_ZONES)
  const missing = data?.coverage.filter((c) => !c.in_statewide_layer) ?? []
  const answered = answeredSources(data)
  return (
    <section className="xs-panel" aria-label="Official evacuation zones">
      <header className="xs-head">
        <h3>Official evacuation zones</h3>
        <span className="xs-badge xs-badge-official">Official</span>
        <button type="button" className="xs-icon-btn" onClick={state.refresh} disabled={state.loading} aria-label="Refresh evacuation zones">
          <RefreshCw size={14} aria-hidden="true" className={state.loading ? 'xs-spin' : undefined} />
        </button>
      </header>
      <p className="xs-sub">{panelSub(data)}</p>
      {data?.status === 'available' && !state.error ? (
        answered.length > 1 ? (
          answered.map((s) => (
            <p key={s.id} className="xs-meta">
              {freshnessText({ source_updated_ms: s.updated_ms ?? null, retrieved_ms: s.retrieved_ms ?? null }, now, `${aggregatorOf(data, s.id)} data last changed`, tf)}
            </p>
          ))
        ) : (
          <p className="xs-meta">{freshnessText(data, now, `${answeredNames(data) ?? 'Source'} data last changed`, tf)}</p>
        )
      ) : (
        <ExtrasNotice line={line} onRetry={state.error ? state.refresh : undefined} />
      )}
      {data?.status === 'available' && (
        <>
          {counts.length > 0 ? (
            <ul className="xs-counts" aria-label="Zones by official status">
              {counts.map((c) => {
                const g = c.group === 'hidden' ? 'other' : c.group
                return (
                  <li key={c.status}>
                    <LegendSwatch
                      entry={{ id: c.status, layer: 'evacuation', label: c.status, detail: null, swatch: { kind: 'hatch', color: EVAC_GROUP_COLOR[g], spacing: EVAC_GROUP_HATCH[g].spacing, line: EVAC_GROUP_LINE[g].style } }}
                    />
                    <span className="xs-count-status">{c.status}</span>
                    <span className="xs-count-n">
                      {c.count} zone{c.count === 1 ? '' : 's'}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="xs-empty">No evacuation orders or warnings are listed for this area right now. That is not an all-clear: follow local officials.</p>
          )}
          {shown.length > 0 && (
            <ul className="xs-list" aria-label="Zones">
              {shown.map((f) => {
                const z = zoneDetail(f, now, tf)
                const g = z.group === 'hidden' ? 'other' : z.group
                return (
                  <li key={z.id} className={selectedZoneId === z.id ? 'xs-selected' : undefined}>
                    <div className="xs-zone-row">
                      <span className="xs-zone-dot" style={{ background: EVAC_GROUP_COLOR[g] }} aria-hidden="true" />
                      <span className="xs-zone-status">{z.status}</span>
                      {onShowZone && (
                        <button type="button" className="xs-link-btn" onClick={() => onShowZone(z.id)}>
                          Show on map
                        </button>
                      )}
                    </div>
                    <div className="xs-zone-meta">
                      <span className="xs-mono">{z.title}</span> · {z.jurisdiction}
                    </div>
                    <div className="xs-zone-meta">{z.updatedText}</div>
                    {(z.message || z.extra.length > 0) && (
                      <details className="xs-details">
                        <summary>Official message</summary>
                        {z.message && <p className="xs-official-text">{z.message}</p>}
                        {z.extra.map((t) => (
                          <p key={t} className="xs-official-text">
                            {t}
                          </p>
                        ))}
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {zones.length > MAX_ZONES && (
            <button type="button" className="xs-link-btn" onClick={() => setAll((v) => !v)}>
              {all ? 'Show fewer zones' : `Show all ${zones.length} zones`}
            </button>
          )}
        </>
      )}
      {data && data.coverage.length > 0 && data.status !== 'not_available_for_past_dates' && (
        <div className="xs-coverage">
          <div className="xs-coverage-title">Counties in this area</div>
          <ul>
            {data.coverage.map((c) => (
              <li key={c.county}>
                <span>
                  {c.county} County{' '}
                  <span className="xs-dim">
                    {c.in_statewide_layer ? `· zones from ${c.zone_source ?? 'the county'}` : '· not in the statewide layer'}
                  </span>
                </span>
                {c.reference_url && (
                  <a href={c.reference_url} target="_blank" rel="noreferrer noopener" className="xs-ext">
                    County map <ExternalLink size={11} aria-hidden="true" />
                  </a>
                )}
              </li>
            ))}
          </ul>
          {missing.length > 0 && data.status === 'available' && (
            <p className="xs-warn-text">Zones from {missing.map((c) => c.county).join(', ')} County are not in the statewide layer and are not shown.</p>
          )}
        </div>
      )}
      {data?.caveats.filter((c) => !c.startsWith('No orders')).map((c) => (
        <p key={c} className="xs-caveat">
          {c}
        </p>
      ))}
      <p className="xs-note">Fire-3d's modeled spread is not an evacuation instruction. Follow local officials; in an emergency call 911.</p>
      <SourceFooter
        sources={data?.sources ?? []}
        extra={data?.retrieved_ms ? <p className="xs-dim">Fetched by Fire-3d {fmtWhen(data.retrieved_ms, now, tf)}</p> : null}
      />
    </section>
  )
}
