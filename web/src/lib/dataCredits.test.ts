import { describe, expect, it } from 'vitest'
import { bundleCredits, FIRMS_ACKNOWLEDGEMENT, isOpenMeteo, OPEN_METEO_CREDIT, safeHref, weatherCredits } from './dataCredits'

// data_sources as written by the backend (2025 Eaton, 2026 Cooley live, fixture-demo), details shortened
const EATON = [
  { name: 'CAL FIRE incidents', detail: 'incidents.fire.ca.gov IncidentApi/List (incident point, acres, dates)' },
  { name: 'USGS 3DEP DEM', detail: '3DEPElevation exportImage, 1024² at 22.46 m (bilinear), EPSG:32611' },
  { name: 'LANDFIRE LF2024', detail: 'FBFM40, CC, CH, CBH, CBD, EVT, EVC exportImage, 512² at 44.92 m (nearest)' },
  { name: 'NAIP imagery', detail: 'USGSNAIPImagery exportImage: 4000² JPEG (5.8 m/px, 4 parallel quadrants)' },
  { name: 'Sentinel-2 L2A (Earth Search)', detail: 'dNBR: pre S2A_11SLT_20250102_0_L2A (3.0% cloud), S2A_11SMT_20250102_0_L2A (3.2% cloud)' },
  { name: 'NASA FIRMS active fire detections', detail: 'area_api; 2025-01-07 -> 2025-02-01; 3,408 detections in the AOI' },
  { name: 'NIFC WFIGS fire perimeters', detail: '3 perimeter(s) 2025-01-09 -> 2025-01-31, final 14,111 ac (1 used for timing)' },
  { name: 'Weather', detail: 'open-meteo:historical-forecast:gfs_hrrr; 4x4 points, 212 h' },
]
const COOLEY = [
  { name: 'CAL FIRE incidents', detail: 'incidents.fire.ca.gov IncidentApi/List' },
  { name: 'USGS 3DEP DEM', detail: '3DEPElevation exportImage' },
  { name: 'LANDFIRE LF2025', detail: 'FBFM40 ...' },
  { name: 'NASA FIRMS active fire detections', detail: 'area_api; 189 detections' },
  { name: 'NIFC WFIGS fire perimeters', detail: 'no perimeter found for this incident; burned area from satellite detections' },
  { name: 'Weather', detail: 'open-meteo:gfs_hrrr+gfs_seamless; 4x4 points, 190 h' },
]
const FIXTURE = [
  { name: 'Terrain (synthetic)', detail: 'Ridged-fBm DEM with a carved river valley' },
  { name: 'Fire observations (synthetic)', detail: 'VIIRS/MODIS/GOES/Landsat detections sampled from a synthetic spread' },
  { name: 'Weather (synthetic)', detail: 'fixture:synthetic (shaped like open-meteo:historical-forecast:gfs_hrrr)' },
]

