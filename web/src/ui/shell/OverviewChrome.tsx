// The map workspace's chrome with no fire open: the national overview of the lower 48 (brief 4 H3, Main.dc.html;
// PLAN-4 §3.3, decisions c, d and h; CONTRACT §15.5 "H3 as built"). One chrome for both presets:
//   Public, minimal (default)  the floating bar (logo, "United States · all fires", the view pill, the local date and
//                              the listed active fires), the centred search pill with the locate-me button, the compact
//                              map controls (zoom, ⟲ compass ⟳), the one-line disclaimer, the credits and the
//                              "Show details" pill. A selected point's location card shows on the left.
//   Public, details            + the map controls bar (top left, Layers at its end), the "Fires in the lower 48" panel
//                              (right), the overview readout (bottom left), the scale bar and the legend (bottom right).
//   Command                    the details always (no pill; H still hides the panels), and the fire card for a picked
//                              fire as before (decision c).
// Phones (<= 760 px): bar (logo, title, menu), a full-width search pill with the 44 px locate button, the compact
// controls, the fire list as a bottom sheet (the pill opens it in Public; the peek bar in Command), the disclaimer and
// "© Credits". The map, the credits component, status overlays, banners, toasts and tooltips stay in App.tsx's
// MapWorkspace; every floating region keeps [data-chrome] and --chrome-side (CONTRACT §3.1). Layout:
// styles/view-public.css (.mw[data-view='overview']). Leader-line labels for the largest named fires: map/LeaderLabels.
import { useEffect, type ReactNode } from 'react'
import { LocateButton } from '../../location/LocateButton'
import { CoordinateStrip } from '../../location/CoordinateStrip'
import { LocationCard } from '../../location/LocationCard'
import { SearchBox } from '../../location/SearchBox'
import { LeaderLabels } from '../../map/LeaderLabels'
import { ScaleBar } from '../../map/MapAttribution'
import { MapControls } from '../../map/MapControls'
import { MapLegend } from '../../map/MapLegend'
import { LIST_ABSENCE_SHORT } from '../../state/overview'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import { OVERVIEW_LEGEND_IN_PANEL_QUERY } from '../public/overviewLayout'
import { OverviewStatus } from '../public/OverviewStatus'
import { ShowDetailsPill } from '../public/ShowDetailsPill'
import { CoordsSlot } from './CoordsSlot'
import { FireCard } from './FireCard'
import { FixedCopy } from './FixedCopy'
import { NARROW_QUERY, useMediaQuery } from './hooks'
import { LayersPanel } from './LayersPanel'
import { OverviewPanel } from './OverviewPanel'
import { TopBar, TopBarBrand, ViewPill } from './TopBar'
import { CompactMenu, LOWER48_TIP, ShowPanelsPill } from './topBarItems'
import '../../styles/view-public.css'

/** Public on a wide screen: the menu's "Fires (lower 48)" (< 1024 px) opening the list also shows the details it is
 *  part of. */
function useListOpensDetails(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    return useWorkspace.subscribe((s, p) => {
      if (s.panels.updates && !p.panels.updates && !s.overviewDetails && s.preset === 'public') s.setOverviewDetails(true)
    })
  }, [enabled])
}

export function OverviewChrome({ credits }: { credits: ReactNode }) {
  const preset = useWorkspace((s) => s.preset)
  const detailsAsked = useWorkspace((s) => s.overviewDetails)
  const collapsed = useStore((s) => s.panelsCollapsed)
  const narrow = useMediaQuery(NARROW_QUERY)
  // below 1200 px the legend lives in the Layers panel (ui/public/overviewLayout.ts)
  const legendInPanel = useMediaQuery(OVERVIEW_LEGEND_IN_PANEL_QUERY)
  const command = preset === 'command'
  // what shows: Command always has its details; Public only after "Show details". Phones: the list is a sheet.
  const details = !narrow && (command || detailsAsked)
  // phones: Command keeps today's controls row and coordinate line; Public the compact cluster only (decision h)
  const phoneCommand = narrow && command
  // the fire list's slot: the details (wide screens), Command's peek bar or the open sheet (phones). Otherwise the
  // "Show details" pill stands in for it (the skip link "Skip to the fire list" lands on the pill)
  const listOpen = useWorkspace((s) => s.panels.updates)
  const listShown = details || (narrow && (command || listOpen))
  useListOpensDetails(!narrow && !command)
  return (
    <>
      <TopBar
        className="mw-header"
        data-chrome="header"
        left={
          <>
            <TopBarBrand />
            <span className="tb-sep" aria-hidden="true" />
            <h1 className="mw-hdr-title" data-tip={LOWER48_TIP}>
              United States <span className="mw-hdr-title-sub">· all fires</span>
            </h1>
          </>
        }
        centre={<ViewPill className="mw-wide-only" />}
        right={
          <>
            {!narrow && <OverviewStatus />}
            <ShowPanelsPill />
            <CompactMenu />
          </>
        }
      />
      {/* the largest named fires' leader-line labels: over the map, under the chrome */}
      <LeaderLabels />
      <div className="mw-layers-slot" data-chrome="layers">
        <LayersPanel />
      </div>
      <div className="ovw-search" id="mw-search" data-chrome="search">
        <SearchBox variant="pill" />
        <LocateButton />
      </div>
      <div className={`mw-top ovw-top${details ? ' has-details' : ''}`}>
        <div className="ovw-left">
          {details && (
            <div className="mw-controls ovw-controls" data-chrome="controls">
              <MapControls variant="bar" layers />
            </div>
          )}
          <div className="mw-firecard" data-chrome="firecard">
            <FireCard />
          </div>
          <div className="mw-card" data-chrome="card">
            <LocationCard />
          </div>
        </div>
        {!details &&
          (phoneCommand ? (
            <div className="mw-controls" data-chrome="controls">
              <MapControls />
            </div>
          ) : (
            <div className="mw-controls ovw-cluster" data-chrome="controls">
              <MapControls variant="compact" />
            </div>
          ))}
        {listShown && (
          <aside className="mw-updates ovw-list" id="mw-updates" data-chrome="updates" aria-label="Fires in the lower 48">
            <OverviewPanel closeHidesDetails={!command && !narrow} sheetPeek={command} />
          </aside>
        )}
      </div>
      <div className={`mw-bottom ovw-bottom${details ? ' has-details' : ''}`}>
        {(details || phoneCommand) && (
          <div className="ovw-readout">
            <CoordsSlot>
              <CoordinateStrip />
            </CoordsSlot>
            {details && !collapsed && (
              <div className="ovw-scale" data-chrome="scale">
                <ScaleBar />
              </div>
            )}
          </div>
        )}
        {details && !legendInPanel && (
          <div className="mw-legend-slot ovw-legend" data-chrome="legend">
            <MapLegend />
          </div>
        )}
        <div className="mw-note ovw-note" data-chrome="note">
          <FixedCopy variant="line" extra={narrow ? `${LIST_ABSENCE_SHORT}. Follow local officials.` : undefined} />
        </div>
        {!command && (
          <div className="ovw-pill-slot" id={listShown ? undefined : 'mw-updates'} data-chrome="details">
            <ShowDetailsPill sheet={narrow} />
          </div>
        )}
        {credits}
      </div>
    </>
  )
}
