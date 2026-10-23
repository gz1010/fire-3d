// "Official now" (owner: official-web; PLAN-2 U-R3, CONTRACT §13 I5): the official status of the open fire, pinned at
// the top of the updates panel and the phone sheet (mounted by shell). Three compact rows, each with its issuer, the
// issuer's own time, a source link and an explicit quiet state that says it is not an all-clear:
//   evacuations (the state source: Cal OES, Oregon OEM; zones within 15 km with their distance; "not available in this
//   state" elsewhere), the fire's agency record (CAL FIRE's or NIFC WFIGS's, labelled from its issuer), NWS fire weather.
// Extras (agencies, county maps, recording notes, ended alerts) sit behind each row's "More". Shown whatever the map
// layers show; "Show" fits and highlights the official area. Official wording is verbatim, and the block never mixes
// in observations, estimates or model output.
import { ChevronDown, ExternalLink, Flag, Landmark, MapPinned, Megaphone, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DEFAULT_MARGIN_KM } from '../../extras/client'
import { agoText, fmtWhen } from '../../extras/format'
import { calfireHistoryNote, changeTitleParts, laggedEditNote } from '../../official/calfire'
import { distanceText } from '../../official/geo'
import { useOfficialNow, type CalFireOfficial, type EvacuationOfficial, type FireWeatherOfficial } from '../../official/hooks'
import { forIncident } from '../../official/guard'
import { evacuationWho, groupZones, officialNowScope, statewideCountText } from '../../official/model'
import { partOfComplex, recordBlockText, recordLinkLabel } from '../../official/record'
import {
  answeredChannelsText,
  ARCHIVE_CAVEAT,
  ARCHIVE_CREDIT,
  LOCAL_PLACE_NOTE,
  LOCAL_STANDING_CAVEAT,
  localAlertPlace,
  localPhaseText,
  OPENFEMA_NOTICE,
  OPENFEMA_TERMS_URL,
  sentText,
  type LocalAlertsOfficial,
} from '../../official/localAlerts'
import { alertTimeFmt } from '../../official/fireWeather'
import { useOfficialRuntime } from '../../official/runtime'
import { showOfficialArea } from '../../official/select'
import { useStore } from '../../state/store'
import { fmtAt, localYear, recordYearMode, zoneLine } from '../../lib/time'
import { useTimeFormat, useZoneSource } from '../../state/timeZone'
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

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** A reason as one sentence before "Follow local officials." (never said twice, always with its full stop). */
function reasonSentence(reason: string | null | undefined): string {
  const t = (reason ?? '').replace(/\s*:?\s*follow local officials\.?\s*$/i, '').trim()
  if (!t) return ''
  return /[.!?]$/.test(t) ? `${t} ` : `${t}. `
}

