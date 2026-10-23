// Telemetry columns (SPEC 9.0 / 9.3): small gold monospace readouts (3-8 lines, ~70 % opacity, billboarded,
// constant screen size, hairline leader to the anchor) at the ignition, the top-3 active front clusters and the
// hover probe (sceneStore.probe). Real values only: lat/lon, elevation, T+hh:mm since ignition, local ROS, FRP of the
// latest satellite pass, wind, burn probability, fuel, slope. Values follow the active fronts (recomputed every
// >= 10 min of sim time); changed digits tick briefly. Columns that overlap a higher-priority column on screen fade
// out (probe > ignition > front 1 > 2 > 3). Hidden in realistic mode.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { cardinal, fmtDistance, fmtElev, fmtFrp, fmtMph, fmtNumber, fmtRos } from '../../lib/format'
import { fuelInfo } from '../../lib/fuels'
import { localToLonLat } from '../../lib/geo'
import { fmtAt, fmtTPlus } from '../../lib/time'
import { useStore } from '../../state/store'
import { useTimeFormat } from '../../state/timeZone'
import type { IncidentAssets } from '../assets'
import { useSceneStore, type Probe } from '../sceneStore'
import { HOUR_MS, prefersReducedMotion, useLayer, useReducedMotion } from './common'
import { fxShared, fxStore, type FrontCluster } from './state'
import { InOverlay, ScreenLabel, useTicker } from './text'
import { sampleWind, windFromDeg } from './wind'

const FONT_PX = 11
const LINE_H = 1.32
const GOLD = '#E8C77E'
const HEAD = '#FFF0CC'
const FIRE = '#FFB347'

function latLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`
}

const pad = (label: string, n = 6) => (label.length >= n ? `${label} ` : label + ' '.repeat(n - label.length))

interface ColumnSpec {
  id: string
  lines: string[]
  headColor: string
  /** Anchor: world x, z and ground elevation (m, not exaggerated). */
  x: number
  z: number
  elev: number
  offset: [number, number]
  priority: number
  tick: boolean
}

interface ColumnSlot {
  fade: { current: number }
  flip: { current: boolean }
  target: number
  screen: { x: number; y: number; visible: boolean }
  pos: THREE.Vector3 // smoothed anchor (x, elev m, z)
  init: boolean
}

function Column({ spec, slot, opacity }: { spec: ColumnSpec; slot: ColumnSlot; opacity: number }) {
  const reduced = useReducedMotion()
  const text = useTicker(spec.lines.join('\n'), spec.tick && !reduced)
  const anchor = useMemo(
    () => (out: THREE.Vector3) => {
      const p = slot.pos
      if (!slot.init) {
        p.set(spec.x, spec.elev, spec.z)
        slot.init = true
      }
      const k = Math.min(1, fxShared.dt * 5)
      p.x += (spec.x - p.x) * k
      p.y += (spec.elev - p.y) * k
      p.z += (spec.z - p.z) * k
      out.set(p.x, p.y * useStore.getState().exaggeration + 8, p.z)
      return true
    },
    [spec.x, spec.z, spec.elev, slot],
  )
  const firstLen = spec.lines[0]?.length ?? 0
  return (
    <ScreenLabel
      anchor={anchor}
      text={text}
      offset={spec.offset}
      fontPx={FONT_PX}
      lineHeight={LINE_H}
      color={GOLD}
      colorRanges={{ 0: spec.headColor, [firstLen]: GOLD }}
      opacity={0.74 * opacity}
      fade={slot.fade}
      flip={slot.flip}
      screen={slot.screen}
      leader
      dot
    />
  )
}

function frontColumn(c: FrontCluster, rank: number, t0Ms: number, tMs: number, forecast: boolean, grid: IncidentAssets['manifest']['grid']): ColumnSpec {
  const [lon, lat] = localToLonLat(c.x, c.z, grid)
  const w = { u: 0, v: 0 }
  sampleWind(fxShared.wind, c.x, c.z, w)
  const speed = Math.hypot(w.u, w.v)
  const lines = [
    `FRONT ${String(rank + 1).padStart(2, '0')} · ${forecast ? 'FCST P50' : 'ACTIVE'}`,
    latLon(lat, lon),
    `${pad('ELEV')}${fmtElev(c.elev)}`,
    `${pad('ARR')}${fmtTPlus((tMs - t0Ms) / HOUR_MS)}`,
  ]
  if (c.rosChPerH != null) lines.push(`${pad('ROS')}${fmtRos(c.rosChPerH)}`)
  if (c.frpMw != null && c.frpTMs != null) {
    const ago = Math.max(0, (tMs - c.frpTMs) / HOUR_MS)
    const agoTxt = ago < 1 / 60 ? '<1m' : ago < 1 ? `${Math.round(ago * 60)}m` : `${ago.toFixed(0)}h`
    lines.push(`${pad('FRP')}${fmtFrp(c.frpMw)} ${c.frpInstrument ?? ''} ${agoTxt} ago`)
  }
  if (fxShared.wind.valid) lines.push(`${pad('WIND')}${fmtMph(speed)} ${cardinal(windFromDeg(w.u, w.v))}`)
  lines.push(`${pad('LEN')}${fmtDistance(c.lengthM)}  +${fmtNumber(c.growthAcPerH)} ac/h`)
  return { id: `front-${rank}`, lines, headColor: forecast ? GOLD : FIRE, x: c.x, z: c.z, elev: c.elev, offset: [28, 54 + rank * 6], priority: 2 + rank, tick: true }
}

function probeColumn(p: Probe, t0Ms: number, originMs: number, tH: number, hasForecast: boolean): ColumnSpec {
  const f = fuelInfo(p.fuel)
  const slopeDeg = (Math.atan(p.slope) * 180) / Math.PI
  const lines = [`PROBE`, latLon(p.lat, p.lon), `${pad('ELEV')}${fmtElev(p.elev)}  SLOPE ${fmtNumber(slopeDeg)}°`]
  const fuelName = f.name.length > 24 ? `${f.name.slice(0, 23)}…` : f.name
  lines.push(`${pad('FUEL')}${f.label} ${fuelName}`)
  if (p.arrivalH == null) lines.push(`${pad('ARR')}UNBURNED`)
  else {
    const tp = fmtTPlus((originMs + p.arrivalH * HOUR_MS - t0Ms) / HOUR_MS)
    lines.push(`${pad('ARR')}${tp} ${p.arrivalH <= tH ? 'BURNED' : 'LATER'}`)
  }
  if (hasForecast && p.pBurn != null) {
    const now = p.pBurnNow != null ? `  NOW ${fmtNumber(p.pBurnNow * 100)}%` : ''
    lines.push(`${pad('P(BURN)', 8)}${fmtNumber(p.pBurn * 100)}%${now}`)
  }
  if (p.canopyPct != null && p.canopyPct > 0) lines.push(`${pad('CANOPY')}${fmtNumber(p.canopyPct)}%`)
  return { id: 'probe', lines, headColor: HEAD, x: p.x, z: p.z, elev: p.elev, offset: [22, 26], priority: 0, tick: false }
}

const tenMinutesOf = () => Math.floor(useStore.getState().timeMs / 600_000)
const frontsVersionOf = () => fxStore.getState().frontsVersion

/** A value that follows `source()` (a stable getter, re-read on store changes), but at most every `ms` while the
 *  timeline plays, so troika text re-layouts stay cheap during playback. */
function useThrottled<T>(source: () => T, ms: number): T {
  const [v, setV] = useState(source)
  useEffect(() => {
    let last = 0
    let timer = 0
    const check = () => {
      const next = source()
      if (Object.is(next, v)) return
      const now = performance.now()
      const apply = () => {
        last = performance.now()
        timer = 0
        setV(source())
      }
      if (!useStore.getState().playing || now - last >= ms) apply()
      else if (!timer) timer = window.setTimeout(apply, ms - (now - last))
    }
    const a = fxStore.subscribe(check)
    const b = useStore.subscribe(check)
    return () => {
      a()
      b()
      if (timer) window.clearTimeout(timer)
    }
  }, [source, ms, v])
  return v
}

function Columns({ assets, opacity }: { assets: IncidentAssets; opacity: number }) {
  const m = assets.manifest
  const ign = m.ignition
  const t0 = ign?.t_ms ?? m.time_range.start_ms
  const tenMin = useThrottled(tenMinutesOf, 250)
  const hasForecast = useStore((s) => s.forecast != null)
  useStore((s) => s.exaggeration)
  const frontsVersion = useThrottled(frontsVersionOf, 250)
  const fronts = fxStore((s) => s.fronts)
  const probe = useSceneStore((s) => s.probe)
  const interacting = useSceneStore((s) => s.interacting)
  const tf = useTimeFormat()

  const specs = useMemo(() => {
    const tMs = useStore.getState().timeMs
    const out: ColumnSpec[] = []
    if (ign) {
      const elev = assets.heightAt(ign.x, ign.z)
      const since = (tMs - ign.t_ms) / HOUR_MS
      const src = /cal ?fire/i.test(ign.source) ? 'CAL FIRE' : /nifc|wfigs|irwin/i.test(ign.source) ? 'NIFC' : /firms|viirs|modis|goes|detect/i.test(ign.source) ? 'FIRMS' : 'EST.'
      out.push({
        id: 'ignition',
        lines: [`IGNITION · ${src}`, latLon(ign.lat, ign.lon), `${pad('ELEV')}${fmtElev(elev)}`, `${pad('T0')}${fmtAt(ign.t_ms, tf, { zone: true })}`, `${pad('NOW')}${fmtTPlus(since)}`],
        headColor: HEAD,
        x: ign.x,
        z: ign.z,
        elev,
        offset: [22, 40],
        priority: 1,
        tick: true,
      })
    }
    if (fronts) {
      const picked: FrontCluster[] = []
      for (const c of fronts.clusters) {
        if (picked.length >= 3) break
        if (c.lengthM < 240 || c.pixels < 4) continue
        if (picked.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 700)) continue
        if (ign && Math.hypot(ign.x - c.x, ign.z - c.z) < 250) continue
        picked.push(c)
      }
      picked.forEach((c, rank) => out.push(frontColumn(c, rank, t0, fronts.tMs, fronts.source === 'forecast', m.grid)))
    }
    if (probe && !interacting) out.push(probeColumn(probe, t0, m.time_origin_ms, (tMs - m.time_origin_ms) / HOUR_MS, hasForecast))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontsVersion, fronts, probe, interacting, tenMin, hasForecast, ign, assets, t0, m, tf])

  const slots = useRef(new Map<string, ColumnSlot>())
  const slotFor = (id: string): ColumnSlot => {
    let s = slots.current.get(id)
    if (!s) {
      s = { fade: { current: 0 }, flip: { current: false }, target: 1, screen: { x: 0, y: 0, visible: false }, pos: new THREE.Vector3(), init: false }
      slots.current.set(id, s)
    }
    return s
  }
  const live = useMemo(
    () =>
      specs
        .map((spec) => ({
          spec,
          slot: slotFor(spec.id),
          wPx: Math.max(...spec.lines.map((l) => l.length)) * FONT_PX * 0.62,
          hPx: spec.lines.length * FONT_PX * LINE_H,
        }))
        .sort((a, b) => a.spec.priority - b.spec.priority),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [specs],
  )
  const rects = useMemo(() => new Float32Array(4 * 16), [])

  // Screen-space declutter: a column overlapping a higher-priority one fades out (allocation-free per frame).
  useFrame((state) => {
    let n = 0
    const k = prefersReducedMotion() ? 1 : Math.min(1, fxShared.dt * 6)
    const insets = useSceneStore.getState().viewInsets
    const right = state.size.width - insets.right - 6
    for (let i = 0; i < live.length; i++) {
      const { spec, slot, wPx, hPx } = live[i]
      const sc = slot.screen
      // mirror to the left of the anchor when the block would run under the right-hand UI / off screen
      const overflow = sc.x + spec.offset[0] + wPx > right
      const roomLeft = sc.x - spec.offset[0] - wPx > insets.left + 6
      slot.flip.current = overflow && roomLeft
      const x0 = slot.flip.current ? sc.x - spec.offset[0] - wPx - 4 : sc.x + spec.offset[0] - 4
      const y1 = sc.y - spec.offset[1] + 4
      const x1 = x0 + wPx + 8
      const y0 = y1 - hPx - 8
      let blocked = false
      if (sc.visible) {
        for (let q = 0; q < n; q++) {
          const o = q * 4
          if (x0 < rects[o + 2] && x1 > rects[o] && y0 < rects[o + 3] && y1 > rects[o + 1]) blocked = true
        }
        if (!blocked && n < 16) {
          rects[n * 4] = x0
          rects[n * 4 + 1] = y0
          rects[n * 4 + 2] = x1
          rects[n * 4 + 3] = y1
          n++
        }
      }
      slot.target = blocked ? 0 : 1
      slot.fade.current += (slot.target - slot.fade.current) * k
    }
    for (let i = 0; i < n * 4; i++) fxShared.labelRects[i] = rects[i]
    fxShared.labelRectCount = n
  })
  useEffect(() => () => {
    fxShared.labelRectCount = 0
  }, [])

  return (
    <>
      {live.map(({ spec, slot }) => (
        <Column key={spec.id} spec={spec} slot={slot} opacity={opacity} />
      ))}
    </>
  )
}

export function Telemetry({ assets }: { assets: IncidentAssets }) {
  const { visible, opacity } = useLayer('telemetry')
  const style = useStore((s) => s.visualStyle)
  if (!visible || style === 'realistic') return null
  return (
    <InOverlay>
      <Columns assets={assets} opacity={opacity} />
    </InOverlay>
  )
}
