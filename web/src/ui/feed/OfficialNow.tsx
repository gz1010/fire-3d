// "Official now" (owner: official-web; PLAN-2 U-R3, CONTRACT §13 I5): the official status of the open fire, pinned at
// the top of the updates panel and the phone sheet (mounted by shell). Three compact rows, each with its issuer, the
// issuer's own time, a source link and an explicit quiet state that says it is not an all-clear:
//   evacuations (Cal OES, zones within 15 km with their distance), CAL FIRE's incident record, NWS fire weather.
// Extras (agencies, county maps, recording notes, ended alerts) sit behind each row's "More". Shown whatever the map
// layers show; "Show" fits and highlights the official area. Official wording is verbatim, and the block never mixes
// in observations, estimates or model output.
import { ChevronDown, ExternalLink, Flag, Landmark, MapPinned, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MARGIN_KM } from '../../extras/client'
import { agoText, fmtWhen } from '../../extras/format'
import { calfireHistoryNote, changeTitleParts, laggedEditNote } from '../../official/calfire'
import { distanceText } from '../../official/geo'
import { useOfficialNow, type CalFireOfficial, type EvacuationOfficial, type FireWeatherOfficial } from '../../official/hooks'
import { forIncident } from '../../official/guard'
import { groupZones } from '../../official/model'
import { useOfficialRuntime } from '../../official/runtime'
import { showOfficialArea } from '../../official/select'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { useNow } from '../hooks'
import { NOT_AN_ORDER } from './feedMeta'

function SourceLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return null
  return (
    <a className="on-link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  )
}

type Tone = 'alert' | 'quiet' | 'muted' | 'info'

function Row({ icon, label, source, tone, aside, more, children }: { icon: ReactNode; label: string; source: string | null; tone: Tone; aside?: ReactNode; more?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={`on-row is-${tone}`}>
      <div className="on-row-head">
        <span className="on-row-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="on-row-label">{label}</span>
        {source && <span className="on-row-src">{source}</span>}
        {aside && <span className="on-row-aside">{aside}</span>}
      </div>
      {children}
      {more && (
        <>
          <button type="button" className="on-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Less' : 'More'}
            <ChevronDown size={11} aria-hidden="true" className={open ? 'is-open' : undefined} />
          </button>
          {open && <div className="on-extra">{more}</div>}
        </>
      )}
    </li>
  )
}

const checked = (ms: number | null | undefined, wallMs: number): string | null => (ms != null ? `checked ${agoText(ms, wallMs)}` : null)
const join = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ')

