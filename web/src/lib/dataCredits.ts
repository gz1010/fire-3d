// Credits for the data an incident is built from (texts from README "Data sources, licenses and credits"). Built from
// the bundle's own `data_sources` (so only sources actually used are credited) plus the weather source of the
// selected forecast. Rendered as plain text with https links only (never HTML from a source).
import type { DataSource } from '../api/types'

export interface DataCredit {
  id: string
  text: string
  href?: string
}

/** Open-Meteo weather data are CC BY 4.0: a link must sit next to any place they are shown (open-meteo.com/en/licence). */
export const OPEN_METEO_CREDIT: DataCredit = { id: 'open-meteo', text: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' }

/** NASA's requested acknowledgement for FIRMS active-fire data. */
export const FIRMS_ACKNOWLEDGEMENT =
  "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS)."

/** Credits of the national reference data Fire-3d adds to what it shows (CONTRACT §14.13, SPEC data sources): the plain
 *  agency names after NIFC WFIGS agency codes ("USFS (USDA Forest Service)"), and the state, county and time zone of a
 *  point (/api/geo/lookup). Shown next to that data. */
export const NWCG_AGENCY_CREDIT = 'Agency names: NWCG unit identifiers'
export const GEO_LOOKUP_CREDIT = 'Boundaries: U.S. Census Bureau TIGERweb · Time zones: USDOT BTS NTAD'

/** The same credits as linked entries of an open fire's "Data sources" note (integration, review N1 of us-web): the
 *  fire's state and time zone come from TIGERweb and NTAD (backend `fire3d/regions.py`), its agency names from NWCG.
 *  Links are the sources named in the backend's data files (`fire3d/data/*` meta). */
export const TIGERWEB_CREDIT: DataCredit = { id: 'tigerweb', text: 'Boundaries: U.S. Census Bureau TIGERweb', href: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0' }
export const NTAD_CREDIT: DataCredit = { id: 'ntad', text: 'Time zones: USDOT BTS NTAD', href: 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Time_Zones/FeatureServer/0' }
export const NWCG_CREDIT: DataCredit = { id: 'nwcg', text: NWCG_AGENCY_CREDIT, href: 'https://www.nwcg.gov/publications/pms931' }

/** True for weather sources fetched from Open-Meteo ("open-meteo:gfs_hrrr", "open-meteo:historical-forecast:..."). */
export function isOpenMeteo(source: string | null | undefined): boolean {
  return typeof source === 'string' && /^open-meteo\b/i.test(source.trim())
}

/** The Open-Meteo credit when the weather or the selected forecast's weather came from Open-Meteo. */
export function weatherCredits(...sources: (string | null | undefined)[]): DataCredit[] {
  return sources.some(isOpenMeteo) ? [OPEN_METEO_CREDIT] : []
}

/** Year of the Sentinel-2 scenes named in a source detail ("S2A_11SLT_20250102_0_L2A"), else the fallback. */
function sentinelYear(detail: string, fallback: number | null): number | null {
  const m = /_(\d{4})\d{4}_\d+_L2A/.exec(detail)
  return m ? Number(m[1]) : fallback
}

/**
 * Credits for a bundle's data sources, in a fixed order; synthetic development fixtures and sources that found
 * nothing (e.g. no agency perimeter) get none. `year` is the incident's year (Copernicus notice fallback). `place`
 * (an open fire): its state and time zone come from Census TIGERweb and USDOT BTS NTAD, and `agencyNames` says that a
 * plain NWCG agency name is shown after an agency code (`recordText.agencyNameShown`).
 */
export function bundleCredits(
  sources: readonly Pick<DataSource, 'name' | 'detail'>[],
  opts: {
    year?: number | null
    forecastWeatherSource?: string | null
    forecastModel?: { engine: string; version?: string | null } | null
    place?: { agencyNames: boolean } | null
  } = {},
): DataCredit[] {
  const out = new Map<string, DataCredit>()
  const add = (c: DataCredit) => {
    if (!out.has(c.id)) out.set(c.id, c)
  }
  for (const s of sources) {
    const name = s.name ?? ''
    const detail = s.detail ?? ''
    if (/synthetic/i.test(name) || /^fixture:/i.test(detail)) continue
    if (/^CAL FIRE/i.test(name)) add({ id: 'calfire', text: 'CAL FIRE', href: 'https://www.fire.ca.gov/incidents' })
    // brief 3 (§14.12.6): a fire whose record is NIFC WFIGS's (outside California, or a CAL FIRE gap)
    else if (/NIFC WFIGS incident record/i.test(name)) add({ id: 'wfigs-record', text: 'NIFC WFIGS (IRWIN)', href: 'https://data-nifc.opendata.arcgis.com/' })
    else if (/FIRMS/i.test(name)) add({ id: 'firms', text: 'NASA FIRMS (LANCE, ESDIS)', href: 'https://www.earthdata.nasa.gov/data/tools/firms' })
    else if (/WFIGS|NIFC/i.test(name)) {
      if (!/^no perimeter/i.test(detail)) add({ id: 'wfigs', text: 'Wildland Fire Interagency Geospatial Services (WFIGS) Group, NIFC', href: 'https://data-nifc.opendata.arcgis.com/' })
    } else if (/3DEP/i.test(name)) add({ id: '3dep', text: 'U.S. Geological Survey (3DEP elevation)', href: 'https://www.usgs.gov/3d-elevation-program' })
    else if (/LANDFIRE/i.test(name)) add({ id: 'landfire', text: `${name.trim()} (fuels and canopy)`, href: 'https://landfire.gov/' })
    else if (/NAIP/i.test(name)) add({ id: 'naip', text: 'USGS, USDA, The National Map: Orthoimagery (NAIP)', href: 'https://naip-usdaonline.hub.arcgis.com/' })
    else if (/Sentinel-2/i.test(name)) {
      const y = sentinelYear(detail, opts.year ?? null)
      add({ id: 'sentinel2', text: `Contains modified Copernicus Sentinel data${y ? ` ${y}` : ''} (burn severity)`, href: 'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice' })
    } else if (/\bCMR\b/.test(name)) add({ id: 'cmr', text: 'NASA Earthdata CMR (satellite pass times)', href: 'https://cmr.earthdata.nasa.gov/search/' })
    else if (/weather/i.test(name) && isOpenMeteo(detail)) add(OPEN_METEO_CREDIT)
  }
  if (isOpenMeteo(opts.forecastWeatherSource)) add(OPEN_METEO_CREDIT)
  // the fire-spread engine of the shown forecast (README "Software"); synthetic fixtures (no real credit) get none
  const model = opts.forecastModel
  if (out.size > 0 && model && /^pyretechnics$/i.test(model.engine))
    add({ id: 'pyretechnics', text: `Fire-spread model: pyretechnics${model.version ? ` ${model.version}` : ''} (Spatial Informatics Group, Eclipse Public License 2.0)`, href: 'https://pypi.org/project/pyretechnics/' })
  // the open fire's state, time zone and agency names (brief 3, §14.13); never for synthetic fixtures (out is empty)
  if (out.size > 0 && opts.place) {
    add(TIGERWEB_CREDIT)
    add(NTAD_CREDIT)
    if (opts.place.agencyNames) add(NWCG_CREDIT)
  }
  return [...out.values()]
}

/** A credit link is shown only for https URLs. */
export function safeHref(href: string | undefined): string | undefined {
  return href && /^https:\/\//.test(href) ? href : undefined
}
