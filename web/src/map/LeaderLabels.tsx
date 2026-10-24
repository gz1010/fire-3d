// Leader-line labels for the largest named fires on the national overview (brief 4 decision e; HANDOFF "Fire markers":
// "Named large fires get leader-line labels with the name and '172,912 AC'"). A DOM overlay over the map and under the
// chrome (aria-hidden: the fire list names every fire; a click on a label is a click on its marker, map/mapController
// openFireFromOverview → state/fireCard.pickFire). At most 12 fires in view, largest first: large active fires (the
// pinned ones, 5,000 acres or more) and any fire of 20,000 acres or more, as long as MapLibre draws its own marker (not
// inside a group). Two lines (the name in Inter 12/600, the acres in mono 10), a 0.9 px leader; placed by the pure,
// greedy map/leaderLayout.ts inside the free map (the safe area), off the chrome, the other markers and groups, each
// other, the basemap's place names and the selected point's label; leaders are short (at most 140 px, 90 on a phone),
// never cross each other and run over no other marker's middle, group centre or count. Recomputed when the map settles, the window or the chrome changes, or the fire
// lists change (once the map is idle with them), never on the map's own idle otherwise (that would feed back); during a
// pan or a turn the labels follow their markers (one projection each per frame); hidden while
// zooming and from z5, where the map's own labels take over (with no collisions to manage). Below z5 the map leaves out
// its own labels of every candidate (useMapRuntime.leaderIds → overviewLayers.labelFilters): of the ones named here,
// and of the ones not named (past the 12th, or with no free spot), whose MapLibre labels ran across the leaders and the
// names (MapLibre cannot keep clear of this overlay); the fire list names them all.
import type { MapGeoJSONFeature, Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pickFire } from '../state/fireCard'
import { useWorkspace } from '../state/workspace'
import { LEADER_MAX, LEADER_MAX_LEN, LEADER_MAX_LEN_NARROW, layoutLeaders, leaderAcres, placeLabelLayers, type Circle, type LeaderItem, type LeaderSpot, type Rect } from './leaderLayout'
import { useMapRuntime } from './mapStore'
import { GROUP_LABEL_PX, groupRadius, LABEL_MIN_ACRES, OVR, SMALL_MAP_SCALE, SMALL_MAP_ZOOM, FULL_SIZE_ZOOM, ZOOM_GROWTH } from './overviewLayers'

/** Leader labels show below this zoom only (the map's own labels from z5 on: §14.11 label thresholds). */
export const LEADER_MAX_ZOOM = 5
/** Maps narrower than this (phones) name at most NARROW_LEADER_MAX fires. */
const NARROW_MAP_PX = 500
const NARROW_LEADER_MAX = 5
const NAME_FONT = '600 12px Inter, system-ui, sans-serif'
const META_FONT = '400 10px "JetBrains Mono", ui-monospace, monospace'
const LABEL_H = 28

interface Spot extends LeaderSpot {
  name: string
  meta: string
  lngLat: [number, number]
}

let measureCtx: CanvasRenderingContext2D | null | undefined
function textWidth(text: string, font: string, tracking = 0): number {
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return measureCtx.measureText(text).width + tracking * text.length
}

/** The marker scale at a zoom (as overviewLayers.zoomed). */
function markerScale(zoom: number): number {
  if (zoom <= SMALL_MAP_ZOOM) return SMALL_MAP_SCALE
  if (zoom < FULL_SIZE_ZOOM) return SMALL_MAP_SCALE + ((zoom - SMALL_MAP_ZOOM) / (FULL_SIZE_ZOOM - SMALL_MAP_ZOOM)) * (1 - SMALL_MAP_SCALE)
  if (zoom <= 7) return 1
  return 1 + (Math.min(zoom, 10) - 7) / 3 * (ZOOM_GROWTH - 1)
}

const SINGLE_LAYERS = [OVR.pinnedLive, OVR.pinnedPast, OVR.activePoint, OVR.otherPoint]
const GROUP_LAYERS = [OVR.activeCluster, OVR.otherCluster]

const isCountryLayer = (id: string) => /country/.test(id)

const pointOf = (f: MapGeoJSONFeature): [number, number] | null => (f.geometry.type === 'Point' ? (f.geometry.coordinates as [number, number]) : null)

/** Chrome inside the map that a label must not cover: every visible [data-chrome] slot, the banners, the selected
 *  point's label and the search / locate popovers. */
function chromeRects(host: DOMRect): Rect[] {
  const out: Rect[] = []
  document.querySelectorAll<HTMLElement>('.mw [data-chrome], .mw .top-center > *, .fxm-pin, .loc-search-below > *, .loc-locate-below > *').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    out.push({ left: r.left - host.left, top: r.top - host.top, right: r.right - host.left, bottom: r.bottom - host.top })
  })
  return out
}

interface Layout {
  spots: Spot[]
  /** The other candidates: their map labels stay hidden too below z5. */
  quiet: string[]
}

const NONE: Layout = { spots: [], quiet: [] }