function EvacuationRow({ e, nowMs, wallMs, metric }: { e: EvacuationOfficial; nowMs: number; wallMs: number; metric: boolean }) {
  const highlightId = useOfficialRuntime((s) => s.highlight?.id ?? null)
  const groups = useMemo(() => groupZones(e.zones), [e.zones])
  const id = 'official-now:evacuation'
  const label = 'Evacuations'
  const source = 'via Cal OES'
  const icon = <TriangleAlert size={13} />
  const counties =
    e.links && e.links.length > 0 ? (
      <p className="on-meta">
        County maps:{' '}
        {e.links.map((l) => (
          <SourceLink key={l.url} href={l.url}>
            {l.label.replace(/ evacuation map$/, '')}
          </SourceLink>
        ))}
      </p>
    ) : null
  const layerOff = e.layerOff ? (
    <p className="on-meta">
      The evacuation map layer is off.{' '}
      <button type="button" className="on-link-btn" onClick={() => useWorkspace.getState().setMapLayer('evacuation', true)}>
        Show zones on the map
      </button>
    </p>
  ) : null
  if (e.state === 'loading')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">Checking Cal OES…</p>
      </Row>
    )
  if (e.state === 'past-date')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">
          <strong>Not available for past dates.</strong> Cal OES publishes current status only. Follow local officials.
        </p>
      </Row>
    )
  if (e.state === 'unavailable' || e.state === 'not-checked' || e.state === 'not-available')
    return (
      <Row icon={icon} label={label} source={e.state === 'not-available' ? null : source} tone="muted" more={counties ?? undefined}>
        <p className="on-line">
          <strong>{e.state === 'unavailable' ? 'Unavailable right now.' : e.state === 'not-available' ? 'Not available in this state.' : 'Not checked.'}</strong> {e.reason ?? ''} Follow local officials.
        </p>
      </Row>
    )
  if (e.state === 'none-listed')
    return (
      <Row
        icon={icon}
        label={label}
        source={source}
        tone="quiet"
        aside={<SourceLink href={e.sourceUrl}>Source</SourceLink>}
        more={
          counties || layerOff ? (
            <>
              {counties}
              {layerOff}
            </>
          ) : undefined
        }
      >
        <p className="on-line">
          <strong>None listed within {DEFAULT_MARGIN_KM.evacuations} km of this fire.</strong> Not an all-clear: follow local officials.
        </p>
        <p className="on-meta">{join([e.sourceUpdatedMs != null && `Cal OES updated ${fmtWhen(e.sourceUpdatedMs, nowMs)}`, checked(e.checkedMs, wallMs)])}</p>
      </Row>
    )
  const shown = groups.slice(0, 2)
  const more = groups.length - shown.length
  const active = highlightId === id
  const show = e.bounds ? (
    <button type="button" className="on-btn" aria-pressed={active} onClick={() => showOfficialArea({ kind: 'evacuation', id, zoneIds: e.zones.map((z) => z.id) }, e.bounds, { toggle: true })}>
      <MapPinned size={12} aria-hidden="true" /> {active ? 'Shown' : 'Show'}
    </button>
  ) : null
  return (
    <Row
      icon={icon}
      label={label}
      source={source}
      tone="alert"
      aside={show}
      more={
        <>
          {counties}
          {layerOff}
          <p className="on-meta">
            {e.sourceUpdatedMs != null ? `Cal OES updated ${fmtWhen(e.sourceUpdatedMs, nowMs)}. ` : ''}
            <SourceLink href={e.sourceUrl}>Cal OES data</SourceLink>
          </p>
        </>
      }
    >
      {shown.map((g) => (
        <div key={`${g.status}|${g.issuer}`} className={`on-zone is-${g.group}`}>
          <p className="on-line">
            <strong className="on-official">{g.status}</strong> · {g.zones.length} zone{g.zones.length === 1 ? '' : 's'} · {g.issuer}
          </p>
          <p className="on-meta">
            {join([
              g.distanceKm == null ? null : g.distanceKm === 0 ? 'touches the fire area' : `${distanceText(g.distanceKm, metric)} from the fire`,
              g.outsideAnalysisArea ? 'Cal OES does not say which fire this is for' : null,
            ])}
          </p>
          <p className="on-meta">
            {join([
              g.updatedMs != null ? `Updated by the issuer ${fmtWhen(g.updatedMs, nowMs)}` : g.listedMs != null ? `Listed by Cal OES ${fmtWhen(g.listedMs, nowMs)} (no issuer time)` : 'No issuer time',
              checked(e.checkedMs, wallMs),
            ])}
          </p>
        </div>
      ))}
      {more > 0 && <p className="on-meta">+{more} more official status{more === 1 ? '' : 'es'}: see the Official filter.</p>}
    </Row>
  )
}

