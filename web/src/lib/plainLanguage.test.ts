import { describe, expect, it } from 'vitest'
import type { ForecastManifest } from '../api/types'
import {
  EXPLAIN,
  LATTICE_NAMES,
  area,
  burnProbabilityText,
  cardinalWord,
  directionWord,
  distance,
  elevation,
  ensemblePhrase,
  fireWeatherSeverity,
  forecastDescription,
  forecastLead,
  forecastPeriod,
  growthRate,
  keepUnits,
  latticeName,
  modeledArea,
  sourceName,
  spreadSpeed,
  temperature,
  weatherSourceName,
  windFrom,
  windSpeed,
  windSummary,
} from './plainLanguage'

const H = 3_600_000
// 2025-01-08 08:18 UTC = Jan 8, 00:18 PST (the Eaton hindcast start)
const EATON = { start_ms: 1736324280000, horizon_h: 72 }

describe('spread speed (chains per hour -> everyday units)', () => {
  it('converts chains/hour to mph (80 ch/h = 1 mph) and km/h, keeping the scientific value', () => {
    expect(spreadSpeed(80, 'us')).toMatchObject({ text: '1.0 mph', unit: 'mph' })
    expect(spreadSpeed(80, 'us').value).toBeCloseTo(1, 9)
    const fast = spreadSpeed(206, 'us')
    expect(fast.text).toBe('2.6 mph')
    expect(fast.scientific).toBe('Rate of spread (ROS) 206 ch/h')
    const metric = spreadSpeed(206, 'metric')
    expect(metric.unit).toBe('km/h')
    expect(metric.value).toBeCloseTo((206 * 20.1168) / 1000, 9)
    expect(metric.text).toBe('4.1 km/h')
  })

  it('keeps small speeds readable and never invents a value', () => {
    expect(spreadSpeed(5, 'us').text).toBe('0.06 mph')
    expect(spreadSpeed(5, 'us').scientific).toBe('Rate of spread (ROS) 5.0 ch/h')
    expect(spreadSpeed(0.2, 'us').text).toBe('< 0.01 mph')
    expect(spreadSpeed(0, 'us').text).toBe('0 mph')
    for (const v of [null, undefined, Number.NaN, -3]) expect(spreadSpeed(v, 'us')).toEqual({ text: '—', value: null, unit: 'mph', scientific: null })
  })

  it('reports growth per hour in acres or hectares', () => {
    expect(growthRate(2741, 'us')).toMatchObject({ text: '2,741 acres per hour', scientific: '+2,741 ac/h' })
    expect(growthRate(2741, 'metric').text).toBe('1,109 ha per hour')
  })
})

describe('wind (meteorological FROM convention)', () => {
  it('formats speed and direction', () => {
    expect(windSpeed(10, 'us')).toMatchObject({ text: '22 mph', scientific: '10.0 m/s' })
    expect(windSpeed(10, 'metric').text).toBe('36 km/h')
    expect(windFrom(25)).toBe('from NNE')
    expect(windFrom(202)).toBe('from SSW')
    expect(windFrom(null)).toBe('')
  })

  it('summarises speed, FROM direction and gusts', () => {
    const w = windSummary(7.6, 202, 11.6, 'us')
    expect(w.text).toBe('17 mph from SSW, gusts 26 mph')
    expect(w.scientific).toBe('7.6 m/s from 202°, gusts 11.6 m/s')
    expect(windSummary(7.6, null, null, 'us').text).toBe('17 mph')
    expect(windSummary(null, 90, 5, 'us').text).toBe('—')
  })
})

describe('fire weather severity (FFWI)', () => {
  it('shows the index value with its explanation and no invented category', () => {
    const v = fireWeatherSeverity(42.3)
    expect(v.text).toBe('42 of 100')
    expect(v.scientific).toBe('Fosberg Fire Weather Index (FFWI) 42.3')
    expect(v.explanation).toContain('Fosberg')
    expect(v.explanation).toMatch(/does not sort it into categories/)
    expect(v.text).not.toMatch(/low|moderate|high|extreme|critical/i)
  })

  it('handles values above the 0-100 scale and missing values', () => {
    expect(fireWeatherSeverity(130.7).text).toBe('100+ of 100')
    expect(fireWeatherSeverity(130.7).scientific).toContain('130.7')
    expect(fireWeatherSeverity(null).text).toBe('—')
  })
})

