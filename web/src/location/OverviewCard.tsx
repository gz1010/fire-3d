// The location card on the national overview (owner: us-web; brief 2 O-R9, brief 3 §14.10-14.11). No fire is open, so
// there is no fire-area check and no model here: the card shows whether Fire-3d covers the point (from
// /api/geo/lookup only: Alaska, Hawaii, territories and places outside the US say so, §14.14), the official line at the
// point (useOfficialAtPoint, I5) and the nearest fires, measured from the agency's reported location of each (not its
// edge), and never turns a distance into a risk statement. Times are local time at the point (the lookup's zone). When a prepared fire's analysis area contains the point, it offers "Zoom to the <name> Fire", an
// explicit open that frames it (brief 2 decision 10; zooming in focuses it as well); other prepared fires open the
// same way from their row, and unprepared ones open their card (I3), which asks before preparing an analysis.
import { ArrowRight, ChevronDown, Flame } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { IncidentSummary } from '../api/types'
import type { OfficialInfo } from '../official/hooks'
import { GEO_LOOKUP_CREDIT } from '../lib/dataCredits'
import { directionWord, distance, area } from '../lib/plainLanguage'
import { fmtAt, fmtRelative, zoneLine } from '../lib/time'
import { fireFlyTo, fireStatus, fireWhere, isActiveFire } from '../state/overview'
import { useStore } from '../state/store'
import { usePlaceZone, useTimeFormatFor } from '../state/timeZone'
import { useWorkspace, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { detailsFor, useAddressDetails } from './addressStore'
import { CardFrame, CoverageNotice, OfficialSection } from './CardParts'
import { coverageText, lookupPlace, nearestFiresMeaningful, UNLISTED_HERE_TEXT, useGeoLookup } from './geoLookup'
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
  const facts = [fireWhere(s), String(s.year), s.acres ? area(s.acres, units).text : null, status.label, READINESS_LABEL[r]].filter(Boolean).join(' · ')
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
  const lookup = useGeoLookup(sel.lon, sel.lat)
  const geo = lookup.status === 'ok' ? lookup.data : null
  const coverage = coverageText(geo)
  const listed = nearestFiresMeaningful(geo)
  // times at a point without a fire: local time at this place (the lookup's zone), else the viewer's, labelled
  const placeZone = geo?.supported ? geo.time_zone : null
  const tf = useTimeFormatFor(placeZone)
  useEffect(() => {
    usePlaceZone.getState().setPlaceZone(placeZone)
    return () => usePlaceZone.getState().setPlaceZone(null)
  }, [placeZone])
  const block = useMemo(() => officialBlock(official, { nowMs, units, fireName: null, incidentUrl: null, tf }), [official, nowMs, units, tf])
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
      {coverage && <CoverageNotice text={coverage} />}
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
        <h3 className="loc-block-title">Nearest fires (official records)</h3>
        {!listed ? (
          <p className="loc-muted-line">{UNLISTED_HERE_TEXT}</p>
        ) : near.fires.length ? (
          <ul className="loc-fire-list">
            {fires.map((f) => (
              <FireRow key={f.summary.id} f={f} units={units} />
            ))}
            {near.active && !compact && <FireRow f={near.active} units={units} label="Nearest active fire" />}
          </ul>
        ) : (
          <p className="loc-muted-line">No fire list is loaded yet.</p>
        )}
        {listed && (
          <p className="loc-note">
            Distance from here to where the agency (CAL FIRE in California, NIFC WFIGS elsewhere) reported each fire, not to its edge. Distance alone does not
            tell you the risk.
          </p>
        )}
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
            {lookupPlace(geo) && <li>Place: {lookupPlace(geo)}</li>}
            {/* the place and the time zone below come from Fire-3d's offline lookup (/api/geo/lookup, §14.13) */}
            {geo && <li className="loc-credit">{GEO_LOOKUP_CREDIT}</li>}
            {newest != null && (
              <li>
                Fire lists: CAL FIRE and NIFC WFIGS, checked {fmtRelative(newest, nowMs)} ({fmtAt(newest, tf, { zone: true })})
              </li>
            )}
            <li className="is-prototype">{PROTOTYPE_NOTE}</li>
          </ul>
          <p className="loc-zone">{zoneLine(tf, nowMs, placeZone ? 'place' : 'viewer')}</p>
        </section>
      )}
    </CardFrame>
  )
}