describe('isOpenMeteo / weatherCredits', () => {
  it('recognises Open-Meteo weather sources only', () => {
    expect(isOpenMeteo('open-meteo:gfs_hrrr')).toBe(true)
    expect(isOpenMeteo('open-meteo:historical-forecast:gfs_hrrr')).toBe(true)
    expect(isOpenMeteo('fixture:synthetic (shaped like open-meteo:...)')).toBe(false)
    expect(isOpenMeteo(null)).toBe(false)
    expect(weatherCredits(null, 'open-meteo:ecmwf_ifs025')).toEqual([OPEN_METEO_CREDIT])
    expect(weatherCredits('fixture:synthetic', undefined)).toEqual([])
  })

  it('links the Open-Meteo credit over https with the required wording', () => {
    expect(OPEN_METEO_CREDIT).toEqual({ id: 'open-meteo', text: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' })
  })
})

describe('bundleCredits', () => {
  it('credits every source a real bundle used, in a fixed order', () => {
    const c = bundleCredits(EATON, { year: 2025 })
    expect(c.map((x) => x.id)).toEqual(['calfire', '3dep', 'landfire', 'naip', 'sentinel2', 'firms', 'wfigs', 'open-meteo'])
    expect(c.find((x) => x.id === 'landfire')?.text).toBe('LANDFIRE LF2024 (fuels and canopy)')
    // the Copernicus notice names the year of the scenes used
    expect(c.find((x) => x.id === 'sentinel2')?.text).toBe('Contains modified Copernicus Sentinel data 2025 (burn severity)')
    expect(c.every((x) => safeHref(x.href) === x.href)).toBe(true)
  })

  it('skips sources that found nothing and adds the forecast weather source', () => {
    const c = bundleCredits(COOLEY.filter((s) => s.name !== 'Weather'), { forecastWeatherSource: 'open-meteo:ecmwf_ifs025' })
    expect(c.map((x) => x.id)).toEqual(['calfire', '3dep', 'landfire', 'firms', 'open-meteo'])
    expect(c.some((x) => x.id === 'wfigs')).toBe(false)
  })

  it('gives synthetic development fixtures no outside credits', () => {
    expect(bundleCredits(FIXTURE, { year: 2026, forecastWeatherSource: 'fixture:synthetic' })).toEqual([])
    expect(bundleCredits(FIXTURE, { forecastModel: { engine: 'pyretechnics', version: '2026.8.10' } })).toEqual([])
  })

  it('credits NASA CMR pass times of a live bundle and the fire-spread engine of the shown forecast', () => {
    const live = [...COOLEY, { name: 'NASA CMR satellite passes', detail: '13 confirmed passes after the last detection' }]
    const c = bundleCredits(live, { forecastModel: { engine: 'pyretechnics', version: '2026.8.10' } })
    expect(c.map((x) => x.id)).toEqual(['calfire', '3dep', 'landfire', 'firms', 'open-meteo', 'cmr', 'pyretechnics'])
    expect(c.find((x) => x.id === 'pyretechnics')?.text).toBe('Fire-spread model: pyretechnics 2026.8.10 (Spatial Informatics Group, Eclipse Public License 2.0)')
    expect(c.every((x) => safeHref(x.href) === x.href)).toBe(true)
  })

  it('credits "NIFC WFIGS (IRWIN)" for a WFIGS fire record and never CAL FIRE (brief 3, §14.12.6)', () => {
    const c = bundleCredits([
      { name: 'NIFC WFIGS incident record (IRWIN)', detail: 'IrwinID {889237AB-...}' },
      { name: 'NIFC WFIGS fire perimeters', detail: '3 perimeters' },
      { name: 'LANDFIRE LF2023', detail: 'FBFM40' },
    ])
    expect(c.map((x) => x.id)).toEqual(['wfigs-record', 'wfigs', 'landfire'])
    expect(c[0].text).toBe('NIFC WFIGS (IRWIN)')
    expect(c.some((x) => /CAL FIRE/.test(x.text))).toBe(false)
    // California keeps its CAL FIRE credit
    expect(bundleCredits([{ name: 'CAL FIRE incidents', detail: '' }])[0]).toMatchObject({ id: 'calfire', text: 'CAL FIRE' })
  })

  it("credits TIGERweb and NTAD for an open fire, and NWCG when a plain agency name is shown (integration, §14.13)", () => {
    const wfigs = [
      { name: 'NIFC WFIGS incident record (IRWIN)', detail: 'IrwinID {889237AB-...}' },
      { name: 'LANDFIRE LF2023', detail: 'FBFM40' },
    ]
    const c = bundleCredits(wfigs, { place: { agencyNames: true } })
    expect(c.map((x) => x.id)).toEqual(['wfigs-record', 'landfire', 'tigerweb', 'ntad', 'nwcg'])
    expect(c.slice(2).map((x) => x.text)).toEqual(['Boundaries: U.S. Census Bureau TIGERweb', 'Time zones: USDOT BTS NTAD', 'Agency names: NWCG unit identifiers'])
    expect(c.every((x) => safeHref(x.href) === x.href)).toBe(true)
    // CAL FIRE's record shows no NWCG name; no place given (an older caller): neither credit
    expect(bundleCredits([{ name: 'CAL FIRE incidents', detail: '' }], { place: { agencyNames: false } }).map((x) => x.id)).toEqual(['calfire', 'tigerweb', 'ntad'])
    expect(bundleCredits(wfigs).map((x) => x.id)).toEqual(['wfigs-record', 'landfire'])
    // a synthetic fixture: no outside credits at all
    expect(bundleCredits(FIXTURE, { place: { agencyNames: true } })).toEqual([])
  })

  it('keeps NASA FIRMS acknowledgement text verbatim', () => {
    expect(FIRMS_ACKNOWLEDGEMENT).toMatch(/^We acknowledge the use of data and\/or imagery from NASA's Fire Information for Resource Management System \(FIRMS\)/)
    expect(FIRMS_ACKNOWLEDGEMENT).toMatch(/\(LANCE\) and NASA's Earth Science Data and Information System \(ESDIS\)\.$/)
  })
})

describe('safeHref', () => {
  it('allows https links only', () => {
    expect(safeHref('https://open-meteo.com/')).toBe('https://open-meteo.com/')
    expect(safeHref('http://example.com/')).toBeUndefined()
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
  })
})