function EvacuationRow({ e, nowMs, wallMs, metric }: { e: EvacuationOfficial; nowMs: number; wallMs: number; metric: boolean }) {
  const highlightId = useOfficialRuntime((s) => s.highlight?.id ?? null)
  const groups = useMemo(() => groupZones(e.zones), [e.zones])
  const tf = useTimeFormat()
  const id = 'official-now:evacuation'
  const label = 'Evacuations'
  const who = evacuationWho(e) ?? 'the state source'
  const source = `via ${who}`
  // each source's own update time (several sources: one per source), and its data page
  const answered = (e.sources ?? []).filter((s) => s.answered)
  const updates = answered.length
    ? answered.map((s) => (s.updatedMs != null ? `${s.aggregator} updated ${fmtWhen(s.updatedMs, nowMs, tf)}` : null))
    : [e.sourceUpdatedMs != null ? `${who} updated ${fmtWhen(e.sourceUpdatedMs, nowMs, tf)}` : null]
  const dataLinks = answered.length ? answered.map((s) => ({ label: `${s.aggregator} data`, url: s.url })) : [{ label: `${who} data`, url: e.sourceUrl }]
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
        <p className="on-line">Checking official evacuation zones…</p>
      </Row>
    )
  if (e.state === 'past-date')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">
          <strong>Not available for past dates.</strong> {who} {who.includes(' and ') ? 'publish' : 'publishes'} current status only. Follow local officials.
        </p>
      </Row>
    )
  if (e.state === 'not-available')
    return (
      <Row icon={icon} label={label} source={null} tone="muted">
        <p className="on-line">
          {e.notAvailableIn && e.notAvailableIn.length ? (
            // CONTRACT §14.14 (full form)
            <strong>Official evacuation zones are not available in {e.notAvailableIn.length === 1 ? `this state (${e.notAvailableIn[0]})` : `these states (${e.notAvailableIn.join(', ')})`}.</strong>
          ) : (
            <strong>{e.reason ?? 'Official evacuation zones are not available here.'}</strong>
          )}{' '}
          Follow local officials.
        </p>
      </Row>
    )
  if (e.state === 'unavailable' || e.state === 'not-checked')
    return (
      <Row icon={icon} label={label} source={e.state === 'unavailable' ? source : null} tone="muted" more={counties ?? undefined}>
        <p className="on-line">
          <strong>{e.state === 'unavailable' ? 'Unavailable right now.' : 'Not checked.'}</strong> {reasonSentence(e.reason)}Follow local officials.
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
        <p className="on-meta">{join([...updates, checked(e.checkedMs, wallMs)])}</p>
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
            {updates.filter(Boolean).map((u) => `${u}. `)}
            {dataLinks.map((l) => (
              <SourceLink key={l.label} href={l.url}>
                {l.label}
              </SourceLink>
            ))}
          </p>
        </>
      }
    >
      {shown.map((g) => (
        <div key={`${g.status}|${g.issuer}|${g.aggregator}`} className={`on-zone is-${g.group}`}>
          <p className="on-line">
            <strong className="on-official">{g.status}</strong> · {g.zones.length} zone{g.zones.length === 1 ? '' : 's'} · {g.issuer}
          </p>
          {!g.verbatim && <p className="on-meta">{`${g.aggregator}'s level number, with ${g.aggregator}'s definition (shown by Fire-3d)`}</p>}
          <p className="on-meta">
            {join([
              g.distanceKm == null ? null : g.distanceKm === 0 ? 'touches the fire area' : `${distanceText(g.distanceKm, metric)} from the fire`,
              g.outsideAnalysisArea ? `${g.aggregator} does not say which fire this is for` : null,
            ])}
          </p>
          <p className="on-meta">
            {join([
              g.updatedMs != null ? `Updated by the issuer ${fmtWhen(g.updatedMs, nowMs, tf)}` : g.listedMs != null ? `${capital(g.listedPhrase)} ${fmtWhen(g.listedMs, nowMs, tf)} (no issuer time)` : 'No issuer time',
              checked(e.checkedMs, wallMs),
            ])}
          </p>
        </div>
      ))}
      {more > 0 && <p className="on-meta">+{more} more official status{more === 1 ? '' : 'es'}: see the Official filter.</p>}
    </Row>
  )
}

