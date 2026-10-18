// Evidence tab (SPEC 9.4): data sources with fetch times, detection counts by instrument / satellite, the perimeter
// list (click jumps the timeline), bundle facts and warnings.
import { AlertTriangle, Database, ExternalLink, Hexagon, Satellite } from 'lucide-react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DetectionsFile, IncidentManifest, Instrument, PerimetersFile } from '../api/types'
import { fmtAcres, fmtNumber, satelliteName } from '../lib/format'
import { fmtDateTime, fmtDateTimeYearTz, fmtRelative, tzLabel } from '../lib/time'
import { lastIndexAtOrBefore } from '../state/selectors'
import { useStore } from '../state/store'
import { EmptyNote, Section } from './controls'
import { useNow } from './hooks'
import { DataSourcesNote } from './DataCredits'

const INSTRUMENTS: Instrument[] = ['VIIRS', 'MODIS', 'LANDSAT', 'GOES']
const INSTRUMENT_NOTE: Record<Instrument, string> = {
  VIIRS: '375 m · S-NPP, NOAA-20, NOAA-21',
  MODIS: '1 km · Aqua, Terra',
  LANDSAT: '30 m · ~8-day revisit',
  GOES: '~2 km · timing / FRP only',
}

export function EvidenceTab() {
  const { manifest, detections, perimeters, weather } = useStore(
    useShallow((s) => ({ manifest: s.manifest, detections: s.detections, perimeters: s.perimeters, weather: s.weather })),
  )
  if (!manifest || manifest.status !== 'ready')
    return (
      <div className="tab-pad">
        <EmptyNote icon={<Database size={16} />} title="No evidence yet">
          Data sources, detections and perimeters appear once the incident bundle is built.
        </EmptyNote>
        {manifest?.warnings.length ? <Warnings list={manifest.warnings} /> : null}
      </div>
    )
  return (
    <div className="tab-pad evidence">
      <Detections file={detections} />
      <Perimeters file={perimeters} />
      <Sources manifest={manifest} weatherSource={weather?.source ?? null} />
      <BundleFacts manifest={manifest} />
      {manifest.warnings.length > 0 && <Warnings list={manifest.warnings} />}
    </div>
  )
}

interface InstrumentRow {
  instrument: Instrument
  total: number
  upToNow: number
  first: number | null
  last: number | null
  sats: { sat: string; count: number }[]
}

function Detections({ file }: { file: DetectionsFile | null }) {
  // count up to the current time in coarse (hourly) steps so playback doesn't re-render every frame
  const hour = useStore((s) => Math.floor(s.timeMs / 3_600_000))
  const rows = useMemo<InstrumentRow[]>(() => {
    const list = file?.detections ?? []
    const by = new Map<Instrument, InstrumentRow & { satMap: Map<string, number> }>()
    for (const d of list) {
      let r = by.get(d.instrument)
      if (!r) {
        r = { instrument: d.instrument, total: 0, upToNow: 0, first: null, last: null, sats: [], satMap: new Map() }
        by.set(d.instrument, r)
      }
      r.total++
      r.first = r.first == null ? d.t_ms : Math.min(r.first, d.t_ms)
      r.last = r.last == null ? d.t_ms : Math.max(r.last, d.t_ms)
      r.satMap.set(d.satellite, (r.satMap.get(d.satellite) ?? 0) + 1)
    }
    return INSTRUMENTS.filter((i) => by.has(i)).map((i) => {
      const r = by.get(i)!
      return { ...r, sats: [...r.satMap.entries()].map(([sat, count]) => ({ sat, count })).sort((a, b) => b.count - a.count) }
    })
  }, [file])
  const upTo = useMemo(() => {
    const cutoff = (hour + 1) * 3_600_000
    const m = new Map<Instrument, number>()
    for (const d of file?.detections ?? []) if (d.t_ms <= cutoff) m.set(d.instrument, (m.get(d.instrument) ?? 0) + 1)
    return m
  }, [file, hour])
  const total = rows.reduce((a, r) => a + r.total, 0)
  const max = Math.max(1, ...rows.map((r) => r.total))
  return (
    <Section title="Satellite detections" aside={<span className="mono muted">{fmtNumber(total)} total</span>}>
      {rows.length === 0 ? (
        <EmptyNote icon={<Satellite size={15} />} title="No detections">
          FIRMS returned no hot pixels for this fire's area and dates.
        </EmptyNote>
      ) : (
        <div className="det-table">
          <div className="det-head">
            <span>Instrument</span>
            <span className="r" data-tip="Detections up to the current timeline time">≤ t</span>
            <span className="r">Total</span>
          </div>
          {rows.map((r) => (
            <div key={r.instrument} className="det-group">
              <div className="det-row" data-tip={`${INSTRUMENT_NOTE[r.instrument]}${r.first ? ` · ${fmtDateTime(r.first)} → ${fmtDateTime(r.last!)}` : ''}`}>
                <span className="det-name">
                  <i className={`det-dot det-${r.instrument.toLowerCase()}`} />
                  <span>{r.instrument === 'LANDSAT' ? 'Landsat' : r.instrument}</span>
                  <span className="muted det-note">{INSTRUMENT_NOTE[r.instrument].split(' · ')[0]}</span>
                </span>
                <span className="mono r secondary">{fmtNumber(upTo.get(r.instrument) ?? 0)}</span>
                <span className="mono r">{fmtNumber(r.total)}</span>
                <span className="det-bar">
                  <i style={{ width: `${(r.total / max) * 100}%` }} />
                  <i className="det-bar-now" style={{ width: `${((upTo.get(r.instrument) ?? 0) / max) * 100}%` }} />
                </span>
              </div>
              {r.sats.length > 1 &&
                r.sats.map((s) => (
                  <div key={s.sat} className="det-sat">
                    <span className="secondary">{satelliteName(s.sat)}</span>
                    <span className="mono muted r">{fmtNumber(s.count)}</span>
                  </div>
                ))}
            </div>
          ))}
          <p className="muted small">GOES contributes timing and FRP only, never the burned-area mask.</p>
        </div>
      )}
    </Section>
  )
}

