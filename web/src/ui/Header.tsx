// Forensic top bar (SPEC 9.4; brief 4 H5, ForensicView.dc.html, PLAN-4 §3.5): H2's floating TopBar (no full-width
// panel, top 20 / sides 20). Left: back (close the fire, back to the map of all fires), the logo, the incident picker
// as a "● LIVE Willow ▾" pill, the place and the dates in grey. Centre: the Public · Command · Forensic pill (the
// floating switch under the compass is gone). Right: the Incident | Aircraft (n) tabs (live only), then round icon
// pills: View options, Analysis, Share, Settings and Hide panels (H). The menus open from the pills exactly as before.
// Below 1024 px the view pill drops to a row under the bar (phones: with "Hide panels" at that row's right end).
// With panels collapsed ("H") only the minimal bar remains (MiniBar: logo, name, LIVE / year, time, play, the view
// pill and "Panels H").
import { Map as MapIcon, Maximize2, Minimize2, Pause, Play, Plane } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { fmtLatLon } from '../lib/format'
import { fmtDayDate, fmtAt } from '../lib/time'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { IconButton } from './controls'
import { IncidentPicker } from './IncidentPicker'
import { Logo } from './Logo'
import { AnalysisMenu, SettingsMenu, ShareButton, ViewMenu } from './Menus'
import { goToOverview } from './shell/fireActions'
import { switchWorkspace } from './shell/handoff'
import { BackButton, IconPill, TopBar, TopBarBrand, ViewPill } from './shell/TopBar'
import { placeLine } from './shell/topBarText'

export { Logo } from './Logo'

/** Forensic's "back": close the fire and return to the map of all fires (the map takes the camera's place first, so
 *  Back in the browser and the map's own framing work as from the map). */
function backToAllFires(): void {
  switchWorkspace('map')
  goToOverview()
}

/** "<County> County · Jun 28, 2026 – present" in grey (the screen; the full location and the coordinates in the
 *  tooltip). Without a county: the place as the map's bar shows it. */
function IncidentMeta() {
  const tf = useTimeFormat()
  const { summary, manifest } = useStore(useShallow((s) => ({ summary: s.summary, manifest: s.manifest })))
  if (!summary) return null
  const county = summary.county?.trim()
  const place = county ? `${county} County` : placeLine(summary)
  const tr = manifest?.time_range
  const start = tr?.start_ms ?? summary.started_ms
  const end = summary.mode === 'live' ? null : (summary.contained_ms ?? tr?.end_ms ?? null)
  // "Jun 28, 2026 – present"; a past fire within one year: "Sep 1 – Nov 14, 2025"
  const dates = end
    ? `${fmtDayDate(start, tf.tz, { year: 'auto', refMs: end })} – ${fmtDayDate(end, tf.tz, { year: 'always' })}`
    : `${fmtDayDate(start, tf.tz, { year: 'always' })} – present`
  const where = [summary.location, summary.county ? `${summary.county} County` : null, summary.state ?? null].filter(Boolean).join(', ')
  // TopBarPlace's look (.tb-place, .tb-date): one line while it fits, else the dates wrap under the place, so they stay
  // readable beside a long name (styles/header.css; the inner span carries the dates' ellipsis, the outer the " · ")
  return (
    <span className="tb-place fx-place" data-tip={`${where || place || summary.name} · ${fmtLatLon(summary.lat, summary.lon, 3)}`}>
      {place && <span className="fx-place-name">{place}</span>}
      <span className={`tb-date${place ? ' fx-place-date' : ''}`}>
        <span>{dates}</span>
      </span>
    </span>
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
      <button type="button" role="tab" aria-selected={active === 'incident'} className="hdr-tab" data-tip="Incident: layers, analysis, evidence and notes" onClick={() => setTab('incident')}>
        <MapIcon size={13} aria-hidden="true" />
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
        <Plane size={13} aria-hidden="true" />
        Aircraft
        {live && <span className={`count-badge mono ${count > 0 ? 'is-hot' : ''}`}>{count}</span>}
      </button>
    </div>
  )
}

/** A 2 px busy line along the top edge of the window (as the map workspace's). */
function LoadingLine() {
  const busy = useStore((s) => s.incidentLoading || s.catalog.loading)
  return <span className={`hdr-loading ${busy ? 'is-on' : ''}`} aria-hidden />
}

export function Header() {
  const collapsed = useStore((s) => s.panelsCollapsed)
  if (collapsed) return <MiniBar />
  return (
    <>
      <TopBar
        inset="forensic"
        className="fx-bar"
        left={
          <>
            <BackButton onClick={backToAllFires} label="Back to all fires" tip="Close this fire and go back to the map of all fires" />
            <TopBarBrand size={22} />
            <span className="tb-sep" aria-hidden="true" />
            <IncidentPicker />
            <IncidentMeta />
          </>
        }
        centre={<ViewPill className="fx-bar-view" />}
        right={
          <>
            <HeaderTabs />
            <nav className="hdr-actions" aria-label="Tools">
              <ViewMenu />
              <AnalysisMenu />
              <ShareButton />
              <SettingsMenu />
              <IconPill icon={<Minimize2 size={15} />} label="Hide panels (H)" className="fx-tool fx-hide" onClick={() => useStore.getState().setPanelsCollapsed(true)} />
            </nav>
          </>
        }
      />
      <LoadingLine />
    </>
  )
}

/** Minimal top bar while the panels are hidden (cinematic view): a glass pill with the fire, its time, play, the view
 *  switch and "Panels H". */
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
    <div className="minibar">
      <Logo size={20} />
      <span className="brand-name">Fire-3d</span>
      {name && <span className="minibar-name ellipsis">{name}</span>}
      {name &&
        (mode === 'live' ? (
          <span className="minibar-live">
            <i className="live-dot" aria-hidden="true" />
            LIVE
          </span>
        ) : (
          <span className="minibar-year mono">{year}</span>
        ))}
      {hasManifest && <span className="mono minibar-time">{fmtAt(timeMs, tf, { zone: true })}</span>}
      {hasManifest && (
        <IconButton
          icon={playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
          label={playing ? 'Pause (Space)' : 'Play (Space)'}
          className="minibar-play"
          onClick={() => useStore.getState().togglePlaying()}
        />
      )}
      <ViewPill size="sm" className="minibar-view" />
      <button type="button" className="btn btn-sm btn-ghost minibar-panels" onClick={() => useStore.getState().setPanelsCollapsed(false)}>
        <Maximize2 size={13} /> Panels <kbd>H</kbd>
      </button>
    </div>
  )
}