function CalfireRow({ c, nowMs, wallMs, live }: { c: CalFireOfficial; nowMs: number; wallMs: number; live: boolean }) {
  const label = 'CAL FIRE'
  const source = 'incident record'
  const icon = <ShieldAlert size={13} />
  const mode = useStore((s) => (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)))
  const incidentId = useStore((s) => s.incidentId)
  const last = useOfficialRuntime((s) => {
    const d = forIncident(s.calfire.data, incidentId)
    const ch = d?.current ? d.changes : null
    return ch?.length ? ch.reduce((a, b) => ((b.updated_ms ?? b.seen_ms) > (a.updated_ms ?? a.seen_ms) ? b : a)) : null
  })
  if (c.state === 'loading')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">Checking CAL FIRE…</p>
      </Row>
    )
  if (c.state === 'unavailable')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">
          <strong>No record shown.</strong> {c.reason ?? ''}
        </p>
      </Row>
    )
  const status = c.final ? 'final record' : c.isActive === false ? 'not active' : c.isActive ? 'active' : null
  const note = calfireHistoryNote(c, mode)
  const lagged = laggedEditNote(c)
  const lastParts = last ? changeTitleParts(last) : []
  const extra =
    c.agencies || note ? (
      <>
        {c.agencies && <p className="on-meta">Agencies: {c.agencies}</p>}
        {note && <p className="on-meta">{note}</p>}
      </>
    ) : undefined
  return (
    <Row icon={icon} label={label} source={source} tone="info" aside={<SourceLink href={c.url}>Incident page</SourceLink>} more={extra}>
      <p className="on-line">
        <strong className="on-official">
          {join([
            c.acres != null ? `${Math.round(c.acres).toLocaleString('en-US')} acres` : 'area not stated',
            c.percentContained != null ? `${Math.round(c.percentContained)} % contained` : 'containment not stated',
            status,
          ])}
        </strong>
      </p>
      {live && lastParts.length > 0 && <p className="on-meta">Last change: {lastParts.join(' · ')}</p>}
      {c.reason && <p className="on-meta">{c.reason}</p>}
      {lagged && <p className="on-meta">{lagged}</p>}
      <p className="on-meta">
        {join([
          c.updatedMs != null ? `Updated by CAL FIRE ${fmtWhen(c.updatedMs, nowMs)}` : 'CAL FIRE gives no update time',
          !live && c.containedMs != null ? `contained ${fmtWhen(c.containedMs, nowMs)}` : null,
          checked(c.checkedMs, wallMs),
        ])}
      </p>
    </Row>
  )
}

function FireWeatherRow({ f, nowMs, wallMs, metric, statewide = false }: { f: FireWeatherOfficial; nowMs: number; wallMs: number; metric: boolean; statewide?: boolean }) {
  const highlightId = useOfficialRuntime((s) => s.highlight?.id ?? null)
  const label = 'Fire weather'
  const source = f.archived ? 'NWS, archived copy' : 'NWS'
  const icon = <Flag size={13} />
  if (f.state === 'loading')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">Checking NWS alerts…</p>
      </Row>
    )
  if (f.state === 'past-date' || f.state === 'unavailable')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">
          <strong>{f.state === 'past-date' ? 'Not available for this time.' : 'Unavailable right now.'}</strong> {f.reason ?? ''} That does not mean there were no alerts.
        </p>
      </Row>
    )
  const inEffect = f.alerts.filter((a) => a.phase === 'active' || a.phase === 'upcoming')
  const ended = f.alerts.filter((a) => a.phase === 'expired' || a.phase === 'cancelled')
  const endedLines = ended.length ? (
    <>
      {ended.map((a) => (
        <p key={a.id} className="on-meta">
          {a.event}: {a.timeText} · {a.senderName} <SourceLink href={a.url}>Source</SourceLink>
        </p>
      ))}
    </>
  ) : undefined
  if (inEffect.length === 0)
    return (
      <Row icon={icon} label={label} source={source} tone="quiet" aside={<SourceLink href={f.sourceUrl}>Source</SourceLink>} more={endedLines}>
        <p className="on-line">
          <strong>
            No Red Flag Warning or Fire Weather Watch {f.archived ? 'in effect at this time' : 'in effect'} {statewide ? 'in California' : 'near this fire'}.
          </strong>{' '}
          Not an all-clear.
        </p>
        <p className="on-meta">{join([checked(f.checkedMs, wallMs), ended.length ? `${ended.length} ended in the last 48 h` : null])}</p>
      </Row>
    )
  return (
    <Row
      icon={icon}
      label={label}
      source={source}
      tone="alert"
      more={
        <>
          {inEffect.map((a) =>
            a.headline ? (
              <p key={a.id} className="on-quote">
                {a.headline}
              </p>
            ) : null,
          )}
          {endedLines}
          <p className="on-meta">A fire weather alert is a weather warning, not an evacuation order.</p>
        </>
      }
    >
      {statewide && inEffect.length > 3 && <p className="on-meta">{inEffect.length} alerts in effect in California; the 3 most recent:</p>}
      {(statewide ? inEffect.slice(0, 3) : inEffect).map((a) => {
        const id = `official-now:fw:${a.id}`
        const active = highlightId === id
        return (
          <div key={a.id} className="on-alert">
            <p className="on-line">
              <strong className="on-official">{a.event}</strong> {a.timeText}
            </p>
            <p className="on-meta">
              {join([
                a.senderName,
                a.sentMs != null ? `issued ${fmtWhen(a.sentMs, nowMs)}` : null,
                a.coversReportedLocation ? 'covers the fire area' : a.nearestKm != null ? `zone ${distanceText(a.nearestKm, metric)} from the fire` : null,
              ])}
            </p>
            <div className="on-actions">
              {a.bounds && (
                <button type="button" className="on-btn" aria-pressed={active} onClick={() => showOfficialArea({ kind: 'fire-weather', id, ugcs: a.ugcs, alertIds: [a.id] }, a.bounds, { toggle: true })}>
                  <MapPinned size={12} aria-hidden="true" /> {active ? 'Area shown' : 'Show area'}
                </button>
              )}
              <SourceLink href={a.url}>Source</SourceLink>
              <span className="on-meta">{checked(f.checkedMs, wallMs)}</span>
            </div>
          </div>
        )
      })}
    </Row>
  )
}