function RecordRow({ c, nowMs, wallMs, live }: { c: CalFireOfficial; nowMs: number; wallMs: number; live: boolean }) {
  const tf = useTimeFormat()
  // labelled from the record's issuer (CONTRACT §14.5): "CAL FIRE", "USFS (USDA Forest Service) via NIFC WFIGS"
  const issuer = c.issuer ?? 'CAL FIRE'
  // a long issuer ("USFS (USDA Forest Service) via NIFC WFIGS") is named in full in the row's text; the header keeps
  // the publisher's short name so the link stays visible
  const label = issuer.length > 18 ? (c.linkLabel ?? issuer) : issuer
  const source = 'incident record'
  const icon = <ShieldAlert size={13} />
  const mode = useStore((s) => (s.manifest?.status === 'ready' ? s.manifest.mode : (s.summary?.mode ?? s.mode)))
  const incidentId = useStore((s) => s.incidentId)
  const fireYear = useStore((s) => s.summary?.year ?? null)
  const last = useOfficialRuntime((s) => {
    const d = forIncident(s.calfire.data, incidentId)
    const ch = d?.current ? d.changes : null
    return ch?.length ? ch.reduce((a, b) => ((b.updated_ms ?? b.seen_ms) > (a.updated_ms ?? a.seen_ms) ? b : a)) : null
  })
  if (c.state === 'loading')
    return (
      <Row icon={icon} label={issuer === 'Agency record' ? 'Fire record' : label} source={source} tone="muted">
        <p className="on-line">Checking the agency record…</p>
      </Row>
    )
  if (c.state === 'unavailable')
    return (
      <Row icon={icon} label={issuer === 'Agency record' ? 'Fire record' : label} source={source} tone="muted">
        <p className="on-line">
          {c.synthetic ? (
            <strong>Not available: synthetic or local data.</strong>
          ) : c.notChecked ? (
            <strong>Agency record not checked.</strong>
          ) : (
            <>
              <strong>No record shown.</strong> {c.reason ?? ''}
            </>
          )}
        </p>
      </Row>
    )
  const cf = c.source !== 'wfigs'
  // years on the update and containment times when either differs from the fire's year, the replay's or today's, so
  // "contained Dec 16" never sits beside "Sep 6, 2026" as that year (review UX-m1)
  const yearMode = recordYearMode([c.updatedMs, live ? null : c.containedMs], tf.tz, [fireYear, localYear(nowMs, tf.tz), localYear(wallMs, tf.tz)])
  const status = c.final ? 'final record' : c.isActive === false ? 'not active' : c.isActive ? 'active' : null
  const note = cf ? calfireHistoryNote(c, mode, tf) : 'NIFC WFIGS publishes the current record only; Fire-3d does not record changes to it yet.'
  const lagged = laggedEditNote(c)
  const lastParts = cf && last ? changeTitleParts(last) : []
  const extra =
    c.agencies || note ? (
      <>
        {c.agencies && <p className="on-meta">{cf ? 'Agencies' : 'Protecting agency'}: {c.agencies}</p>}
        {note && <p className="on-meta">{note}</p>}
      </>
    ) : undefined
  return (
    <Row icon={icon} label={label} source={source} tone="info" aside={<SourceLink href={c.url}>{cf ? 'Incident page' : 'Record'}</SourceLink>} more={extra}>
      <p className="on-line">
        <strong className="on-official">
          {join([
            c.acres != null ? `${Math.round(c.acres).toLocaleString('en-US')} acres` : 'area not stated',
            c.percentContained != null ? `${Math.round(c.percentContained)} % contained` : 'containment not stated',
            status,
          ])}
        </strong>
      </p>
      {c.complexName && <p className="on-meta">{partOfComplex(c.complexName)}</p>}
      {c.members && c.members.length > 0 && (
        <p className="on-meta">
          Includes (NIFC WFIGS names):{' '}
          {c.members.map((m, k) => (
            <span key={m.name}>
              {k > 0 ? ', ' : ''}
              {m.url ? <SourceLink href={m.url}>{m.name}</SourceLink> : m.name}
            </span>
          ))}
        </p>
      )}
      {c.blocks && c.blocks.length > 1 && (
        <>
          <p className="on-meta">The agencies&apos; records differ on whether the fire is active; each is shown as published:</p>
          {c.blocks.map((b) => (
            <p key={`${b.source}|${b.name ?? ''}`} className="on-meta">
              {recordBlockText(b, tf)} {b.url && <SourceLink href={b.url}>{recordLinkLabel(b.source)}</SourceLink>}
            </p>
          ))}
        </>
      )}
      {live && lastParts.length > 0 && <p className="on-meta">Last change: {lastParts.join(' · ')}</p>}
      {c.reason && <p className="on-meta">{c.reason}</p>}
      {lagged && <p className="on-meta">{lagged}</p>}
      <p className="on-meta">
        {join([
          c.updatedMs != null ? `Updated by ${issuer} ${fmtAt(c.updatedMs, tf, { zone: true, year: yearMode })}` : `${issuer} gives no update time`,
          !live && c.containedMs != null ? `contained ${fmtAt(c.containedMs, tf, { zone: true, year: yearMode })}` : null,
          checked(c.checkedMs, wallMs),
        ])}
      </p>
    </Row>
  )
}