describe('everyday units', () => {
  it('converts temperature, distance, area and elevation', () => {
    expect(temperature(20, 'us').text).toBe('68°F')
    expect(temperature(20, 'metric').text).toBe('20°C')
    expect(distance(100, 'us').text).toBe('328 ft')
    expect(distance(1609.344 * 4.2, 'us').text).toBe('4.2 mi')
    expect(distance(500, 'metric').text).toBe('500 m')
    expect(distance(12345, 'metric').text).toBe('12 km')
    expect(area(13681, 'us').text).toBe('13,681 acres')
    expect(area(13681, 'metric').text).toBe('5,537 ha')
    expect(elevation(956, 'us').text).toBe('3,136 ft')
    expect(elevation(956, 'metric').text).toBe('956 m')
  })

  it('names directions', () => {
    expect(directionWord(44)).toBe('northeast')
    expect(directionWord(-90)).toBe('west')
    expect(cardinalWord('ESE')).toBe('east-southeast')
    expect(cardinalWord('XYZ')).toBe('XYZ')
  })
})

describe('forecast wording (period, probability, uncertainty)', () => {
  it('states the real period, with both time zones across a DST change', () => {
    expect(forecastPeriod(EATON)).toBe('Jan 8, 00:18 – Jan 11, 00:18 PST (72 h)')
    // 2026-03-07 20:00 UTC = 12:00 PST; DST starts Mar 8
    expect(forecastPeriod({ start_ms: Date.UTC(2026, 2, 7, 20), horizon_h: 72 })).toBe('Mar 7, 12:00 PST – Mar 10, 13:00 PDT (72 h)')
  })

  it('labels burn probability with the whole horizon, never "next 24 h"', () => {
    const t = burnProbabilityText(0.12, EATON, 31)
    expect(t).toBe('12% of model runs (4 of 31) burned this spot by Jan 11, 00:18 PST (72 h after Jan 8, 00:18 PST)')
    expect(t).not.toMatch(/next 24|24 h/)
    expect(burnProbabilityText(0, EATON, 31)).toBe('None of the 31 model runs burned this spot by Jan 11, 00:18 PST (72 h after Jan 8, 00:18 PST)')
    expect(burnProbabilityText(0.001, EATON)).toMatch(/^Under 1% of model runs burned/)
    expect(burnProbabilityText(1, EATON, 31)).toMatch(/^100% of model runs \(31 of 31\)/)
  })

  it('gives the lead time only inside the period', () => {
    expect(forecastLead(EATON, EATON.start_ms + 22 * H)).toBe('+22 h')
    expect(forecastLead(EATON, EATON.start_ms - 1)).toBeNull()
    expect(forecastLead(EATON, EATON.start_ms + 73 * H)).toBeNull()
  })

  it('describes hindcasts and live forecasts honestly', () => {
    const f = { ...EATON, issued_ms: Date.UTC(2026, 9, 17, 19, 7), weather: { source: 'open-meteo:historical-forecast:gfs_hrrr', ensemble: 'perturbed' as const, members: 31 } }
    const hind = forecastDescription(f, 'historical')
    expect(hind.title).toBe('Hindcast (72\u00a0h)') // no-break space: the unit never wraps away
    // Public (plain words, brief 2 C-R8): never "hindcast"
    expect(forecastDescription(f, 'historical', { plain: true }).title).toBe('Model re-run on past weather (72\u00a0h)')
    expect(forecastDescription(f, 'live', { plain: true }).title).toBe('Spread forecast (72\u00a0h)')
    expect(hind.period).toBe('Jan 8, 00:18 – Jan 11, 00:18 PST (72\u00a0h)')
    expect(keepUnits('in 3 h, 40 min or 2 days; 72 hours')).toBe('in 3\u00a0h, 40\u00a0min or 2\u00a0days; 72 hours')
    expect(hind.issued).toMatch(/^Model re-run Oct 17, 2026 12:07 PDT, after the fire/)
    expect(hind.runs).toBe('31 model runs with small random changes to wind, humidity and temperature')
    expect(hind.probability).toContain('shares of the 31 model runs')
    expect(hind.probability).toContain('at least 10%, 50% or 90% of the runs')
    expect(hind.probability).toContain('Jan 11, 00:18 PST')
    expect(hind.uncertainty).toMatch(/not best-case or worst-case/)
    expect(hind.weather).toBe('Archived NOAA HRRR weather-model forecasts (via Open-Meteo)')
    const live = forecastDescription({ ...f, weather: { source: 'open-meteo:gfs025', ensemble: 'gfs025', members: 31 } }, 'live')
    expect(live.title).toBe('Spread forecast (72\u00a0h)')
    expect(live.issued).toBe('Issued Oct 17, 12:07 PDT')
    expect(live.runs).toMatch(/GFS weather ensemble/)
    expect(live.caveat).toBe(EXPLAIN.experimental)
    expect(ensemblePhrase('none', 1)).toMatch(/^One model run/)
  })

  it('reads the modeled area quantiles from the hourly series', () => {
    const t0 = EATON.start_ms
    const f = {
      series: {
        t_ms: [t0, t0 + H, t0 + 2 * H],
        area_acres_p10: [100, 1200, 2000],
        area_acres_p50: [100, 1500, 2600],
        area_acres_p90: [100, 1900, 3100],
        ros_ch_per_h_p50: [0, 10, 12],
      },
    } as Pick<ForecastManifest, 'series'>
    const a = modeledArea(f, t0 + 1.5 * H, 'us')
    expect(a?.tMs).toBe(t0 + H)
    expect(a?.text).toBe('About 1,500 acres (middle run); 80% of runs between 1,200 acres and 1,900 acres')
    // all runs equal (e.g. at the forecast start): no degenerate "between X and X" range
    const same = { series: { ...f.series, area_acres_p10: f.series.area_acres_p50, area_acres_p90: f.series.area_acres_p50 } }
    expect(modeledArea(same, t0 + 1.5 * H, 'us')?.text).toBe('About 1,500 acres (middle run); the runs agree at this time')
    expect(modeledArea(f, t0 - 1, 'us')).toBeNull()
    expect(modeledArea({ series: { ...f.series, t_ms: [] } }, t0, 'us')).toBeNull()
  })
})

