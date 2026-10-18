// Plain-language location card (owner: location; BRIEF §8, CONTRACT §5). Shown while a point is selected. Values
// come from checkLocation (real geometry + nearest-pixel samples of the original UTM grids) and are worded by
// describeLocation. A short summary keeps the map visible; the details disclosure (remembered per preset) holds the
// sources, periods, explanations and, in Command, the original scientific values. While the official evacuation layer
// is on and current, the card also lists the official zones at the point, in their own wording.
import { ChevronDown, Crosshair, MapPin, X } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRasterSet, type RasterSlot } from '../data/rasters'
import { LegendSwatch } from '../extras/ExtrasCommon'
import { zoneDetail, zonesAtPoint } from '../extras/evacuation'
import { agoText } from '../extras/format'
import { useExtrasRuntime } from '../extras/runtime'
import { EVAC_GROUP_COLOR, EVAC_GROUP_HATCH, EVAC_GROUP_LINE } from '../extras/style'
import { useStore } from '../state/store'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { detailsFor, useAddressDetails } from './addressStore'
import { useCardPrefs } from './cardPrefs'
import { describeLocation, type CardLine, type LineKind } from './describe'
import { checkLocation } from './locationCheck'
import type { LocationRasters } from './types'
import { useNarrow } from './useNarrow'
import './location.css'

const REQ = {
  incident: ['observed_arrival', 'elevation', 'fuel'],
  forecast: ['burn_probability', 'arrival_p10', 'arrival_p50', 'arrival_p90'],
} as const
const MISSING: RasterSlot = { status: 'missing', layer: null, error: null }

export function LocationCard() {
  const sel = useWorkspace((s) => s.selection)
  // the body (and its raster downloads) mounts only while a point is selected
  return sel ? <LocationCardBody sel={sel} /> : null
}

function KindTag({ kind }: { kind: LineKind }) {
  if (!kind) return null
  return <span className={`loc-kind is-${kind.toLowerCase()}`}>{kind}</span>
}

function Line({ l, technical }: { l: CardLine; technical: boolean }) {
  return (
    <li className={`loc-line is-${l.tone}`}>
      <div className="loc-line-head">
        <span className="loc-line-label">{l.label}</span>
        <KindTag kind={l.kind} />
      </div>
      <p className="loc-line-text">{l.text}</p>
      {l.detail && <p className="loc-line-detail">{l.detail}</p>}
      {technical && l.technical && <p className="loc-line-tech mw-mono">{l.technical}</p>}
    </li>
  )
}