function FireWeatherRow({ f, nowMs, wallMs, metric, statewide = false }: { f: FireWeatherOfficial; nowMs: number; wallMs: number; metric: boolean; statewide?: boolean }) {
  const highlightId = useOfficialRuntime((s) => s.highlight?.id ?? null)
  const tf = useTimeFormat()
  // the overview's scope follows the answer's states_checked (CONTRACT §14.6): "the lower 48 states" only with all 49
  const scope = f.scope ?? 'the states checked'
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
          <strong>{f.state === 'past-date' ? 'Not available for this time.' : f.reasonCode === 'demo' || f.reasonCode === 'not_checked' ? 'Not checked.' : 'Unavailable right now.'}</strong> {reasonSentence(f.reason)}That does not mean there were no alerts.
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
            No Red Flag Warning or Fire Weather Watch {f.archived ? 'in effect at this time' : 'in effect'} {statewide ? `in ${scope}` : 'near this fire'}.
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
      {statewide && inEffect.length > 3 && <p className="on-meta">{statewideCountText(inEffect, f.alertStates?.length ?? 0, scope)}</p>}
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
                a.sentMs != null ? `issued ${fmtWhen(a.sentMs, nowMs, alertTimeFmt({ time_zone: a.timeZone ?? null }, tf))}` : null,
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

/** "None here" in the words of the channels that answered (a past time older than NWS keeps reads FEMA's archive only). */
const NONE_HERE: Record<ReturnType<typeof answeredChannelsText>, string> = {
  'relayed by NWS': 'None relayed by NWS here.',
  'FEMA archive': "None in FEMA's archive here.",
  'NWS, FEMA archive': "None relayed by NWS or in FEMA's archive here.",
}

/** Local officials' messages relayed by NWS, or archived by FEMA for a past time (CONTRACT §14.7): each with its
 *  issuer, own time, verbatim text, link and where its area lies ("area covers the fire's reported location", "area
 *  1.7 mi from the fire's reported location · may be about another fire"; review round 1, R1), the most relevant
 *  first (localAlertOrder); the archive with its notice and credit; pending and not-checked states said as such; the
 *  standing caveat behind "More". */
export function LocalAlertsRow({ l, wallMs, refMs }: { l: LocalAlertsOfficial; wallMs: number; /** The time the panel is for (the replay time, or now). */ refMs?: number }) {
  const tf = useTimeFormat()
  const metric = useWorkspace((s) => s.units === 'metric')
  const label = "Local officials' alerts"
  // the channels that answered: a past time older than NWS keeps reads FEMA's archive only (review UX-m3)
  const source = answeredChannelsText(l)
  const icon = <Megaphone size={13} />
  const pending = l.archivePending ? <p className="on-meta">FEMA&apos;s archive is still being checked for this time; ask again in a minute.</p> : null
  const notice = l.archive ? (
    <p className="on-meta">
      {ARCHIVE_CAVEAT} {ARCHIVE_CREDIT}: {OPENFEMA_NOTICE}.{' '}
      <SourceLink href={OPENFEMA_TERMS_URL}>OpenFEMA terms</SourceLink>
    </p>
  ) : null
  const standing = (
    <>
      <p className="on-meta">{LOCAL_STANDING_CAVEAT}</p>
      {l.state === 'listed' && l.alerts.some((a) => !a.where.covers) && <p className="on-meta">{LOCAL_PLACE_NOTE}</p>}
      {notice}
      {l.channels
        .filter((c) => c.status === 'not_checked' && c.reason)
        .map((c) => (
          <p key={c.id} className="on-meta">
            {c.id === 'nws_api' ? 'National Weather Service' : 'FEMA archive'}: {c.reason}
          </p>
        ))}
    </>
  )
  if (l.state === 'loading')
    return (
      <Row icon={icon} label={label} source={source} tone="muted">
        <p className="on-line">Checking local officials&apos; alerts…</p>
      </Row>
    )
  if (l.state === 'not-checked' || l.state === 'unavailable')
    return (
      <Row icon={icon} label={label} source={null} tone="muted" more={standing}>
        <p className="on-line">
          <strong>Not checked.</strong> {reasonSentence(l.reason)}
          {l.state === 'unavailable' ? 'That does not mean there were none. ' : ''}Follow local officials.
        </p>
        {pending}
      </Row>
    )
  if (l.state === 'none')
    return (
      <Row icon={icon} label={label} source={source} tone="quiet" more={standing}>
        <p className="on-line">
          <strong>{NONE_HERE[answeredChannelsText(l)]}</strong> Not an all-clear: most local alerts are not relayed.
        </p>
        {pending}
        <p className="on-meta">{checked(l.checkedMs, wallMs)}</p>
      </Row>
    )
  const shown = l.alerts.slice(0, 3)
  return (
    <Row icon={icon} label={label} source={source} tone="alert" more={standing}>
      {l.alerts.length > shown.length && (
        <p className="on-meta">{`${l.alerts.length} messages for this fire's area; in effect first, then the nearest to its reported location:`}</p>
      )}
      {shown.map((a) => (
        <div key={a.id} className="on-alert">
          <p className="on-line">
            {a.lead}: <strong className="on-official">&ldquo;{a.text}&rdquo;</strong>
          </p>
          <p className="on-meta">
            {join([a.event, sentText(a, tf), a.archived ? 'FEMA archive' : 'relayed by the National Weather Service', localPhaseText(a, refMs)])}
            {' · '}
            <SourceLink href={a.link.url}>{a.link.label}</SourceLink>
          </p>
          <p className="on-meta">{localAlertPlace(a, { metric })}</p>
          {a.archived && <p className="on-meta">{`${ARCHIVE_CREDIT}: ${OPENFEMA_NOTICE}.`}</p>}
        </div>
      ))}
      {l.alerts.length > shown.length && <p className="on-meta">+{l.alerts.length - shown.length} more: see the Official filter.</p>}
      {pending}
    </Row>
  )
}

/** The block: the open fire's official status, or on the overview the current NWS fire weather alerts of every state
 *  the answer covers (`states_checked`) with a pointer to zoom in on a fire (CONTRACT §13, §14.6). */
export function OfficialNow() {
  const { evacuation, fireWeather, calfire, local } = useOfficialNow()
  // "Official now · lower 48 states" only when the answer covers all 49 codes; today's California-only backend:
  // "California" (the header follows states_checked, never a hard-coded scope)
  const headScope = officialNowScope(fireWeather)
  const tf = useTimeFormat()
  const whose = useZoneSource()
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
          {headScope && <span className="on-head-sub">{headScope}</span>}
        </header>
        <ul className="on-rows">
          <FireWeatherRow f={fireWeather} nowMs={wallMs} wallMs={wallMs} metric={metric} statewide />
        </ul>
        <p className="on-meta">Official evacuation information and each fire&apos;s agency record are shown for a fire: zoom in on a fire or pick one, or check an address.</p>
        <p className="on-meta">Times: each alert in its own area&apos;s local time.</p>
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
        <RecordRow c={calfire} nowMs={nowMs} wallMs={wallMs} live={live} />
        <FireWeatherRow f={fireWeather} nowMs={nowMs} wallMs={wallMs} metric={metric} />
        {local && <LocalAlertsRow l={local} wallMs={wallMs} refMs={nowMs} />}
      </ul>
      {/* the replay time's abbreviation first, today's too when it differs (integration review UX-m4) */}
      <p className="on-meta">{zoneLine(tf, nowMs, whose, wallMs)}</p>
      <p className="on-foot">{NOT_AN_ORDER}</p>
    </section>
  )
}
