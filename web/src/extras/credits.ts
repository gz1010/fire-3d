// Map attribution entries for the optional sources (owner: optional-sources). Plain text + an https link, rendered
// by MapAttribution as React text (CONTRACT §4.4: never HTML from a source). Credits appear only while a layer is
// shown with data, next to the basemap credits.
import { zoneSourceId } from './evacuation'
import { imageryAttribution } from './imagery'
import type { CamerasResponse, EvacuationsResponse, ImageryProduct, ImageryResponse } from './types'

export interface ExtrasCredit {
  id: string
  text: string
  href?: string
}

/** "Evacuation zones: local officials via Cal OES" (California) / "… via Oregon Department of Emergency Management"
 *  (Oregon, CONTRACT §14.13) while official zones from that source are listed (none for past dates / outages). */
export function evacuationCredits(data: EvacuationsResponse | null): ExtrasCredit[] {
  if (!data || data.status !== 'available' || data.zones.features.length === 0) return []
  const listed = new Set(data.zones.features.map((f) => zoneSourceId(f.properties)))
  const out: ExtrasCredit[] = []
  for (const id of ['caloes_evacuations', 'or_oem_evacuations']) {
    if (!listed.has(id)) continue
    const src = data.sources.find((s) => s.id === id)
    const credit = src?.credit ?? (id === 'caloes_evacuations' ? 'Cal OES' : 'Oregon Department of Emergency Management')
    out.push({ id: id === 'caloes_evacuations' ? 'extras-evacuations' : `extras-evacuations-${id}`, text: `Evacuation zones: local officials via ${credit}`, href: src?.url })
  }
  return out
}

/** Camera locations (Cal OES) and the networks shown; the image credit itself sits next to each image. */
export function cameraCredits(data: CamerasResponse | null): ExtrasCredit[] {
  if (!data || data.status !== 'available' || data.cameras.features.length === 0) return []
  const nets = [data.counts.wildfire ? 'ALERTCalifornia | UC San Diego' : null, data.counts.traffic ? 'Caltrans' : null].filter(Boolean)
  const src = data.sources.find((s) => s.id === 'caloes_webcams')
  return [{ id: 'extras-cameras', text: `Cameras: ${nets.join(', ')} via Cal OES California Webcams`, href: src?.url }]
}

/** Credits for the satellite image on the map (see `imageryAttribution`). */
export function imageryCredits(product: ImageryProduct | null, data: ImageryResponse | null): ExtrasCredit[] {
  return imageryAttribution(product, data?.sources ?? [])
}
