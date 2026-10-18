// The location card on the California overview (owner: location; brief 2 O-R9). No fire is open, so there is no
// fire-area check and no model here: the card shows the official line at the point (useOfficialAtPoint, I5) and the
// nearest fires, measured from CAL FIRE's reported location of each (not its edge), and never turns a distance into a
// risk statement. When a prepared fire's analysis area contains the point, it offers "Zoom to the <name> Fire", an
// explicit open that frames it (brief 2 decision 10; zooming in focuses it as well); other prepared fires open the
// same way from their row, and unprepared ones open their card (I3), which asks before preparing an analysis.
import { ArrowRight, ChevronDown, Flame } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentSummary } from '../api/types'
import type { OfficialInfo } from '../official/hooks'
import { directionWord, distance, area } from '../lib/plainLanguage'
import { fmtDateTime, fmtRelative, tzLabel } from '../lib/time'
import { fireFlyTo, fireStatus, isActiveFire } from '../state/overview'
import { useStore } from '../state/store'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { detailsFor, useAddressDetails } from './addressStore'
import { CardFrame, OfficialSection } from './CardParts'
import { PROTOTYPE_NOTE } from './describe'
import { incidentPool, overviewNearby, type NearFire } from './incidents'
import { checkLocation } from './locationCheck'
import { officialBlock } from './official'
import { openFromSearch } from './openFromSearch'
import { readiness, READINESS_LABEL } from './search'
import { makeRastersMissing } from './rastersMissing'
import { useNarrow } from './useNarrow'
import { formatLatLon } from '../lib/geodesy'
import './location.css'

const fireName = (s: Pick<IncidentSummary, 'name'>) => (/\bfire$/i.test(s.name) ? `the ${s.name}` : s.name)

function openOrShow(s: IncidentSummary) {
  const r = readiness(s)
  if (r === 'ready' || r === 'building') {
    openFromSearch(s.id) // the selected point stays: the card then checks it against the fire
    return
  }
  const req = fireFlyTo(s)
  if (req) useWorkspace.getState().requestMapFlyTo(req)
  useWorkspace.getState().setFireCard(s.id)
}

function FireRow({ f, units, label }: { f: NearFire; units: ReturnType<typeof useWorkspace.getState>['units']; label?: string }) {
  const s = f.summary
  const r = readiness(s)
  const status = fireStatus(s)
  const facts = [String(s.year), s.acres ? area(s.acres, units).text : null, status.label, READINESS_LABEL[r]].filter(Boolean).join(' · ')
  return (
    <li>
      <button type="button" className="loc-fire-row" onClick={() => openOrShow(s)} title={r === 'ready' || r === 'building' ? `Zoom to ${fireName(s)}` : `Show ${fireName(s)} and its card`}>
        <Flame size={14} aria-hidden="true" className={`loc-result-icon is-fire${isActiveFire(s) ? ' is-active' : ''}`} />
        <span className="loc-result-text">
          <span className="loc-fire-head">
            <span className="loc-result-title">
              {label && <span className="loc-fire-label">{label}: </span>}
              {s.name}
            </span>
            <span className="loc-fire-dist mw-mono">
              {distance(f.distanceM, units).text} {directionWord(f.bearingDeg)}
            </span>
          </span>
          <span className={`loc-result-sub is-${r}`}>{facts}</span>
        </span>
        <ArrowRight size={13} aria-hidden="true" className="loc-fire-go" />
      </button>
    </li>
  )
}

export function OverviewCard({ sel, official }: { sel: SelectedLocation; official: OfficialInfo }) {
  const units = useWorkspace((s) => s.units)
  const preset = useWorkspace((s) => s.preset)
  const nowMs = useNow(60_000)
  const narrow = useNarrow()
  const pool = useStore(useShallow((s) => incidentPool(s)))
  const listUpdated = useStore((s) => s.catalog.updatedMs)
  const lastAddress = useAddressDetails((s) => s.details)
  const address = detailsFor(sel, lastAddress)
  const block = useMemo(() => officialBlock(official, { nowMs, units, fireName: null, incidentUrl: null }), [official, nowMs, units])
  const near = useMemo(() => overviewNearby(pool, sel.lat, sel.lon, isActiveFire), [pool, sel.lat, sel.lon])
  // the point's own description (address type, approximate) without any fire data
  const point = useMemo(() => checkLocation({ point: sel, timeMs: nowMs, nowMs, summary: null, manifest: null, perimeters: [], detections: [], weather: null, forecast: null, rasters: makeRastersMissing(), address }).point, [sel, nowMs, address])
  const titleIsCoords = !point.address && point.label === formatLatLon(sel.lat, sel.lon, 5)
  const updated = Object.values(listUpdated ?? {}).filter((v): v is number => typeof v === 'number')
  const newest = updated.length ? Math.max(...updated) : null
  // phones: a short sheet until the user asks for more; every new point starts short again
  const selKey = `${sel.source}|${sel.lat}|${sel.lon}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const compact = narrow && expandedFor !== selKey
  const fires = compact ? near.fires.slice(0, 2) : near.fires
  return (
    <CardFrame
      sel={sel}
      title={point.label}
      titleIsCoords={titleIsCoords}
      type={point.locationType}
      approximate={point.approximate}
      command={preset === 'command'}
    >
      {near.inside && (
        <div className="loc-open-analysis">
          {/* an explicit open: it frames the fire and adds a history step (brief 2 decision 10); the point stays */}
          <button type="button" className="mw-btn is-primary loc-open-btn" onClick={() => openFromSearch(near.inside!.summary.id)}>
            Zoom to {fireName(near.inside.summary)}
          </button>
          {!compact && <p>This spot is inside {fireName(near.inside.summary)}’s analysis area: its spread and model check this spot.</p>}
        </div>
      )}
      <section className="loc-block loc-nearby" aria-label="Nearest fires">
        <h3 className="loc-block-title">Nearest fires (CAL FIRE)</h3>
        {near.fires.length ? (
          <ul className="loc-fire-list">
            {fires.map((f) => (
              <FireRow key={f.summary.id} f={f} units={units} />
            ))}
            {near.active && !compact && <FireRow f={near.active} units={units} label="Nearest active fire" />}
          </ul>
        ) : (
          <p className="loc-muted-line">No CAL FIRE incidents are loaded yet.</p>
        )}
        <p className="loc-note">Distance from here to where CAL FIRE reported each fire, not to its edge. Distance alone does not tell you the risk.</p>
      </section>
      <OfficialSection block={block} compact={compact} />
      {compact ? (
        <button type="button" className="mw-btn is-sm loc-expand" aria-expanded="false" onClick={() => setExpandedFor(selKey)}>
          <ChevronDown size={13} aria-hidden="true" /> More about this location
        </button>
      ) : (
        <section className="loc-block loc-reliability" aria-label="Updated and reliability">
          <h3 className="loc-block-title">Updated and reliability</h3>
          <ul>
            {newest != null && (
              <li>
                Fire list: CAL FIRE, checked {fmtRelative(newest, nowMs)} ({fmtDateTime(newest)} {tzLabel(newest)})
              </li>
            )}
            <li className="is-prototype">{PROTOTYPE_NOTE}</li>
          </ul>
        </section>
      )}
    </CardFrame>
  )
}