function computeSpots(map: MapLibreMap, insets: { top: number; right: number; bottom: number; left: number }, units: 'us' | 'metric'): Layout {
  const zoom = map.getZoom()
  if (zoom >= LEADER_MAX_ZOOM) return NONE
  const present = (ids: readonly string[]) => ids.filter((id) => map.getLayer(id))
  const singles = present(SINGLE_LAYERS)
  if (!singles.length) return NONE
  const c = map.getContainer()
  const host = c.getBoundingClientRect()
  const free: Rect = { left: insets.left, top: insets.top, right: c.clientWidth - insets.right, bottom: c.clientHeight - insets.bottom }
  const scale = markerScale(zoom)
  const seen = new Set<string>()
  const candidates: (LeaderItem & { acres: number; name: string; lngLat: [number, number] })[] = []
  const circles: Circle[] = []
  for (const f of map.queryRenderedFeatures({ layers: singles })) {
    const p = f.properties ?? {}
    const id = typeof p.id === 'string' ? p.id : null
    const ll = pointOf(f)
    if (!id || !ll || seen.has(id)) continue
    seen.add(id)
    const at = map.project(ll)
    const r = (Number(p.r) || 6) * scale
    circles.push({ x: at.x, y: at.y, r, id })
    const acres = Number(p.acres) || 0
    const name = String(p.name ?? '').replace(/\s+fire$/i, '').trim()
    if (!name || !(p.kind === 'large' || acres >= LABEL_MIN_ACRES)) continue
    const meta = leaderAcres(acres, units)
    const w = Math.ceil(Math.max(textWidth(name, NAME_FONT), textWidth(meta, META_FONT, 0.4))) + 2
    candidates.push({ id, at: { x: at.x, y: at.y }, r, w, h: LABEL_H, acres, name, lngLat: ll })
  }
  // groups: their circle and their "N FIRES" label at the upper right
  const obstacles = chromeRects(host)
  // a leader line may cross a place name, never the chrome or a group's count
  const lineObstacles = [...obstacles]
  const groups = present(GROUP_LAYERS)
  // the counts MapLibre placed (a count with no room is left out since DF-H34-1: its spot is free)
  const counted = new Set<string>()
  const countLayers = present([OVR.activeCount, OVR.otherCount])
  if (countLayers.length) for (const f of map.queryRenderedFeatures({ layers: countLayers })) counted.add(`${f.source}:${f.properties?.cluster_id}`)
  if (groups.length)
    for (const f of map.queryRenderedFeatures({ layers: groups })) {
      const ll = pointOf(f)
      if (!ll) continue
      const at = map.project(ll)
      const r = groupRadius(Number(f.properties?.point_count) || 0) * scale
      // a label may cross a group's thin ring (as the screen's do), never its centre or its "N FIRES"
      circles.push({ x: at.x, y: at.y, r: 5 })
      const e = r * Math.SQRT1_2
      if (countLayers.length && !counted.has(`${f.source}:${f.properties?.cluster_id}`)) continue
      // "28 FIRES": the tick (7 px), the count's digits (13 px Noto Sans Bold) and " FIRES" (8 px), a little room
      const digits = String(f.properties?.point_count_abbreviated ?? f.properties?.point_count ?? '').length
      const count = { left: at.x + e, top: at.y - e - GROUP_LABEL_PX - 2, right: at.x + e + 7 + digits * 8 + 36, bottom: at.y - e + 4 }
      obstacles.push(count)
      lineObstacles.push(count)
    }
  // the basemap's place names (countries, states, cities) as MapLibre drew them: an estimated box around each
  const places = present(placeLabelLayers(map.getStyle()?.layers ?? []))
  if (places.length)
    for (const f of map.queryRenderedFeatures({ layers: places })) {
      const ll = pointOf(f)
      const name = String(f.properties?.['name:latin'] ?? f.properties?.name ?? '')
      if (!ll || !name) continue
      const at = map.project(ll)
      const big = isCountryLayer(f.layer.id)
      const words = name.split(/\s+/)
      const w = (big ? Math.max(...words.map((x) => x.length)) * 10 : name.length * 7) + 8
      const h = big ? words.length * 20 : 18
      obstacles.push({ left: at.x - w / 2, top: at.y - h / 2, right: at.x + w / 2, bottom: at.y + h / 2 })
    }
  candidates.sort((a, b) => b.acres - a.acres || a.id.localeCompare(b.id))
  const byId = new Map(candidates.map((x) => [x.id, x]))
  // a phone's national view holds the lower 48 in a few hundred pixels: fewer names
  const narrow = c.clientWidth < NARROW_MAP_PX
  const max = narrow ? NARROW_LEADER_MAX : LEADER_MAX
  const placed = layoutLeaders(candidates, { free, obstacles, lineObstacles, circles, max, maxLen: narrow ? LEADER_MAX_LEN_NARROW : LEADER_MAX_LEN })
  const spots = placed.map((s) => {
    const x = byId.get(s.id)!
    return { ...s, name: x.name, meta: leaderAcres(x.acres, units), lngLat: x.lngLat }
  })
  // every other candidate keeps quiet at this zoom: the map's own label could not keep clear of the named ones (it
  // knows nothing of this overlay), and from z5 on the map's labels take over
  const named = new Set(placed.map((p) => p.id))
  const quiet = candidates.filter((c) => !named.has(c.id)).map((c) => c.id)
  return { spots, quiet }
}

