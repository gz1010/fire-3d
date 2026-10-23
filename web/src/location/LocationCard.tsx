// Plain-language location card (owner: location; BRIEF §8, brief 2 C-R6/C-R7/C-R8/O-R9). Shown while a point is
// selected. Inside a fire, values come from checkLocation (real geometry + nearest-pixel samples of the original UTM
// grids) and are worded by describeLocation in four short blocks: near here; official information (always present,
// from useOfficialAtPoint, I5); the main reasons, each tagged, with the model as a dated sentence (Command keeps the
// figure, the model run and the arrival quantiles); updated and reliability. The details disclosure (remembered per
// preset) holds the sources, periods, explanations and, in Command, the original scientific values. On the national
// overview (no fire open) the card shows the official line and the nearest fires (OverviewCard).
// Brief 3 (§14.9): every time is in the fire's own zone with the preset's clock, and the reliability block names the
// zone ("Times: Mountain Time (MDT), the fire's local time").
import { ChevronDown } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRasterSet, type RasterSlot } from '../data/rasters'
import { useOfficialAtPoint, type OfficialInfo } from '../official/hooks'
import { zoneLine } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat, useZoneSource } from '../state/timeZone'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { detailsFor, useAddressDetails } from './addressStore'
import { useCardPrefs } from './cardPrefs'
import { describeLocation, type CardLine, type LocationCardModel } from './describe'
import { CardFrame, CoverageNotice, KindTag, OfficialSection, StaleChip } from './CardParts'
import { coverageText, useGeoLookup } from './geoLookup'
import { checkLocation } from './locationCheck'
import { officialBlock, officialFireWeatherNote } from './official'
import { OverviewCard } from './OverviewCard'
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
  return sel ? <SelectedPointCard sel={sel} /> : null
}

/** Stays mounted while the point is selected, so the official answer for the point survives the open fire changing
 *  (zooming focuses and leaves fires, brief 2 decision 10) instead of reloading and flickering. */
