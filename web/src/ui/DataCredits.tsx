// Data credits shown next to the data (lib/dataCredits.ts; README "Data sources, licenses and credits"): the linked
// Open-Meteo credit wherever weather or forecast values appear, and a "Data sources" note (the bundle's sources with
// links, plus NASA's FIRMS acknowledgement) in the Analysis drawer and the Forensic Evidence tab. Text and https links
// only.
import { useShallow } from 'zustand/react/shallow'
import { bundleCredits, FIRMS_ACKNOWLEDGEMENT, OPEN_METEO_CREDIT, safeHref, type DataCredit } from '../lib/dataCredits'
import { useStore } from '../state/store'
import '../styles/credits.css'
import { localYear, timeFmt } from '../lib/time'
import { agencyNameShown } from '../lib/recordText'

function CreditLink({ c }: { c: DataCredit }) {
  const href = safeHref(c.href)
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {c.text}
    </a>
  ) : (
    <>{c.text}</>
  )
}

/** "Weather data by Open-Meteo.com", linked (CC BY 4.0 attribution). */
export function OpenMeteoCredit({ className }: { className?: string }) {
  return (
    <span className={`data-credit-om ${className ?? ''}`}>
      <CreditLink c={OPEN_METEO_CREDIT} />
    </span>
  )
}

/** The current incident's data sources with their credits, and the FIRMS acknowledgement when FIRMS data are used. */
export function DataSourcesNote({ className, inline }: { className?: string; inline?: boolean }) {
  const { sources, year, fcWeather, engine, version, agencyNames } = useStore(
    useShallow((s) => ({
      sources: s.manifest?.status === 'ready' ? s.manifest.data_sources : null,
      // the fire's year in its own zone (a fire found at 8 PM EST on Dec 31 belongs to that year, not UTC's next one)
      year: s.summary ? localYear(s.summary.started_ms, timeFmt(s.summary.time_zone, '24h').tz) : null,
      fcWeather: s.forecast?.weather.source ?? null,
      engine: s.forecast?.model?.engine ?? null,
      version: s.forecast?.model?.version ?? null,
      // a plain NWCG agency name is shown after the record's agency code (fire card, panels)
      agencyNames: s.summary ? agencyNameShown(s.summary) : false,
    })),
  )
  if (!sources) return null
  const credits = bundleCredits(sources, { year, forecastWeatherSource: fcWeather, forecastModel: engine ? { engine, version } : null, place: { agencyNames } })
  if (credits.length === 0) return <p className={`data-credits ${className ?? ''}`}>Data sources: synthetic development fixture (no outside data).</p>
  const list = credits.map((c, i) => (
    <span key={c.id}>
      {i > 0 && ' · '}
      <CreditLink c={c} />
    </span>
  ))
  const firms = credits.some((c) => c.id === 'firms')
  // inline: one paragraph (the Analysis drawer has a fixed height)
  if (inline)
    return (
      <p className={`data-credits ${className ?? ''}`}>
        <span className="data-credits-label">Data sources: </span>
        {list}.{firms && <span className="data-credits-ack"> {FIRMS_ACKNOWLEDGEMENT}</span>}
      </p>
    )
  return (
    <div className={`data-credits ${className ?? ''}`}>
      <p>
        <span className="data-credits-label">Data sources: </span>
        {list}
      </p>
      {firms && <p className="data-credits-ack">{FIRMS_ACKNOWLEDGEMENT}</p>}
    </div>
  )
}
