// Command's left readout (brief 4, CommandView.dc.html; PLAN-4 §3.2; CONTRACT §15.2, frozen after H2). No panel: text
// on the map's left edge gradient (map/MapAtmosphere.tsx), at left 40 / top 100 / 420 px wide. Top to bottom:
//   "SELECTED POINT" (what was picked: point, address, event) with copy / centre / clear;
//   the point in mono 30 px on two lines, then DMS · UTM · WGS84 on one mono line;
//   the near-here sentence with outlined tags (Mapped + its time, Stale + the age);
//   the MODEL line (dated, experimental) and the model's accuracy line;
//   the official information at the point (compact: the first zone verbatim, the NWS line, not an all-clear);
//   "value — LABEL" rows from the agency record: BURNED, CONTAINED, REPORTED LOCATION · issuer (copy, centre),
//   INCIDENT ID (copy), RECORD UPDATED · issuer;
//   "More about this spot": the run figure, the model run and the arrival quantiles, the main factors, updated and
//   reliability, and the details (sources, uncertainty, scientific values); open or closed is remembered per preset.
// Without a selected point: "Click the map or search to select a point" and the record rows. The data and words come
// from the location check shared with the Public card (LocationCard.tsx useLocationCheck, describe.ts). Phones: a
// bottom sheet whose peek line is the selected point (else the reported location).
import { ChevronDown, ChevronUp, Crosshair, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { recordIssuerLabel } from '../api/records'
import { formatDecimalPair, formatLat, formatLon } from '../lib/geodesy'
import { agencyIdLine } from '../lib/recordText'
import { fmtAt, localYear, recordYearMode } from '../lib/time'
import { useOfficialAtPoint } from '../official/hooks'
import { useOpenFireAccuracy } from '../state/accuracy'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { isDemoBundle, useWorkspace, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { ReadoutRow } from '../ui/shell/Readout'
import { useCardPrefs } from './cardPrefs'
import { CoverageNotice, KindTag, OfficialSection } from './CardParts'
import { CopyButton } from './CoordinateStrip'
import { coordinateLine, nearSentence, selectedLabel } from './readoutText'
import type { LocationCardModel, NearHere } from './describe'
import { DetailsBody, ReasonsBlock, ReliabilityBlock } from './LocationCard'
import { useLocationCheck } from './useLocationCheck'
import { useNarrow } from './useNarrow'
import './location.css'

const flyTo = (lat: number, lon: number) => useWorkspace.getState().requestMapFlyTo({ lon, lat, zoom: Math.max(useWorkspace.getState().view?.zoom ?? 13, 13) })

/** The open fire's UTM zone (the bundle's grid), else null. */
function useUtmZone(): number | null {
  return useStore((s) => (s.manifest?.status === 'ready' ? (s.manifest.grid.utm_zone ?? null) : null))
}

// ------------------------------------------------------------------------------------------------ header + point
function Head({ sel, title }: { sel: SelectedLocation | null; title: string }) {
  const clear = useWorkspace((s) => s.clearSelection)
  return (
    <header className="cro-head">
      <h2 className="cro-eyebrow" id="cro-title">
        {title}
      </h2>
      {sel && (
        <span className="cro-actions">
          <CopyButton text={formatDecimalPair(sel.lat, sel.lon)} label="Copy coordinates" />
          <button type="button" className="mw-icon-btn cro-btn" aria-label="Center the map on the selected point" data-tip="Center the map here" onClick={() => flyTo(sel.lat, sel.lon)}>
            <Crosshair size={14} />
          </button>
          <button type="button" className="mw-icon-btn cro-btn" aria-label="Clear the selected point" data-tip="Clear the selected point" onClick={clear}>
            <X size={14} />
          </button>
        </span>
      )}
    </header>
  )
}

function Point({ lat, lon, zone }: { lat: number; lon: number; zone: number | null }) {
  return (
    <>
      <p className="cro-point mw-mono">
        <span>{formatLat(lat)}</span>
        <span>{formatLon(lon)}</span>
      </p>
      <p className="cro-coords mw-mono">{coordinateLine(lat, lon, zone)}</p>
    </>
  )
}

// ------------------------------------------------------------------------------------------------ the check
/** Outlined mono tags: "MAPPED OCT 22, 07:59 PDT (2 D AGO)" / "ESTIMATE …", "STALE · 32 H". */
function NearTags({ n }: { n: NearHere }) {
  if (!n.kind && !n.stale) return null
  return (
    <p className="cro-tags">
      {n.kind && (
        <span className={`cro-tag is-${n.kind.toLowerCase().replace(/\s+/g, '-')}`} data-tip={n.basis ? `${n.kind}: ${n.basis}` : undefined}>
          {n.kind}
          {n.basis ? ` · ${n.basis.replace(/^mapped /, '')}` : ''}
        </span>
      )}
      {n.stale && (
        <span className="cro-tag is-stale" data-tip="The newest fire observation is more than 6 hours old: check the time before relying on it">
          Stale{n.staleFor ? ` · ${n.staleFor}` : ''}
        </span>
      )}
    </p>
  )
}

function ModelLine({ card }: { card: LocationCardModel }) {
  const model = card.summary.model
  const accuracy = useOpenFireAccuracy().label
  if (!model) return null
  // Command's sentence ("23 of 31 model runs burned this spot by …") does not say "experimental": the tag does
  const experimental = /experimental/i.test(model.text)
  return (
    <div className={`cro-model is-${model.tone}`}>
      <p>
        <span className="cro-tag is-model" data-tip="Output of Fire-3d's experimental fire-spread model: not observed, not an evacuation order">
          {experimental ? 'Model' : 'Experimental model'}
        </span>{' '}
        {model.text}
      </p>
      {model.missed && (
        <p className="cro-model-sub">
          <KindTag kind="Estimate" /> {model.missed}
        </p>
      )}
      {accuracy && model.kind === 'Model' && (
        <p className="cro-model-sub">
          {accuracy.commandLine} {accuracy.always}
        </p>
      )}
    </div>
  )
}

/** "More about this spot": the rest of the location check, collapsed by default and remembered per preset: the run
 *  figure, the model run and the arrival quantiles, the main factors, updated and reliability, the details. */
function More({ card, zone }: { card: LocationCardModel; zone: string }) {
  const preset = useWorkspace((s) => s.preset)
  const open = useCardPrefs((s) => s.detailsOpen[preset])
  const model = card.summary.model
  const run = card.summary.run
  return (
    <details className="cro-more" open={open} onToggle={(e) => useCardPrefs.getState().setDetailsOpen(preset, e.currentTarget.open)}>
      <summary>
        <ChevronDown size={13} aria-hidden="true" className="cro-more-chev" />
        More about this spot
      </summary>
      <div className="cro-more-body">
        {model?.figure && <ReadoutRow value={model.figure.replace(/\s*%$/, '')} unit="%" label="Model runs that burned this spot · experimental" />}
        {run && (
          <div className="cro-run mw-mono">
            <p>{run.run}</p>
            {run.quantiles && <p>{run.quantiles}</p>}
          </div>
        )}
        <ReasonsBlock card={card} compact={false} command withModel={false} />
        <ReliabilityBlock card={card} zone={zone} />
        <DetailsBody card={card} command />
      </div>
    </details>
  )
}

function SelectedCheck({ sel, zone }: { sel: SelectedLocation; zone: number | null }) {
  const official = useOfficialAtPoint(sel.lon, sel.lat)
  const v = useLocationCheck(sel, official)
  const { card } = v
  const n = card.summary.near
  const named = !card.titleIsCoords
  return (
    <>
      <Head sel={sel} title={selectedLabel(sel)} />
      <Point lat={sel.lat} lon={sel.lon} zone={zone} />
      {(named || card.approximate) && (
        <p className="cro-place">
          {named && <span className="cro-place-name">{card.title}</span>}
          {card.approximate && <span className="loc-kind is-approximate">Approximate</span>} <span className="cro-place-type">{card.locationType}</span>
        </p>
      )}
      {v.coverage && <CoverageNotice text={v.coverage} />}
      {v.loadingFire ? (
        <p className="cro-near is-muted" role="status">
          Loading {v.fireName ?? 'the fire'}’s data for this spot…
        </p>
      ) : (
        <div className={`cro-near-block is-${n.tone}`} role="status">
          <p className="cro-near">{nearSentence(n)}</p>
          <NearTags n={n} />
          {card.areaNote && <p className="cro-area-note">{card.areaNote}</p>}
        </div>
      )}
      {!v.loadingFire && <ModelLine card={card} />}
      <div className="cro-official">
        <OfficialSection block={v.block} compact />
        {v.block.evacuation.length + v.block.moreZones > 1 && (
          <p className="cro-official-more">+{v.block.evacuation.length - 1 + v.block.moreZones} more listed here: see Official now.</p>
        )}
      </div>
      <RecordRows />
      {!v.loadingFire && <More card={card} zone={v.zone} />}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ record rows
/** "value — LABEL" rows from the open fire's agency record (the list summary; official values only, never the model)
 *  and its identifiers. */
export function RecordRows() {
  const st = useStore(
    useShallow((s) => ({
      summary: s.summary && s.summary.id === s.incidentId ? s.summary : null,
      incidentId: s.incidentId,
      demo: isDemoBundle(s.incidentId, s.manifest),
    })),
  )
  const tf = useTimeFormat()
  const nowMs = useNow(60_000)
  const { summary, incidentId } = st
  if (!incidentId) return null
  const issuer = summary ? recordIssuerLabel(summary) : null
  const issuerTag = issuer ? ` · ${issuer}` : ''
  const reported = summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon) ? summary : null
  const yearMode = summary ? recordYearMode([summary.updated_ms], tf.tz, [summary.year, localYear(nowMs, tf.tz)]) : 'never'
  const agencyId = summary ? agencyIdLine(summary) : null
  return (
    <section className="cro-rows" aria-label="Agency record and identifiers">
      {summary ? (
        <>
          <ReadoutRow value={summary.acres != null ? Math.round(summary.acres).toLocaleString('en-US') : 'Not given'} unit={summary.acres != null ? 'ac' : undefined} label="Burned" />
          <ReadoutRow value={summary.percent_contained != null ? String(Math.round(summary.percent_contained)) : 'Not given'} unit={summary.percent_contained != null ? '%' : undefined} label="Contained" />
          <ReadoutRow
            size={17}
            value={summary.updated_ms != null ? fmtAt(summary.updated_ms, tf, { zone: true, year: yearMode }) : 'No update time given'}
            label={`Record updated${issuerTag}`}
          />
        </>
      ) : (
        <p className="cro-rows-loading">Loading the agency record…</p>
      )}
      {reported && (
        // "value — LABEL" with two actions: copy the coordinates, centre the map on them (the coordinate strip's pair)
        <div className="ro-row ro-17 cro-reported">
          <span className="ro-value">
            {formatLat(reported.lat)} · {formatLon(reported.lon)}
          </span>
          <span className="cro-row-btns">
            <CopyButton text={formatDecimalPair(reported.lat, reported.lon)} label="Copy reported incident coordinates" />
            <button
              type="button"
              className="mw-icon-btn cro-btn"
              aria-label="Center the map on the reported incident location"
              data-tip="Where the incident was reported in the incident data. It is not necessarily where the fire started."
              onClick={() => flyTo(reported.lat, reported.lon)}
            >
              <Crosshair size={13} />
            </button>
          </span>
          <span className="ro-label">— Reported location{issuerTag}</span>
        </div>
      )}
      <ReadoutRow size={17} value={incidentId} label="Incident ID" copy={incidentId} sub={agencyId ?? undefined} />
      {st.demo && <p className="cro-demo-note">Demo data: a simulated fire, not an agency record.</p>}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ phones: peek line
function Peek({ sel, open, onToggle }: { sel: SelectedLocation | null; open: boolean; onToggle: () => void }) {
  const summary = useStore((s) => (s.summary && s.summary.id === s.incidentId ? s.summary : null))
  const pt = sel
    ? { label: sel.source === 'address' ? 'Address' : 'Selected', lat: sel.lat, lon: sel.lon, kind: 'selected' }
    : summary && Number.isFinite(summary.lat) && Number.isFinite(summary.lon)
      ? { label: 'Reported', lat: summary.lat, lon: summary.lon, kind: 'incident' }
      : null
  return (
    <div className="cro-peek">
      {pt ? (
        <>
          <span className={`cro-peek-label is-${pt.kind}`}>{pt.label}</span>
          <span className="cro-peek-value mw-mono">
            {formatLat(pt.lat)}, {formatLon(pt.lon)}
          </span>
          <CopyButton text={formatDecimalPair(pt.lat, pt.lon)} label={`Copy ${pt.kind === 'incident' ? 'reported incident' : 'selected'} coordinates`} />
        </>
      ) : (
        <span className="cro-peek-value">Search or click the map to get coordinates</span>
      )}
      <button type="button" className="mw-icon-btn cro-peek-toggle" aria-expanded={open} aria-controls="cro-body" aria-label={open ? 'Show the one-line coordinates' : 'Show the selected point, the record and the identifiers'} onClick={onToggle}>
        {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ the readout
export function CommandReadout() {
  const sel = useWorkspace((s) => s.selection)
  const zone = useUtmZone()
  const narrow = useNarrow()
  const [sheetOpen, setSheetOpen] = useState(false)
  // phones: a newly picked point opens the sheet (the check is why it was picked); the peek stays one tap away
  const selKey = sel ? `${sel.source}|${sel.lat}|${sel.lon}` : null
  const lastKey = useRef(selKey)
  useEffect(() => {
    if (selKey !== lastKey.current && selKey != null) setSheetOpen(true)
    lastKey.current = selKey
  }, [selKey])
  const open = !narrow || sheetOpen
  return (
    <section className={`cro${narrow ? ' is-sheet' : ''}${open ? ' is-open' : ''}`} aria-labelledby={open ? 'cro-title' : undefined} aria-label={open ? undefined : 'Coordinates, WGS84'}>
      {narrow && <span className="mw-sheet-handle" aria-hidden="true" />}
      {narrow && <Peek sel={sel} open={sheetOpen} onToggle={() => setSheetOpen((o) => !o)} />}
      {open && (
        <div className="cro-body" id="cro-body">
          {sel ? (
            <SelectedCheck sel={sel} zone={zone} />
          ) : (
            <>
              <Head sel={null} title="Selected point" />
              <p className="cro-empty">Click the map or search to select a point</p>
              <RecordRows />
            </>
          )}
        </div>
      )}
    </section>
  )
}
