// Aircraft list (header tab "Aircraft (n)", live incidents): callsign, type, category, altitude and speed of the
// aircraft polled every 10 s from /api/incidents/{id}/aircraft. Click a row to fly the camera there.
import { ArrowLeft, Navigation2, Plane, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Aircraft, AircraftCategory } from '../api/types'
import { fmtAltFt, fmtNumber, mToFt } from '../lib/format'
import { fmtRelative } from '../lib/time'
import { useStore } from '../state/store'
import { EmptyNote, Switch } from './controls'
import { CATEGORY_LABEL } from './options'
import { useNow } from './hooks'

const ORDER: AircraftCategory[] = ['airtanker', 'helicopter', 'air_attack', 'lead_plane', 'other_fire', 'unknown']

export function AircraftPanel() {
  const { aircraft, updated, meta, all, live } = useStore(
    useShallow((s) => ({ aircraft: s.aircraft, updated: s.aircraftUpdatedMs, meta: s.aircraftMeta, all: s.aircraftAll, live: s.mode === 'live' })),
  )
  const now = useNow(5000)
  const sorted = useMemo(
    () =>
      [...aircraft].sort(
        (a, b) => Number(b.is_fire_aircraft) - Number(a.is_fire_aircraft) || ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || (a.alt_m ?? 0) - (b.alt_m ?? 0),
      ),
    [aircraft],
  )
  const fire = aircraft.filter((a) => a.is_fire_aircraft).length
  const counts = ORDER.map((c) => [c, aircraft.filter((a) => a.category === c).length] as const).filter(([, n]) => n > 0)
  const st = useStore.getState
  return (
    <div className="acp">
      <div className="acp-head">
        <button type="button" className="icon-btn" aria-label="Back to the incident panel" data-tip="Back to Layers / Analysis" onClick={() => st().setHeaderTab('incident')}>
          <ArrowLeft size={14} />
        </button>
        <div className="acp-title">
          <span className="acp-name">Aircraft</span>
          <span className="mono muted small">
            {fmtNumber(fire)} fire · {meta.radiusNm ? `${fmtNumber(meta.radiusNm)} nm` : 'ADS-B'}
          </span>
        </div>
        <span className="acp-all">
          <span className="label">All traffic</span>
          <Switch checked={all} onChange={(v) => st().setAircraftAll(v)} label="Show all ADS-B traffic" />
        </span>
        <button type="button" className="icon-btn" aria-label="Refresh aircraft" data-tip="Refresh now" onClick={() => void st().refreshAircraft()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {counts.length > 0 && (
        <div className="acp-cats">
          {counts.map(([c, n]) => (
            <span key={c} className={`ac-chip ac-${c}`}>
              <i />
              {CATEGORY_LABEL[c]} <span className="mono">{n}</span>
            </span>
          ))}
        </div>
      )}
      {!live ? (
        <EmptyNote icon={<Plane size={15} />} title="Live incidents only">
          ADS-B aircraft are tracked for active incidents.
        </EmptyNote>
      ) : sorted.length === 0 ? (
        <EmptyNote icon={<Plane size={15} />} title={meta.error ? 'Aircraft feed unavailable' : 'No firefighting aircraft right now'}>
          {meta.error ?? meta.note ?? `Nothing matched within ${meta.radiusNm ?? 40} nm of the incident in the last poll.`}
        </EmptyNote>
      ) : (
        <div className="ac-table" role="table" aria-label="Aircraft">
          <div className="ac-row ac-headrow" role="row">
            <span role="columnheader">Callsign</span>
            <span role="columnheader">Type</span>
            <span role="columnheader" className="r">
              Alt ft
            </span>
            <span role="columnheader" className="r">
              kt
            </span>
            <span role="columnheader" className="r">
              Hdg
            </span>
          </div>
          {sorted.map((a) => (
            <AircraftRow key={a.hex} a={a} />
          ))}
        </div>
      )}
      <div className="acp-foot muted small">
        <span>
          Source <span className="mono">{meta.source ?? 'adsb.lol'}</span>
        </span>
        <span className="mono">{updated ? `updated ${fmtRelative(updated, now)}` : meta.polledMs ? 'polling…' : '—'}</span>
      </div>
      {meta.error && sorted.length > 0 && <div className="acp-err danger small">Last poll failed: {meta.error}</div>}
    </div>
  )
}

function AircraftRow({ a }: { a: Aircraft }) {
  const st = useStore.getState
  const alt = a.on_ground ? 'GND' : a.alt_m != null ? fmtNumber(Math.round(mToFt(a.alt_m) / 10) * 10) : '—'
  return (
    <button
      type="button"
      role="row"
      className={`ac-row ac-${a.category} ${a.is_fire_aircraft ? '' : 'is-other'} ${a.seen_s > 60 ? 'is-stale' : ''}`}
      onClick={() => {
        st().setLayerVisible('aircraft', true)
        st().requestFlyTo(a.x, a.z, 5000)
      }}
      data-tip={`${a.reason}${a.registration ? ` · ${a.registration}` : ''}${a.agl_m != null ? ` · AGL ${fmtAltFt(a.agl_m)}` : ''} · seen ${Math.round(a.seen_s)} s ago`}
    >
      <span className="ac-cs" role="cell">
        <i className="ac-bar" />
        <span className="mono">{a.callsign?.trim() || a.registration || a.hex.toUpperCase()}</span>
        <span className="ac-cat">{CATEGORY_LABEL[a.category]}</span>
      </span>
      <span className="mono secondary" role="cell">
        {a.type ?? '—'}
      </span>
      <span className="mono r" role="cell">
        {alt}
      </span>
      <span className="mono r" role="cell">
        {a.gs_kt != null ? fmtNumber(a.gs_kt) : '—'}
      </span>
      <span className="mono r ac-hdg" role="cell">
        {a.track_deg != null ? (
          <>
            <Navigation2 size={10} style={{ transform: `rotate(${a.track_deg}deg)` }} />
            {String(Math.round(a.track_deg)).padStart(3, '0')}
          </>
        ) : (
          '—'
        )}
      </span>
    </button>
  )
}