describe('names and sources', () => {
  it('uses everyday lattice names and keeps the scientific name', () => {
    expect(latticeName('activity')).toBe('Activity lattice')
    expect(latticeName('slope')).toBe('Slope lattice')
    expect(LATTICE_NAMES.activity.scientific).toMatch(/Golden lattice/)
  })

  it('translates weather and data source labels', () => {
    expect(weatherSourceName('open-meteo:gfs_hrrr+gfs_seamless')).toBe('NOAA HRRR + NOAA GFS weather model (via Open-Meteo)')
    expect(weatherSourceName('fixture:synthetic (shaped like open-meteo:historical-forecast:gfs_hrrr)')).toBe('Weather model (NOAA HRRR, simulated fixture data)')
    expect(sourceName('FIRMS VIIRS NOAA-21')).toBe('NASA FIRMS (VIIRS, NOAA-21)')
    expect(sourceName('FIRMS VIIRS (fixture)')).toBe('NASA FIRMS (VIIRS) (fixture)')
    expect(sourceName('open-meteo:historical-forecast:gfs_hrrr (10 m gust at the fire)')).toBe('Archived NOAA HRRR weather-model forecasts (via Open-Meteo)')
    expect(sourceName('Observed arrival (FIRMS VIIRS/MODIS + WFIGS)')).toBe('Fire-3d reconstruction (satellite detections and mapped perimeters)')
    expect(sourceName('USGS 3DEP terrain + observed arrival')).toBe('Fire-3d analysis (USGS 3DEP terrain + reconstructed spread)')
    expect(sourceName('CAL FIRE + FIRMS GOES')).toBe('CAL FIRE report + NASA FIRMS (GOES)')
    expect(sourceName('CAL FIRE (100% contained)')).toBe('CAL FIRE')
    expect(sourceName('NIFC WFIGS')).toBe('NIFC WFIGS')
    expect(sourceName('Something new')).toBe('Something new')
  })
})