function Perimeters({ file }: { file: PerimetersFile | null }) {
  const list = useMemo(() => file?.perimeters ?? [], [file])
  const t = useMemo(() => list.map((p) => p.t_ms), [list])
  const current = useStore((s) => lastIndexAtOrBefore(t, s.timeMs))
  const st = useStore.getState
  return (
    <Section title="Perimeters" aside={<span className="mono muted">{list.length}</span>}>
      {list.length === 0 ? (
        <EmptyNote icon={<Hexagon size={15} />} title="No NIFC perimeters">
          The arrival time is reconstructed from satellite detections only.
        </EmptyNote>
      ) : (
        <div className="perims">
          {list.map((p, i) => (
            <button
              key={`${p.t_ms}-${i}`}
              type="button"
              className={`perim ${i === current ? 'is-current' : ''} ${i < current ? 'is-past' : ''}`}
              onClick={() => {
                st().setPlaying(false)
                st().setTimeMs(p.t_ms)
              }}
              data-tip={`${p.source} · jump the timeline here`}
            >
              <span className="perim-dot" />
              <span className="mono perim-t">
                {fmtDateTime(p.t_ms)} <span className="muted">{tzLabel(p.t_ms)}</span>
              </span>
              <span className="mono perim-a">{fmtAcres(p.acres)}</span>
              <span className="perim-src muted ellipsis">{/final/i.test(p.source) ? 'final' : 'daily'}</span>
            </button>
          ))}
        </div>
      )}
    </Section>
  )
}

function Sources({ manifest, weatherSource }: { manifest: IncidentManifest; weatherSource: string | null }) {
  const now = useNow(60_000)
  return (
    <Section title="Data sources" aside={<span className="mono muted">{manifest.data_sources.length}</span>}>
      <ul className="sources">
        {manifest.data_sources.map((d, i) => (
          <li key={i} className="source">
            <div className="source-top">
              <span className="source-name">{d.name}</span>
              <span className="mono muted" data-tip={`Fetched ${fmtDateTimeYearTz(d.fetched_ms)}`}>
                {fmtRelative(d.fetched_ms, now)}
              </span>
            </div>
            <div className="source-detail secondary">{d.detail}</div>
          </li>
        ))}
        {weatherSource && !manifest.data_sources.some((d) => d.detail.includes(weatherSource)) && (
          <li className="source">
            <div className="source-top">
              <span className="source-name">Weather file</span>
            </div>
            <div className="source-detail secondary mono">{weatherSource}</div>
          </li>
        )}
      </ul>
      {manifest.summary.url && (
        <a className="ext-link" href={manifest.summary.url} target="_blank" rel="noreferrer">
          CAL FIRE incident page <ExternalLink size={11} />
        </a>
      )}
      <DataSourcesNote className="evidence-credits" />
    </Section>
  )
}

function BundleFacts({ manifest }: { manifest: IncidentManifest }) {
  const g = manifest.grid
  const now = useNow(60_000)
  return (
    <Section title="Bundle">
      <dl className="kv kv-tight">
        <dt>ID</dt>
        <dd className="mono ellipsis">{manifest.id}</dd>
        <dt>Built</dt>
        <dd className="mono" data-tip={fmtDateTimeYearTz(manifest.built_ms)}>
          {fmtRelative(manifest.built_ms, now)}
        </dd>
        <dt>AOI</dt>
        <dd className="mono">
          {fmtNumber(g.extent_m / 1000, 1)} km · {g.crs}
        </dd>
        <dt>Grids</dt>
        <dd className="mono">
          fire {g.fire.width}² @ {fmtNumber(g.fire.res_m, 1)} m · render {g.render.width}²
        </dd>
        <dt>Elevation</dt>
        <dd className="mono">
          {fmtNumber(g.elev_min_m)}–{fmtNumber(g.elev_max_m)} m
        </dd>
        <dt>Fuels</dt>
        <dd className="mono">LANDFIRE {manifest.fuels_edition}</dd>
        <dt>Mapped area</dt>
        <dd className="mono">{fmtAcres(manifest.stats.final_acres_observed)}</dd>
        <dt>Ignition</dt>
        <dd className="ellipsis" data-tip={manifest.ignition?.source}>
          {manifest.ignition ? (
            <>
              <span className="mono">{fmtDateTime(manifest.ignition.t_ms)}</span> <span className="muted">· {manifest.ignition.source}</span>
            </>
          ) : (
            '—'
          )}
        </dd>
      </dl>
    </Section>
  )
}

function Warnings({ list }: { list: string[] }) {
  return (
    <Section title="Warnings" aside={<span className="mono warn">{list.length}</span>}>
      <ul className="warn-list">
        {list.map((w, i) => (
          <li key={i}>
            <AlertTriangle size={11} />
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