/** Official evacuation zones at the point (current status only: empty in replay and for past times). */
function EvacuationAtPoint({ sel, nowMs, compact }: { sel: SelectedLocation; nowMs: number; compact: boolean }) {
  const on = useWorkspace((s) => s.mapLayers.evacuation)
  const data = useExtrasRuntime((s) => s.evac.data)
  const zones = useMemo(() => (on ? zonesAtPoint(data, sel.lon, sel.lat).filter((z) => !['normal', 'training'].includes(z.properties.status_key)) : []), [on, data, sel.lon, sel.lat])
  if (!on || !data) return null
  if (data.status === 'unavailable')
    return (
      <section className="loc-evac is-unknown" aria-label="Official evacuation zones">
        <h3 className="mw-eyebrow">Official evacuation zones</h3>
        <p className="loc-evac-none">Unavailable right now{data.reason ? `: ${data.reason}` : ''}. Follow local officials.</p>
      </section>
    )
  if (data.status !== 'available') return null
  const asOf = data.retrieved_ms ?? data.now_ms
  if (zones.length === 0)
    return compact ? null : (
      <section className="loc-evac" aria-label="Official evacuation zones">
        <h3 className="mw-eyebrow">Official evacuation zones</h3>
        <p className="loc-evac-none">
          None listed at this point (Cal OES, checked {agoText(asOf, nowMs)}). That is not an all-clear. <span className="loc-kind is-official">Official</span>
        </p>
      </section>
    )
  return (
    <section className="loc-evac is-inside" aria-label="Official evacuation zones">
      <h3 className="mw-eyebrow">Official evacuation zone{zones.length > 1 ? 's' : ''} at this point</h3>
      <ul>
        {zones.slice(0, compact ? 1 : 3).map((z) => {
          const d = zoneDetail(z, nowMs)
          const g = d.group === 'hidden' ? 'other' : d.group
          return (
            <li key={z.id}>
              <p className="loc-evac-status">
                <LegendSwatch entry={{ id: z.id, layer: 'evacuation', label: d.status, detail: null, swatch: { kind: 'hatch', color: EVAC_GROUP_COLOR[g], spacing: EVAC_GROUP_HATCH[g].spacing, line: EVAC_GROUP_LINE[g].style } }} />
                <strong>{d.status}</strong> <span className="loc-kind is-official">Official</span>
              </p>
              {!compact && (
                <p className="loc-evac-meta">
                  {d.title} · {d.jurisdiction} · {d.updatedText}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {!compact && <p className="loc-evac-note">Issued by local officials, listed by Cal OES. Fire-3d's modeled spread is not an evacuation instruction.</p>}
    </section>
  )
}

function LocationCardBody({ sel }: { sel: SelectedLocation }) {
  const clear = useWorkspace((s) => s.clearSelection)
  const units = useWorkspace((s) => s.units)
  const preset = useWorkspace((s) => s.preset)
  const st = useStore(
    useShallow((s) => ({
      timeMs: s.timeMs,
      mode: s.manifest?.mode ?? s.mode,
      summary: s.summary,
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      forecast: s.forecast,
      perimeters: s.perimeters,
      detections: s.detections,
      weather: s.weather,
    })),
  )
  const lastAddress = useAddressDetails((s) => s.details)
  const address = detailsFor(sel, lastAddress)
  const set = useRasterSet(REQ)
  const nowMs = useNow(60_000)
  const timeMs = useDeferredValue(st.timeMs) // playback moves the time every frame; the card may lag a frame
  const report = useMemo(() => {
    const rasters: LocationRasters = {
      observedArrival: set.incident.observed_arrival ?? MISSING,
      elevation: set.incident.elevation ?? MISSING,
      fuel: set.incident.fuel ?? MISSING,
      burnProbability: set.forecastLayers.burn_probability ?? MISSING,
      arrivalP10: set.forecastLayers.arrival_p10 ?? MISSING,
      arrivalP50: set.forecastLayers.arrival_p50 ?? MISSING,
      arrivalP90: set.forecastLayers.arrival_p90 ?? MISSING,
    }
    return checkLocation({
      point: sel,
      timeMs,
      nowMs,
      summary: st.summary,
      manifest: st.manifest,
      perimeters: st.perimeters?.perimeters ?? [],
      detections: st.detections?.detections ?? [],
      weather: st.weather,
      forecast: st.forecast,
      rasters,
      address,
    })
  }, [sel, timeMs, nowMs, st.summary, st.manifest, st.perimeters, st.detections, st.weather, st.forecast, set, address])
  const card = useMemo(() => describeLocation(report, { units, preset, mode: st.mode, nowMs }), [report, units, preset, st.mode, nowMs])
  const command = preset === 'command'
  const detailsOpen = useCardPrefs((s) => s.detailsOpen[preset])
  const narrow = useNarrow()
  // phones: a short bottom sheet until the user asks for more; every new point starts short again
  const selKey = `${sel.source}|${sel.lat}|${sel.lon}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const compact = narrow && expandedFor !== selKey
  const center = () => useWorkspace.getState().requestMapFlyTo({ lon: sel.lon, lat: sel.lat })
  const { summary } = card
  const all = card.sections.flatMap((s) => s.lines)
  const pick = (key: string) => all.find((l) => l.key === key)
  const observed = summary.keys.includes('observed') ? pick('observed') : undefined
  const forecastLines = ['forecast-gap', 'burn-chance', 'model-missed', 'arrival']
    .filter((k) => summary.keys.includes(k))
    .map(pick)
    .filter((l): l is CardLine => !!l)
  const forecastTitle = card.sections.find((s) => s.key === 'forecast')?.title
  const technical = all.filter((l) => l.technical)

  return (
    <section className={`mw-panel loc-card${command ? ' is-command' : ''}`} aria-label="Location check">
      <div className="mw-sheet-handle" aria-hidden="true" />
      <header className="loc-card-head">
        <MapPin size={16} className="loc-card-pin" aria-hidden="true" />
        <div className="loc-card-titles">
          <h2 className={`loc-card-title${card.titleIsCoords ? ' mw-mono' : ''}`}>{card.title}</h2>
          <p className="loc-card-type">
            {card.approximate && <span className="loc-kind is-approximate">Approximate</span>} {card.locationType}
          </p>
          {!card.titleIsCoords && !compact && (
            <p className="loc-card-coords mw-mono">
              {card.lat}, {card.lon}
            </p>
          )}
          {sel.adjustable && !sel.adjusted && <p className="loc-card-hint">Drag the pin on the map to correct the position.</p>}
        </div>
        <div className="loc-card-actions">
          <button type="button" className="mw-icon-btn is-sm" aria-label="Center the map on this location" title="Center the map here" onClick={center}>
            <Crosshair size={13} />
          </button>
          <button type="button" className="mw-icon-btn is-sm" aria-label="Close the location check" title="Close" onClick={clear}>
            <X size={14} />
          </button>
        </div>
      </header>

      {/* the kind tag (Mapped / Estimate / Unknown) leads the line it qualifies */}
      <div className={`loc-headline is-${summary.perimeter.tone}`} role="status">
        <p className="loc-headline-text">
          <span>{summary.perimeter.text}</span>
          {(compact || !summary.perimeter.sub) && (
            <>
              {' '}
              <KindTag kind={summary.perimeter.kind} />
            </>
          )}
        </p>
        {summary.perimeter.sub && !compact && (
          <p className="loc-headline-sub">
            <KindTag kind={summary.perimeter.kind} /> {summary.perimeter.sub}
          </p>
        )}
        {observed && !compact && (
          <p className="loc-headline-sub">
            <KindTag kind={observed.kind} /> {observed.text}
          </p>
        )}
      </div>
      {card.areaNote && <p className="loc-area-note">{card.areaNote}</p>}

      <EvacuationAtPoint sel={sel} nowMs={nowMs} compact={compact} />

      {forecastLines.length > 0 && (
        <section className="loc-forecast" aria-label={forecastTitle ?? 'Forecast'}>
          <h3 className="mw-eyebrow">{forecastTitle}</h3>
          {(compact ? forecastLines.slice(0, 1) : forecastLines).map((l) =>
            l.key === 'burn-chance' ? (
              <p key={l.key} className="loc-burn-row">
                {summary.burnFigure && <span className="loc-burn-figure mw-mono">{summary.burnFigure}</span>}
                <span className="loc-burn-text">{summary.burnText ?? l.text}</span>
              </p>
            ) : (
              // the section title already says "Model"; other kinds (Unknown) stay written out
              <p key={l.key} className={`loc-fline is-${l.tone}`}>
                {l.key === 'arrival' && <span className="loc-fline-label">{l.label}: </span>}
                {l.text} {l.kind !== 'Model' && <KindTag kind={l.kind} />}
              </p>
            ),
          )}
        </section>
      )}

      {compact ? (
        <button type="button" className="mw-btn is-sm loc-expand" aria-expanded="false" onClick={() => setExpandedFor(selKey)}>
          <ChevronDown size={13} aria-hidden="true" /> More about this location
        </button>
      ) : (
        <>
          {summary.conditions && <p className="loc-conditions">{summary.conditions}</p>}

          <details className="loc-more" open={detailsOpen} onToggle={(e) => useCardPrefs.getState().setDetailsOpen(preset, e.currentTarget.open)}>
            <summary>
              <ChevronDown size={13} aria-hidden="true" className="loc-more-chev" />
              Details, sources and uncertainty
            </summary>
            {card.details.map((s) => (
              <section key={s.key} className={`loc-section is-${s.key}`} aria-label={s.title}>
                <h3 className="mw-eyebrow">{s.title}</h3>
                <ul>
                  {s.lines.map((l) => (
                    <Line key={l.key} l={l} technical={command} />
                  ))}
                </ul>
              </section>
            ))}
            {card.caveats.length > 0 && (
              <section className="loc-section" aria-label="Uncertainty">
                <h3 className="mw-eyebrow">Uncertainty and limits</h3>
                <ul className="loc-caveats">
                  {card.caveats.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </section>
            )}
            {card.sources.length > 0 && (
              <section className="loc-section" aria-label="Sources">
                <h3 className="mw-eyebrow">Sources and freshness</h3>
                <ul className="loc-sources">
                  {card.sources.map((s) => (
                    <li key={s.text}>{s.text}</li>
                  ))}
                </ul>
              </section>
            )}
            {technical.length > 0 && (
              <section className="loc-section" aria-label="Scientific values">
                <h3 className="mw-eyebrow">Scientific values</h3>
                <ul className="loc-tech">
                  {technical.map((l) => (
                    <li key={l.key} className="mw-mono">
                      {l.label}: {l.technical}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </details>
        </>
      )}
    </section>
  )
}
