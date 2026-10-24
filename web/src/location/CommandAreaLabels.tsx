// Command's map labels with leaders (brief 4, CommandView.dc.html; PLAN-4 §3.2): "Observed fire" with the time the map
// shows, and "Modeled spread" with the time it is modeled to ("BY OCT 25, 13:30 PDT · EXPERIMENTAL"). A DOM overlay
// over the map (aria-hidden: the legend names both layers): after the map settles it reads the drawn outlines
// (queryRenderedFeatures on the observed edge and the modeled 10 % outline), anchors each label on the outline (the
// observed one up and to the right, the modeled one down and to the right), keeps it inside the free map (the safe area)
// and off the selection pin's chip, and hides while the map moves. Pure placement: areaLabels.ts.
import type { Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useState } from 'react'
import { fmtAt } from '../lib/time'
import { LYR } from '../map/layers'
import { useMapRuntime } from '../map/mapStore'
import { useTimeFormat } from '../state/timeZone'
import { useWorkspace } from '../state/workspace'
import { labelWidth, overlaps, pickAnchor, placeLeader, type Box, type LeaderPlan, type LeaderShape, type Pt } from './areaLabels'

/** At most this many outline points are projected per label (every n-th vertex of long outlines). */
const MAX_POINTS = 1500

interface Placed extends LeaderPlan {
  key: 'observed' | 'modeled'
  name: string
  meta: string
}

function outlinePoints(map: MapLibreMap, layer: string): Pt[] {
  if (!map.getLayer(layer)) return []
  const lines: number[][][] = []
  for (const f of map.queryRenderedFeatures({ layers: [layer] })) {
    const g = f.geometry
    if (g.type === 'LineString') lines.push(g.coordinates)
    else if (g.type === 'MultiLineString' || g.type === 'Polygon') lines.push(...g.coordinates)
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) lines.push(...poly)
  }
  const total = lines.reduce((a, l) => a + l.length, 0)
  const stride = Math.max(1, Math.ceil(total / MAX_POINTS))
  const out: Pt[] = []
  let i = 0
  for (const line of lines)
    for (const c of line) {
      if (i++ % stride !== 0) continue
      const p = map.project([c[0], c[1]])
      out.push({ x: p.x, y: p.y })
    }
  return out
}

const OBSERVED_SHAPE: LeaderShape = { dx: 50, dy: -48, run: 60 }
const MODELED_SHAPE: LeaderShape = { dx: 38, dy: 40, run: 40 }

function samePlaced(a: Placed[], b: Placed[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && p.meta === b[i].meta && p.side === b[i].side && Math.abs(p.anchor.x - b[i].anchor.x) < 0.5 && Math.abs(p.anchor.y - b[i].anchor.y) < 0.5)
  )
}

export function CommandAreaLabels() {
  const map = useMapRuntime((s) => s.map)
  const observed = useMapRuntime((s) => s.overlays.observed)
  const forecast = useMapRuntime((s) => s.overlays.forecast)
  const showObserved = useWorkspace((s) => s.mapLayers.observed)
  const showForecast = useWorkspace((s) => s.mapLayers.forecast)
  const insets = useWorkspace((s) => s.safeInsets)
  const tf = useTimeFormat()
  const [placed, setPlaced] = useState<Placed[]>([])
  const [moving, setMoving] = useState(false)

  const observedMeta = showObserved && observed.status === 'ready' && observed.asOfMs != null && observed.burnedPx > 0 ? fmtAt(observed.asOfMs, tf, { zone: true }) : null
  const frame = forecast.frame
  const modeledMeta = showForecast && forecast.status === 'ready' && frame && frame.kind !== 'before-start' ? `By ${fmtAt(frame.byMs, tf, { zone: true })} · experimental` : null

  useEffect(() => {
    if (!map) return
    let raf = 0
    const compute = () => {
      raf = 0
      const c = map.getContainer()
      const area: Box = { left: insets.left, top: insets.top, right: c.clientWidth - insets.right, bottom: c.clientHeight - insets.bottom }
      const avoid: Box[] = []
      const chip = c.querySelector('.fxm-pin-chip')?.getBoundingClientRect()
      const host = c.getBoundingClientRect()
      if (chip && chip.width > 0) avoid.push({ left: chip.left - host.left - 6, top: chip.top - host.top - 6, right: chip.right - host.left + 6, bottom: chip.bottom - host.top + 6 })
      const next: Placed[] = []
      const add = (key: Placed['key'], layer: string, name: string, meta: string, shape: LeaderShape, score: (p: Pt) => number) => {
        const a = pickAnchor(outlinePoints(map, layer), area, score)
        if (!a) return
        const p = placeLeader(a, labelWidth(name, meta), shape, area, avoid)
        if (!p) return
        avoid.push(p.box)
        next.push({ ...p, key, name, meta })
      }
      if (observedMeta) add('observed', LYR.observedEdge, 'Observed fire', observedMeta, OBSERVED_SHAPE, (p) => p.x - p.y)
      if (modeledMeta) add('modeled', LYR.forecastLine10, 'Modeled spread', modeledMeta, MODELED_SHAPE, (p) => p.x + 0.6 * p.y)
      // a label never covers the other's anchor
      const clean = next.filter((p) => !next.some((q) => q !== p && overlaps(p.box, { left: q.anchor.x - 2, right: q.anchor.x + 2, top: q.anchor.y - 2, bottom: q.anchor.y + 2 })))
      setPlaced((prev) => (samePlaced(prev, clean) ? prev : clean))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    const onStart = () => setMoving(true)
    const onEnd = () => {
      setMoving(false)
      schedule()
    }
    map.on('movestart', onStart)
    map.on('moveend', onEnd)
    map.on('idle', schedule)
    schedule()
    return () => {
      map.off('movestart', onStart)
      map.off('moveend', onEnd)
      map.off('idle', schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [map, insets, observedMeta, modeledMeta])

  if (!map || moving || placed.length === 0) return null
  return (
    <div className="cmd-labels" aria-hidden="true">
      <svg className="cmd-labels-lines" width="100%" height="100%">
        {placed.map((p) => (
          <path key={p.key} className={`is-${p.key}`} d={`M${p.anchor.x} ${p.anchor.y} L${p.elbow.x} ${p.elbow.y} H${p.end.x}`} />
        ))}
      </svg>
      {placed.map((p) => (
        <div key={p.key} className={`cmd-label is-${p.key} is-${p.side}`} style={{ left: p.box.left, top: p.box.top, width: p.box.right - p.box.left }}>
          <span className="cmd-label-name">{p.name}</span>
          <span className="cmd-label-meta">{p.meta}</span>
        </div>
      ))}
    </div>
  )
}
