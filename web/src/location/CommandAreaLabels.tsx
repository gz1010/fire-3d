// Command's map labels with leaders (brief 4, CommandView.dc.html; PLAN-4 §3.2): "Observed fire" with its area and the
// time the map shows (never later than the latest observation: areaLabels.ts observedLabelMeta), and "Modeled spread" with the time it is modeled to ("BY OCT 25, 13:30 PDT · EXPERIMENTAL"). A DOM overlay
// over the map (aria-hidden: the legend names both layers): after the map settles it reads the drawn outlines
// (queryRenderedFeatures on the observed edge and the modeled 10 % outline), anchors each label on the outline (the
// observed one up and to the right, the modeled one down and to the right), keeps it inside the free map (the safe area)
// and off the selection pin's chip, the fire's own point and label ("<name> / REPORTED") and the key events' dots and
// labels (as MapLibre placed them), drops it when no slot is free, and hides while the map moves. Pure placement:
// areaLabels.ts.
import type { Map as MapLibreMap } from 'maplibre-gl'
import { useEffect, useState } from 'react'
import { fmtAt } from '../lib/time'
import { LYR } from '../map/layers'
import { useMapRuntime } from '../map/mapStore'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { useWorkspace } from '../state/workspace'
import { labelWidth, observedLabelMeta, seriesAcresAt, overlaps, placeAlong, rankAnchors, type Box, type LeaderPlan, type LeaderShape, type Pt } from './areaLabels'

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

/** The screen's leaders (up and right for the observed fire, down and right for the modeled spread), then the same
 *  leader flipped vertically when the preferred one has no room. */
const OBSERVED_SHAPES: LeaderShape[] = [
  { dx: 50, dy: -48, run: 60 },
  { dx: 50, dy: 48, run: 60 },
]
const MODELED_SHAPES: LeaderShape[] = [
  { dx: 38, dy: 40, run: 40 },
  { dx: 38, dy: -40, run: 40 },
]

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
  const latestMs = useStore((s) => s.manifest?.time_range.now_ms ?? null)
  const series = useStore((s) => s.timeseries)
  const units = useWorkspace((s) => s.units)
  const tf = useTimeFormat()
  const [placed, setPlaced] = useState<Placed[]>([])
  const [moving, setMoving] = useState(false)

  // the observed label's line with the area, and without it when that is too wide for the free map ("|"-joined, so the
  // effect below depends on a string)
  const observedMetas =
    showObserved && observed.status === 'ready' && observed.asOfMs != null && observed.burnedPx > 0
      ? [
          observedLabelMeta(observed.asOfMs, latestMs, (ms) => seriesAcresAt(series, ms), units, (ms) => fmtAt(ms, tf, { zone: true })),
          observedLabelMeta(observed.asOfMs, latestMs, () => null, units, (ms) => fmtAt(ms, tf, { zone: true })),
        ].join('|')
      : null
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
      // the map's own points and labels this overlay must not cover (only what MapLibre actually drew)
      const under = [LYR.incidentLabel, LYR.incidentCircle, LYR.eventsLabel, LYR.eventsCircle].filter((id) => map.getLayer(id))
      const blocked = (b: Box) => under.length > 0 && map.queryRenderedFeatures([[b.left, b.top], [b.right, b.bottom]], { layers: under }).length > 0
      const next: Placed[] = []
      const add = (key: Placed['key'], layer: string, name: string, metas: readonly string[], shapes: readonly LeaderShape[], score: (p: Pt) => number) => {
        // the best-scoring outline points first; the next ones when a label would leave the free map or cover another;
        // then the next (shorter) meta line
        const anchors = rankAnchors(outlinePoints(map, layer), area, score)
        for (const meta of metas) {
          const p = placeAlong(anchors, labelWidth(name, meta), shapes, area, avoid, blocked)
          if (!p) continue
          avoid.push(p.box)
          next.push({ ...p, key, name, meta })
          return
        }
      }
      if (observedMetas) add('observed', LYR.observedEdge, 'Observed fire', [...new Set(observedMetas.split('|'))], OBSERVED_SHAPES, (p) => p.x - p.y)
      if (modeledMeta) add('modeled', LYR.forecastLine10, 'Modeled spread', [modeledMeta], MODELED_SHAPES, (p) => p.x + 0.6 * p.y)
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
  }, [map, insets, observedMetas, modeledMeta])

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
