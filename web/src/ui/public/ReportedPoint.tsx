// The fire view's reported location and the leader from the hazard circle to it (brief 4 H4, FireView.dc.html "Leader
// line and fire point"; PLAN-4 §3.4, decision e). An SVG overlay over the map and under the chrome (aria-hidden: the
// facts give the reported coordinates; pointer-events none, so map clicks and hover text reach the map): the point as
// the screen draws it (a 12 px #ff6a2a dot with a #ffd79a ring and a light centre, in a soft halo) at the agency's
// reported coordinates, following the map every frame (map/useMapAnchor.ts), and a 1.5 px orange line from the
// circle's edge to it. The line is hidden when the point is off the map, under the circle or the fire view's panels,
// or when it would cross them (map/leaderLayout.ts segmentHitsRect). In Public the map's own reported-location ring and
// label are off (map/fireProfile.ts), so this is the only marker of the point.
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useSearchUi } from '../../location/searchUi'
import { segmentHitsRect, type Rect } from '../../map/leaderLayout'
import { useMapAnchor } from '../../map/useMapAnchor'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'

/** The panels a leader must not cross: the fire view's title, facts, key, location card, search, drawers, banners and
 *  the bar's items (the bar itself spans the window but lets the map through between them). */
const BLOCKING =
  '.mw [data-chrome]:not([data-chrome="circle"]):not([data-chrome="header"]), .mw [data-chrome="header"] .tb-side > *, .mw [data-chrome="header"] .tb-centre > *, .mw .top-center > *, .pfv-search-pop, .loc-search-below > *, .fxm-legend-pop'

interface CircleGeom {
  x: number
  y: number
  r: number
}

function useCircleGeom(circle: RefObject<HTMLElement | null>, enabled: boolean): CircleGeom | null {
  const [geom, setGeom] = useState<CircleGeom | null>(null)
  useEffect(() => {
    // after the commit (the circle's ref is attached by then; it may mount a frame later)
    let el = circle.current
    let raf = 0
    if (!enabled) return
    const measure = () => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const next = r.width > 1 && r.height > 1 && el.getClientRects().length > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 } : null
      setGeom((g) => (g && next && Math.abs(g.x - next.x) < 0.5 && Math.abs(g.y - next.y) < 0.5 && Math.abs(g.r - next.r) < 0.5 ? g : next))
    }
    const ro = new ResizeObserver(measure)
    const attach = () => {
      el = circle.current
      if (!el) {
        raf = requestAnimationFrame(attach)
        return
      }
      measure()
      ro.observe(el)
    }
    attach()
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [circle, enabled])
  return enabled ? geom : null
}

function blockingRects(): Rect[] {
  const out: Rect[] = []
  document.querySelectorAll<HTMLElement>(BLOCKING).forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  })
  return out
}

const insideRect = (x: number, y: number, r: Rect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom

export function ReportedPoint({ circle, leader }: { circle: RefObject<HTMLElement | null>; leader: boolean }) {
  const lon = useStore((s) => (s.summary && s.summary.id === s.incidentId && Number.isFinite(s.summary.lon) ? s.summary.lon : null))
  const lat = useStore((s) => (s.summary && s.summary.id === s.incidentId && Number.isFinite(s.summary.lat) ? s.summary.lat : null))
  const reported = useMemo(() => (lon != null && lat != null ? ([lon, lat] as const) : null), [lon, lat])
  const anchor = useMapAnchor(reported)
  const geom = useCircleGeom(circle, leader)
  // what may cover the line changes without a map move: the search pill and its list, a picked point's card, the chrome
  useSearchUi((s) => s.searchOpen)
  useSearchUi((s) => s.popover)
  useWorkspace((s) => s.selection)
  useWorkspace((s) => s.safeInsets)
  if (!anchor || !anchor.inView) return null
  const rects = blockingRects()
  const covered = rects.some((r) => insideRect(anchor.x, anchor.y, r))
  let line: { x1: number; y1: number; x2: number; y2: number } | null = null
  if (leader && geom && !covered) {
    const dx = anchor.x - geom.x
    const dy = anchor.y - geom.y
    const len = Math.hypot(dx, dy)
    // from the circle's edge to the point's ring (12 px), only when the point is clear of the circle
    if (len > geom.r + 24) {
      const ux = dx / len
      const uy = dy / len
      const a = { x: geom.x + ux * (geom.r + 1), y: geom.y + uy * (geom.r + 1) }
      const b = { x: anchor.x - ux * 13, y: anchor.y - uy * 13 }
      if (!rects.some((r) => segmentHitsRect(a, b, r))) line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }
  }
  return (
    <svg className="pfv-overlay" width="100%" height="100%" aria-hidden="true">
      {line && <line className="pfv-leader" x1={line.x1.toFixed(1)} y1={line.y1.toFixed(1)} x2={line.x2.toFixed(1)} y2={line.y2.toFixed(1)} />}
      {!covered && (
        <g className="pfv-point" transform={`translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)})`}>
          <circle r="22" className="pfv-point-halo" />
          <circle r="12" className="pfv-point-dot" />
          <circle r="3" className="pfv-point-core" />
        </g>
      )}
    </svg>
  )
}