function SelectedPointCard({ sel }: { sel: SelectedLocation }) {
  const incidentId = useStore((s) => s.incidentId)
  const official = useOfficialAtPoint(sel.lon, sel.lat)
  return incidentId == null ? <OverviewCard sel={sel} official={official} /> : <LocationCardBody sel={sel} official={official} />
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

function LocationCardBody({ sel, official }: { sel: SelectedLocation; official: OfficialInfo }) {
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
  // a fire just opened or focused by zooming (brief 2 decision 10): its files are on the way
  const loadingFire = useStore((s) => s.incidentLoading && !(s.manifest?.status === 'ready' && s.manifest.id === s.incidentId))
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
  const fireWeatherNote = officialFireWeatherNote(official.fireWeather)
  const tf = useTimeFormat()
  const zoneSource = useZoneSource()
  // coverage at the point comes from the server's lookup only (a point searched far from the open fire)
  const lookup = useGeoLookup(sel.lon, sel.lat)
  const coverage = coverageText(lookup.status === 'ok' ? lookup.data : null)
  const card = useMemo(() => describeLocation(report, { units, preset, mode: st.mode, nowMs, fireWeatherNote, tf }), [report, units, preset, st.mode, nowMs, fireWeatherNote, tf])
  const fireName = st.summary ? (/\bfire$/i.test(st.summary.name) ? `the ${st.summary.name}` : st.summary.name) : null
  const block = useMemo(() => officialBlock(official, { nowMs, units, fireName, incidentUrl: st.summary?.url ?? null }), [official, nowMs, units, fireName, st.summary?.url])
  const command = preset === 'command'
  const detailsOpen = useCardPrefs((s) => s.detailsOpen[preset])
  const narrow = useNarrow()
  // phones: a short bottom sheet until the user asks for more; every new point starts short again
  const selKey = `${sel.source}|${sel.lat}|${sel.lon}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const compact = narrow && expandedFor !== selKey
  return (
    <CardFrame sel={sel} title={card.title} titleIsCoords={card.titleIsCoords} type={card.locationType} approximate={card.approximate} command={command}>
      {coverage && <CoverageNotice text={coverage} />}
      {loadingFire ? (
        // the selected point stays; its check waits for the fire's data instead of showing "no data"
        <div className="loc-headline is-muted" role="status">
          <p className="loc-block-title">Near here</p>
          <p className="loc-headline-text">Loading {fireName ?? 'the fire'}’s data for this spot…</p>
        </div>
      ) : (
        <NearBlock card={card} />
      )}
      <OfficialSection block={block} compact={compact} />
      {!loadingFire && <ReasonsBlock card={card} compact={compact} command={command} />}
      {loadingFire ? null : compact ? (
        <button type="button" className="mw-btn is-sm loc-expand" aria-expanded="false" onClick={() => setExpandedFor(selKey)}>
          <ChevronDown size={13} aria-hidden="true" /> More about this location
        </button>
      ) : (
        <>
          <ReliabilityBlock card={card} zone={zoneLine(tf, timeMs, zoneSource)} />
          <Details card={card} command={command} open={detailsOpen} onToggle={(open) => useCardPrefs.getState().setDetailsOpen(preset, open)} />
        </>
      )}
    </CardFrame>
  )
}

/** Block 1: near here (the kind tag leads its sub-line: Mapped / Estimate / Unknown). */
function NearBlock({ card }: { card: LocationCardModel }) {
  const n = card.summary.near
  return (
    <>
      <div className={`loc-headline is-${n.tone}`} role="status">
        <p className="loc-block-title">Near here</p>
        <p className="loc-headline-text">
          <span>{n.text}</span> <KindTag kind={n.kind} /> {n.stale && <StaleChip />}
        </p>
        {/* when the spot burned (an estimate) first, then the basis and its age */}
        {(n.burned || n.sub) && <p className="loc-headline-sub">{[n.burned, n.sub].filter(Boolean).join(' · ')}</p>}
      </div>
      {card.areaNote && <p className="loc-area-note">{card.areaNote}</p>}
    </>
  )
}

/** Block 3: up to three main reasons, each tagged, and the model (a dated sentence; Command adds the figure). */
function ReasonsBlock({ card, compact, command }: { card: LocationCardModel; compact: boolean; command: boolean }) {
  const { reasons, model, run } = card.summary
  if (!reasons.length && !model) return null
  return (
    <section className="loc-block loc-reasons" aria-label="Main factors">
      <h3 className="loc-block-title">What could bring fire here</h3>
      <ul className="loc-reason-list">
        {model && (
          <li className={`loc-reason loc-model is-${model.tone}`}>
            <p>
              {command && model.figure && <span className="loc-burn-figure mw-mono">{model.figure}</span>}
              <KindTag kind={model.kind} /> <span className="loc-model-text">{model.text}</span>
            </p>
            {model.missed && (
              <p className="loc-model-missed">
                <KindTag kind="Estimate" /> {model.missed}
              </p>
            )}
            {model.arrival && !compact && <p className="loc-model-arrival">{model.arrival}</p>}
            {/* Command: the model run and the arrival quantiles up front (C-R8) */}
            {command && run && !compact && (
              <div className="loc-run mw-mono">
                <p>{run.run}</p>
                {run.quantiles && <p>{run.quantiles}</p>}
              </div>
            )}
          </li>
        )}
        {!compact &&
          reasons.map((r) => (
            <li key={r.key} className="loc-reason">
              <p>
                <KindTag kind={r.kind} /> <span className="loc-reason-label">{r.label}:</span> {r.text}
                {r.official && (
                  <>
                    {' · '}
                    <KindTag kind="Official" /> {r.official}
                  </>
                )}
              </p>
            </li>
          ))}
      </ul>
    </section>
  )
}

/** Block 4: updated and reliability. */
function ReliabilityBlock({ card, zone }: { card: LocationCardModel; zone: string }) {
  return (
    <section className="loc-block loc-reliability" aria-label="Updated and reliability">
      <h3 className="loc-block-title">Updated and reliability</h3>
      <p className="loc-reliability-text">
        {card.summary.reliability.map((l, i) => (
          <span key={l.key} className={l.key === 'prototype' ? 'is-prototype' : undefined}>
            {i > 0 && ' · '}
            {l.text}
            {l.stale && (
              <>
                {' '}
                <StaleChip />
              </>
            )}
          </span>
        ))}
      </p>
      <p className="loc-zone">{zone}</p>
    </section>
  )
}

function Details({ card, command, open, onToggle }: { card: LocationCardModel; command: boolean; open: boolean; onToggle: (open: boolean) => void }) {
  // Command only: run ids and raw values stay out of Public (brief 2 C-R8)
  const technical = command ? card.sections.flatMap((s) => s.lines).filter((l) => l.technical) : []
  return (
    <details className="loc-more" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
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
  )
}