const sameSpots = (a: readonly Spot[], b: readonly Spot[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i].id && s.meta === b[i].meta && Math.abs(s.box.left - b[i].box.left) < 0.5 && Math.abs(s.box.top - b[i].box.top) < 0.5)

export function LeaderLabels() {
  const map = useMapRuntime((s) => s.map)
  const insets = useWorkspace((s) => s.safeInsets)
  const units = useWorkspace((s) => s.units)
  const [spots, setSpots] = useState<Spot[]>([])
  const [quiet, setQuiet] = useState<readonly string[]>([])
  const [hidden, setHidden] = useState(false)
  const layer = useRef<HTMLDivElement | null>(null)

  // the map leaves out its own labels of the fires named here
  useEffect(() => {
    const ids = [...spots.map((s) => s.id), ...quiet].sort()
    const cur = useMapRuntime.getState().leaderIds
    if (ids.length !== cur.length || ids.some((id, i) => id !== cur[i])) useMapRuntime.setState({ leaderIds: ids })
  }, [spots, quiet])
  useEffect(() => () => useMapRuntime.setState({ leaderIds: [] }), [])

  // layout when the map settles, the chrome or the window changes, or the fire lists' data changes
  useEffect(() => {
    if (!map) return
    let raf = 0
    let zooming = false
    const compute = () => {
      raf = 0
      if (zooming || map.isMoving()) return
      const next = computeSpots(map, useWorkspace.getState().safeInsets, units)
      setSpots((prev) => (sameSpots(prev, next.spots) ? prev : next.spots))
      setQuiet((prev) => (prev.length === next.quiet.length && prev.every((id, i) => id === next.quiet[i]) ? prev : next.quiet))
      setHidden(false)
      // a fresh layout sits where it was computed
      layer.current?.querySelectorAll<HTMLElement | SVGElement>('[data-ldr]').forEach((el) => el.style.removeProperty('transform'))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    const onZoomStart = () => {
      zooming = true
      setHidden(true)
    }
    const onMoveEnd = () => {
      zooming = false
      schedule()
    }
    // new marker data (the lists, the filter, the units) is placed on the next render: lay out once the map is idle
    // again. Only then: an 'idle' after our own label filter changes would feed back (the basemap's place names come and
    // go with the fires' own labels) and the layout would never settle.
    let afterData = true
    const onData = (e: { sourceId?: string; isSourceLoaded?: boolean }) => {
      if (e.sourceId?.startsWith('fx-overview-') && e.isSourceLoaded) afterData = true
    }
    const onIdle = () => {
      if (!afterData) return
      afterData = false
      schedule()
    }
    map.on('zoomstart', onZoomStart)
    map.on('moveend', onMoveEnd)
    map.on('idle', onIdle)
    map.on('sourcedata', onData)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      map.off('zoomstart', onZoomStart)
      map.off('moveend', onMoveEnd)
      map.off('idle', onIdle)
      map.off('sourcedata', onData)
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [map, insets, units])

  // a pan or a turn: every label follows its marker (one projection per label and frame), no React render
  useLayoutEffect(() => {
    if (!map || spots.length === 0) return
    let raf = 0
    const follow = () => {
      raf = 0
      const root = layer.current
      if (!root) return
      for (const s of spots) {
        const p = map.project(s.lngLat)
        const t = `translate(${(p.x - s.at.x).toFixed(1)}px, ${(p.y - s.at.y).toFixed(1)}px)`
        root.querySelectorAll<HTMLElement | SVGElement>(`[data-ldr="${CSS.escape(s.id)}"]`).forEach((el) => {
          el.style.transform = t
        })
      }
    }
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(follow)
    }
    map.on('move', onMove)
    return () => {
      map.off('move', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [map, spots])

  if (!map || spots.length === 0) return null
  return (
    <div ref={layer} className="ldr-layer" aria-hidden="true" hidden={hidden}>
      <svg className="ldr-lines" width="100%" height="100%">
        {spots.map((s) => (
          <path key={s.id} data-ldr={s.id} d={`M${s.at.x.toFixed(1)} ${s.at.y.toFixed(1)} L${s.end.x.toFixed(1)} ${s.end.y.toFixed(1)}`} />
        ))}
      </svg>
      {spots.map((s) => (
        <div
          key={s.id}
          data-ldr={s.id}
          className={`ldr is-${s.side}`}
          style={{ left: s.box.left, top: s.box.top, width: s.box.right - s.box.left }}
          onClick={() => pickFire(s.id)}
        >
          <span className="ldr-name">{s.name}</span>
          <span className="ldr-meta">{s.meta}</span>
        </div>
      ))}
    </div>
  )
}
