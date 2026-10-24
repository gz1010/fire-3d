// Floating header (SPEC 9.4): logo + "Fire-3d" + tagline, incident picker, location, date range (mono),
// "Incident" | "Aircraft (n)" tabs (live only), View / Analysis menus, Share, settings, hide panels.
// With panels collapsed ("H") only a minimal top bar remains.
import { Calendar, Map as MapIcon, MapPin, Maximize2, Minimize2, Pause, Play, Plane } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { fmtLatLon } from '../lib/format'
import { fmtDayDate, fmtAt } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { IconButton } from './controls'
import { IncidentPicker } from './IncidentPicker'
import { Logo } from './Logo'
import { AnalysisMenu, SettingsMenu, ShareButton, ViewMenu } from './Menus'

export { Logo } from './Logo'

function Brand() {
  return (
    <div className="brand">
      <Logo />
      <span className="brand-name">Fire-3d</span>
      <span className="brand-sep" />
      <span className="brand-tag">Wildfire Forensics &amp; Forecast</span>
    </div>
  )
}

function IncidentMeta() {
  const tf = useTimeFormat()
  const { summary, manifest } = useStore(useShallow((s) => ({ summary: s.summary, manifest: s.manifest })))
  if (!summary) return null
  const loc = [summary.location, summary.county ? `${summary.county} County` : null].filter(Boolean).join(', ')
  const tr = manifest?.time_range
  const start = tr?.start_ms ?? summary.started_ms
  const end = summary.mode === 'live' ? null : (summary.contained_ms ?? tr?.end_ms ?? null)
  return (
    <div className="hdr-meta">
      {loc && (
        <span className="hdr-loc ellipsis" data-tip={`${loc} · ${fmtLatLon(summary.lat, summary.lon, 3)}`}>
          <MapPin size={13} />
          <span className="ellipsis">{loc}</span>
        </span>
      )}
      <span className="hdr-dates mono">
        <Calendar size={13} />
        {fmtDayDate(start, tf.tz, { year: 'always' })} – {end ? fmtDayDate(end, tf.tz, { year: 'always' }) : 'present'}
      </span>
    </div>
  )
}

function HeaderTabs() {
  const { live, tab, count, ready, hasIncident } = useStore(
    useShallow((s) => ({
      live: (s.summary?.mode ?? s.mode) === 'live',
      tab: s.headerTab,
      count: s.aircraft.filter((a) => a.is_fire_aircraft).length,
      ready: s.manifest?.status === 'ready',
      hasIncident: s.summary != null,
    })),
  )
  if (!hasIncident) return null
  const setTab = useStore.getState().setHeaderTab
  const active = live ? tab : 'incident'
  return (
    <div className="hdr-tabs" role="tablist" aria-label="Context">
      <button type="button" role="tab" aria-selected={active === 'incident'} className="hdr-tab" onClick={() => setTab('incident')}>
        <MapIcon size={14} />
        Incident
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'aircraft'}
        className="hdr-tab"
        onClick={() => setTab('aircraft')}
        disabled={!live || !ready}
        data-tip={live ? 'Firefighting aircraft from open ADS-B data (adsb.lol, or adsb.fi when adsb.lol is unreachable), refreshed every 10 s' : 'Aircraft are tracked for live incidents only'}
      >
        <Plane size={14} />
        Aircraft
        {live && <span className={`count-badge mono ${count > 0 ? 'is-hot' : ''}`}>{count}</span>}
      </button>
    </div>
  )
}

function LoadingLine() {
  const busy = useStore((s) => s.incidentLoading || s.catalog.loading)
  return <span className={`hdr-loading ${busy ? 'is-on' : ''}`} aria-hidden />
}

export function Header() {
  const collapsed = useStore((s) => s.panelsCollapsed)
  if (collapsed) return <MiniBar />
  return (
    <header className="hdr glass">
      <Brand />
      <span className="hdr-divider" />
      <IncidentPicker />
      <IncidentMeta />
      <HeaderTabs />
      <span className="hdr-spacer" />
      <nav className="hdr-actions" aria-label="Tools">
        <ViewMenu />
        <AnalysisMenu />
        <ShareButton />
        <span className="hdr-divider" />
        <SettingsMenu />
        <IconButton icon={<Minimize2 size={15} />} label="Hide panels (H)" className="hdr-icon" onClick={() => useStore.getState().setPanelsCollapsed(true)} />
      </nav>
      <LoadingLine />
    </header>
  )
}

/** Minimal top bar while the panels are hidden (cinematic view). */
function MiniBar() {
  const tf = useTimeFormat()
  const { name, mode, year, timeMs, playing, hasManifest } = useStore(
    useShallow((s) => ({
      name: s.summary?.name ?? null,
      mode: s.summary?.mode ?? s.mode,
      year: s.summary?.year ?? null,
      timeMs: s.timeMs,
      playing: s.playing,
      hasManifest: s.manifest != null,
    })),
  )
  return (
    <div className="minibar glass">
      <Logo size={20} />
      <span className="brand-name">Fire-3d</span>
      {name && <span className="minibar-name ellipsis">{name}</span>}
      {name &&
        (mode === 'live' ? (
          <span className="chip chip-live live-chip">
            <i className="live-dot" />
            LIVE
          </span>
        ) : (
          <span className="chip chip-gold mono">{year}</span>
        ))}
      {hasManifest && <span className="mono gold minibar-time">{fmtAt(timeMs, tf, { zone: true })}</span>}
      {hasManifest && (
        <IconButton icon={playing ? <Pause size={14} /> : <Play size={14} />} label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => useStore.getState().togglePlaying()} />
      )}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => useStore.getState().setPanelsCollapsed(false)}>
        <Maximize2 size={13} /> Panels <kbd>H</kbd>
      </button>
    </div>
  )
}
