// Dev preset `us-official` (CONTRACT §14.8.7; extras-dev.html?preset=us-official only, never part of the app). Renders,
// from recorded fixtures only (no backend request):
// - "Official now" on the overview with a national NWS answer (`states_checked` = the 49 codes; Red Flag Warnings in
//   Montana and Wyoming, each with its own times in its own zone);
// - the Official now "Local officials' alerts" row for a fire: a live message relayed by NWS (NWEM), an archived
//   message from FEMA's OpenFEMA archive with the required notice, and an archive channel still `pending`;
// - the location card's official block at a point in Jackson County, Oregon (near Medford), with Oregon OEM's zones:
//   levels with OEM's definitions and "added to the Oregon state layer" in Pacific time (12-hour, Public).
// The stores the real components read are seeded before the first render (usOfficialSeed.ts); window.__usOfficialDev
// exposes the inputs to screenshot scripts.
import { useEffect, useMemo } from 'react'
import { OR_EVAC_MEDFORD } from '../__fixtures__/samplesUs'
import { LOCAL_ARCHIVE_KERN_FRW, LOCAL_ARCHIVE_PENDING_BLACK_COVE, LOCAL_LIVE_LA_CEM, LOCAL_LIVE_NONE_RENO } from '../../official/__fixtures__/localAlerts'
import { FW_NATIONAL_MT_WY } from '../../official/__fixtures__/national'
import { localAlertsState } from '../../official/localAlerts'
import { evacuationAtPointState, fireWeatherAtPointState } from '../../official/model'
import { officialBlock } from '../../location/official'
import { OfficialSection } from '../../location/CardParts'
import { timeFmt } from '../../lib/time'
import { useNow } from '../../ui/hooks'
import { OfficialNow, LocalAlertsRow } from '../../ui/feed/OfficialNow'
import '../../location/location.css'
import '../../ui/feed/updatesFeed.css'

/** A point inside OEM's zone US-OR-JAC-JAC-043 (Fielders Mountain Fire, 2026-08-15 snapshot). */
const MEDFORD_POINT = { lon: -123.18767, lat: 42.45705, label: 'Jackson County, OR (near Medford)' }

const ok = <T,>(data: T) => ({ data, loading: false, error: null, refresh: () => {} })

/** The stores are seeded by usOfficialSeed.ts (main.tsx) before the first render. */
export function UsOfficialPreset() {
  const nowMs = useNow(60_000)
  const pacific12 = timeFmt('America/Los_Angeles', '12h')
  const card = useMemo(() => {
    const evacuation = evacuationAtPointState({ lon: MEDFORD_POINT.lon, lat: MEDFORD_POINT.lat, incident: null, incidentBbox: null, point: ok(OR_EVAC_MEDFORD), past: false, fire: null, pointState: 'OR' })
    const fireWeather = fireWeatherAtPointState({ lon: MEDFORD_POINT.lon, lat: MEDFORD_POINT.lat, refMs: nowMs, incident: null, statewide: ok(FW_NATIONAL_MT_WY), hasIncident: false, demo: false, past: false, fallbackArea: null, pointState: 'OR', tf: pacific12 })
    const local = localAlertsState(ok(LOCAL_LIVE_NONE_RENO))
    return officialBlock({ evacuation, fireWeather, calfire: { state: 'unavailable', reason: 'No fire selected.' }, local }, { nowMs, units: 'us', fireName: null, incidentUrl: null, tf: pacific12, maxZones: 4 })
  }, [nowMs, pacific12])
  const rows = useMemo(
    () => [
      { title: 'Live: a message relayed by the National Weather Service (NWEM)', l: localAlertsState(ok(LOCAL_LIVE_LA_CEM)) },
      { title: "Past day: an archived message from FEMA's OpenFEMA archive", l: localAlertsState(ok(LOCAL_ARCHIVE_KERN_FRW)) },
      { title: "Past day: FEMA's archive still being fetched (pending)", l: localAlertsState(ok(LOCAL_ARCHIVE_PENDING_BLACK_COVE)) },
    ],
    [],
  )
  useEffect(() => {
    window.__usOfficialDev = { point: MEDFORD_POINT, card, local: rows.map((r) => r.l) }
  }, [card, rows])
  return (
    <div className="xd-root uo-root" data-preset="us-official">
      <div className="uo-head">
        <h1>Dev preset: us-official</h1>
        <p>Recorded fixtures only, no backend. Brief 3, CONTRACT §14.6-14.8.</p>
      </div>
      <div className="uo-grid">
        <section className="uo-col" aria-label="Official now on the overview">
          <h2>Official now · overview (national NWS answer)</h2>
          <div className="uo-panel">
            <OfficialNow />
          </div>
        </section>
        <section className="uo-col" aria-label="Local officials' alerts">
          <h2>Official now · local officials&apos; alerts (a fire)</h2>
          {rows.map((r) => (
            <div key={r.title} className="uo-panel">
              <p className="uo-label">{r.title}</p>
              <section className="on">
                <ul className="on-rows">
                  <LocalAlertsRow l={r.l} wallMs={nowMs} />
                </ul>
              </section>
            </div>
          ))}
        </section>
        <section className="uo-col" aria-label="Location card">
          <h2>Location card · {MEDFORD_POINT.label}</h2>
          <div className="uo-panel loc-card">
            <OfficialSection block={card} compact={false} />
          </div>
        </section>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    __usOfficialDev?: { point: typeof MEDFORD_POINT; card: ReturnType<typeof officialBlock>; local: ReturnType<typeof localAlertsState>[] }
  }
}
