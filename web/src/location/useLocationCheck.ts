// The location check of a selected point inside a fire (owner: location; brief 4 moved it out of LocationCard.tsx so the
// Public card and Command's readout share it): real geometry and nearest-pixel samples of the original UTM grids
// (checkLocation), worded by describeLocation; the official block at the point; coverage from the server's lookup; the
// fire's loading state and the zone line. Mounting it starts the point's raster downloads.
import { useDeferredValue, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRasterSet, type RasterSlot } from '../data/rasters'
import { zoneLine } from '../lib/time'
import type { OfficialInfo } from '../official/hooks'
import { useStore } from '../state/store'
import { useTimeFormat, useZoneSource } from '../state/timeZone'
import { useWorkspace, type Preset, type SelectedLocation } from '../state/workspace'
import { useNow } from '../ui/hooks'
import { detailsFor, useAddressDetails } from './addressStore'
import { describeLocation, type LocationCardModel } from './describe'
import { coverageText, useGeoLookup } from './geoLookup'
import { checkLocation } from './locationCheck'
import { officialBlock, officialFireWeatherNote, type OfficialBlock } from './official'
import type { LocationRasters } from './types'

const REQ = {
  incident: ['observed_arrival', 'elevation', 'fuel'],
  forecast: ['burn_probability', 'arrival_p10', 'arrival_p50', 'arrival_p90'],
} as const
const MISSING: RasterSlot = { status: 'missing', layer: null, error: null }

/** What a location check shows for a selected point inside a fire (shared by the location card and Command's
 *  readout, brief 4): the worded card, the official block at the point, coverage, the fire's loading state, the zone
 *  line. Mounting it starts the point's raster downloads. */
export interface LocationCheckView {
  card: LocationCardModel
  block: OfficialBlock
  coverage: string | null
  /** A fire just opened or focused by zooming: its files are on the way. */
  loadingFire: boolean
  /** "the Cedar Canyon Fire" / "Willow", else null. */
  fireName: string | null
  /** "Times: Pacific Time (PDT), the fire's local time". */
  zone: string
  preset: Preset
}

export function useLocationCheck(sel: SelectedLocation, official: OfficialInfo): LocationCheckView {
  const units = useWorkspace((s) => s.units)
  const preset = useWorkspace((s) => s.preset)
  const st = useStore(
    useShallow((s) => ({
      timeMs: s.timeMs,
      mode: s.manifest?.mode ?? s.mode,
      summary: s.summary,
      manifest: s.manifest?.status === 'ready' ? s.manifest : null,
      forecast: s.forecast,
      perimeters: s.perimeters,
      detections: s.detections,
      weather: s.weather,
    })),
  )
  // a fire just opened or focused by zooming (brief 2 decision 10): its files are on the way
  const loadingFire = useStore((s) => s.incidentLoading && !(s.manifest?.status === 'ready' && s.manifest.id === s.incidentId))
  const lastAddress = useAddressDetails((s) => s.details)
  const address = detailsFor(sel, lastAddress)
  const set = useRasterSet(REQ)
  const nowMs = useNow(60_000)
  const timeMs = useDeferredValue(st.timeMs) // playback moves the time every frame; the card may lag a frame
  const report = useMemo(() => {
    const rasters: LocationRasters = {
      observedArrival: set.incident.observed_arrival ?? MISSING,
      elevation: set.incident.elevation ?? MISSING,
      fuel: set.incident.fuel ?? MISSING,
      burnProbability: set.forecastLayers.burn_probability ?? MISSING,
      arrivalP10: set.forecastLayers.arrival_p10 ?? MISSING,
      arrivalP50: set.forecastLayers.arrival_p50 ?? MISSING,
      arrivalP90: set.forecastLayers.arrival_p90 ?? MISSING,
    }
    return checkLocation({
      point: sel,
      timeMs,
      nowMs,
      summary: st.summary,
      manifest: st.manifest,
      perimeters: st.perimeters?.perimeters ?? [],
      detections: st.detections?.detections ?? [],
      weather: st.weather,
      forecast: st.forecast,
      rasters,
      address,
    })
  }, [sel, timeMs, nowMs, st.summary, st.manifest, st.perimeters, st.detections, st.weather, st.forecast, set, address])
  const tf = useTimeFormat()
  const fireWeatherNote = officialFireWeatherNote(official.fireWeather, tf)
  const zoneSource = useZoneSource()
  // coverage at the point comes from the server's lookup only (a point searched far from the open fire)
  const lookup = useGeoLookup(sel.lon, sel.lat)
  const coverage = coverageText(lookup.status === 'ok' ? lookup.data : null)
  const card = useMemo(() => describeLocation(report, { units, preset, mode: st.mode, nowMs, fireWeatherNote, tf }), [report, units, preset, st.mode, nowMs, fireWeatherNote, tf])
  const fireName = st.summary ? (/\bfire$/i.test(st.summary.name) ? `the ${st.summary.name}` : st.summary.name) : null
  // official answers are for the replay time at a past time (a local message sent after it says so)
  const refMs = st.mode === 'live' ? nowMs : Math.floor(timeMs / 60_000) * 60_000
  const block = useMemo(() => officialBlock(official, { nowMs, units, fireName, incidentUrl: st.summary?.url ?? null, tf, refMs }), [official, nowMs, units, fireName, st.summary?.url, tf, refMs])
  return { card, block, coverage, loadingFire, fireName, zone: zoneLine(tf, timeMs, zoneSource), preset }
}