/** The block: the open fire's official status, or on the California overview the state's current NWS fire weather
 *  alerts with a pointer to zoom in on a fire (CONTRACT §13). */
export function OfficialNow() {
  const { evacuation, fireWeather, calfire } = useOfficialNow()
  const wallMs = useNow(30_000)
  const { hasIncident, live, minute } = useStore(
    useShallow((s) => ({
      hasIncident: s.incidentId != null,
      live: (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)) === 'live',
      minute: Math.floor(s.timeMs / 60_000),
    })),
  )
  // dates are written relative to now (live) or to the replay time, so an edit in another year shows its year
  const nowMs = live ? wallMs : minute * 60_000
  const metric = useWorkspace((s) => s.units === 'metric')
  if (!hasIncident)
    // the California overview: the state's current NWS alerts; zones and CAL FIRE's record need a fire
    return (
      <section className="on is-overview" aria-labelledby="on-title">
        <header className="on-head" data-tip="Agencies' own updates, with their wording, issuer, times and a link to the source">
          <Landmark size={13} aria-hidden="true" />
          <h3 id="on-title">Official now</h3>
          <span className="on-head-sub">California</span>
        </header>
        <ul className="on-rows">
          <FireWeatherRow f={fireWeather} nowMs={wallMs} wallMs={wallMs} metric={metric} statewide />
        </ul>
        <p className="on-meta">Official evacuation zones and CAL FIRE's record are shown for a fire: zoom in on a fire or pick one, or check an address.</p>
        <p className="on-foot">{NOT_AN_ORDER}</p>
      </section>
    )
  return (
    <section className="on" aria-labelledby="on-title">
      <header className="on-head" data-tip="Agencies' own updates, with their wording, issuer, times and a link to the source">
        <Landmark size={13} aria-hidden="true" />
        <h3 id="on-title">Official now</h3>
        {!live && <span className="on-head-sub">at the replay time</span>}
      </header>
      <ul className="on-rows">
        <EvacuationRow e={evacuation} nowMs={nowMs} wallMs={wallMs} metric={metric} />
        <CalfireRow c={calfire} nowMs={nowMs} wallMs={wallMs} live={live} />
        <FireWeatherRow f={fireWeather} nowMs={nowMs} wallMs={wallMs} metric={metric} />
      </ul>
      <p className="on-foot">{NOT_AN_ORDER}</p>
    </section>
  )
}
