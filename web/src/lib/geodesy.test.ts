import { describe, expect, it } from 'vitest'
import { bearingDeg, compass16, distanceM, formatDecimalPair, formatDms, formatLat, formatLatLon, formatLon, geodesicInverse, parseLatLon, parseLatLonDetailed } from './geodesy'

const close = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)

describe('parseLatLon: accepted formats', () => {
  const cases: [string, number, number][] = [
    ['34.2048, -118.1027', 34.2048, -118.1027],
    ['34.2048,-118.1027', 34.2048, -118.1027],
    ['34.2048 -118.1027', 34.2048, -118.1027],
    ['34.2048; -118.1027', 34.2048, -118.1027],
    ['+34.2048, -118.1027', 34.2048, -118.1027],
    ['34.2048 N 118.1027 W', 34.2048, -118.1027],
    ['34.2048N, 118.1027W', 34.2048, -118.1027],
    ['34.2048N118.1027W', 34.2048, -118.1027],
    ['N34.2048 W118.1027', 34.2048, -118.1027],
    ['N 34.2048, W 118.1027', 34.2048, -118.1027],
    ['34.2048° N, 118.1027° W', 34.2048, -118.1027],
    ['34.2048°, -118.1027°', 34.2048, -118.1027],
    ['34.2048° -118.1027°', 34.2048, -118.1027],
    ['34.2048 north 118.1027 west', 34.2048, -118.1027],
    ['lat 34.2048 lon -118.1027', 34.2048, -118.1027],
    ['Lat: 34.2048, Lng: -118.1027', 34.2048, -118.1027],
    ['latitude=34.2048; longitude=-118.1027', 34.2048, -118.1027],
    ['lon -118.1027 lat 34.2048', 34.2048, -118.1027],
    ['(34.2048, -118.1027)', 34.2048, -118.1027],
    ['−118.1027, 34.2048', 34.2048, -118.1027], // Unicode minus; longitude first because 118 > 90
    ['[-118.1027, 34.2048]', 34.2048, -118.1027], // GeoJSON order
    ['118.1027 W, 34.2048 N', 34.2048, -118.1027], // letters fix the order
    ['S33.8688 E151.2093', -33.8688, 151.2093],
    ['-33.8688, 151.2093', -33.8688, 151.2093],
    ['34 N 118 W', 34, -118],
  ]
  it.each(cases)('%s', (text, lat, lon) => {
    const p = parseLatLon(text)
    expect(p).not.toBeNull()
    close(p!.lat, lat, 1e-9)
    close(p!.lon, lon, 1e-9)
  })

  const dms: [string, number, number][] = [
    [`34°12'17.3"N 118°06'09.7"W`, 34 + 12 / 60 + 17.3 / 3600, -(118 + 6 / 60 + 9.7 / 3600)],
    ['34°12′17.3″N, 118°06′09.7″W', 34 + 12 / 60 + 17.3 / 3600, -(118 + 6 / 60 + 9.7 / 3600)], // primes
    ['34º 12’ 17.3” N 118º 6’ 9.7” W', 34 + 12 / 60 + 17.3 / 3600, -(118 + 6 / 60 + 9.7 / 3600)], // ordinal / quotes
    [`34°12'17"N 118°6'10"W`, 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    [`34°12'17" -118°6'10"`, 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    ['34:12:17N 118:06:10W', 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    ['34 12 17 N 118 6 10 W', 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    ['34 12 17, -118 6 10', 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    ['34 12 17 -118 6 10', 34 + 12 / 60 + 17 / 3600, -(118 + 6 / 60 + 10 / 3600)],
    ['34 12.29 N, 118 6.16 W', 34 + 12.29 / 60, -(118 + 6.16 / 60)],
    [`N 34° 12.29' W 118° 6.16'`, 34 + 12.29 / 60, -(118 + 6.16 / 60)],
    ['34 12.29 -118 6.16', 34 + 12.29 / 60, -(118 + 6.16 / 60)],
  ]
  it.each(dms)('DMS %s', (text, lat, lon) => {
    const p = parseLatLonDetailed(text)
    expect(p).not.toBeNull()
    close(p!.lat, lat, 1e-9)
    close(p!.lon, lon, 1e-9)
    expect(p!.notation).not.toBe('decimal')
  })

  const links: [string, number, number][] = [
    ['https://www.google.com/maps/@34.2048,-118.1027,15z', 34.2048, -118.1027],
    ['https://www.google.com/maps/place/Altadena/@34.1897,-118.1312,14z/data=!3m1', 34.1897, -118.1312],
    ['https://maps.google.com/?q=34.2048,-118.1027', 34.2048, -118.1027],
    ['https://maps.apple.com/?ll=34.2048,-118.1027&q=Pin', 34.2048, -118.1027],
    ['https://www.openstreetmap.org/#map=15/34.2048/-118.1027', 34.2048, -118.1027],
    ['geo:34.2048,-118.1027', 34.2048, -118.1027],
  ]
  it.each(links)('link %s', (text, lat, lon) => {
    const p = parseLatLonDetailed(text)
    expect(p?.fromLink).toBe(true)
    close(p!.lat, lat, 1e-9)
    close(p!.lon, lon, 1e-9)
  })

  it('reports how the text was read', () => {
    expect(parseLatLonDetailed('34.2, -118.1')).toMatchObject({ order: 'lat-lon', notation: 'decimal', fromLink: false })
    expect(parseLatLonDetailed('-118.1, 34.2')).toMatchObject({ order: 'lon-lat' })
    expect(parseLatLonDetailed('118.1 W 34.2 N')).toMatchObject({ order: 'lon-lat' })
    expect(parseLatLonDetailed('34 12 17 N 118 6 10 W')).toMatchObject({ notation: 'dms' })
    expect(parseLatLonDetailed('34 12.3 N 118 6.1 W')).toMatchObject({ notation: 'dm' })
    // both values fit a latitude: latitude first (never guessed from the place)
    expect(parseLatLon('34.2, 80.1')).toEqual({ lat: 34.2, lon: 80.1 })
  })
})

describe('parseLatLon: rejected text', () => {
  it.each([
    '',
    '   ',
    'Eaton',
    'Eaton Fire 2025',
    '600 E Mariposa St, Altadena, CA 91001',
    '100 W 200 N', // street-grid address: 200 is not a latitude
    '100 W 200 N, Provo, UT',
    '91001',
    '34.2',
    '34.2, -118.1, 15',
    '95.2, -118.1', // both out of latitude range
    '34.2, -190.1',
    '34.2 N 50.1 N', // two latitudes
    '34.2 E 118.1 W', // two longitudes
    '-34.2 N, 118.1 W', // sign contradicts the hemisphere
    `34°75'00"N 118°0'0"W`, // minutes >= 60
    `34°12'75"N 118°0'0"W`, // seconds >= 60
    '34.5 12 N 118 6 W', // decimal degrees with minutes
    '34,2048', // European decimal comma is not a pair
    'https://maps.app.goo.gl/abc',
    'x'.repeat(250),
  ])('%s', (text) => {
    expect(parseLatLon(text)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats WGS84 decimal degrees with hemispheres and a signed copy form', () => {
    expect(formatLatLon(34.20480, -118.10270)).toBe('34.2048° N, 118.1027° W')
    expect(formatLat(-33.86882)).toBe('33.86882° S')
    expect(formatLon(151.20929)).toBe('151.20929° E')
    expect(formatDecimalPair(34.2048, -118.1027)).toBe('34.20480, -118.10270')
    expect(formatDecimalPair(-0.000001, 0.000001)).toBe('0.00000, 0.00000')
    // the copy form parses back to the same point
    expect(parseLatLon(formatDecimalPair(34.2048, -118.1027))).toEqual({ lat: 34.2048, lon: -118.1027 })
  })
  it('formats degrees-minutes-seconds with carries', () => {
    expect(formatDms(34.2048, -118.1027)).toBe('34°12′17.3″ N, 118°06′09.7″ W')
    expect(formatDms(34.9999999, -118.0)).toBe('35°00′00.0″ N, 118°00′00.0″ W')
    const p = parseLatLon(formatDms(34.2048, -118.1027))!
    close(p.lat, 34.2048, 0.05 / 3600)
    close(p.lon, -118.1027, 0.05 / 3600)
  })
})

describe('geodesic distance and bearing (WGS84, Vincenty)', () => {
  it("matches Vincenty's published example (Flinders Peak -> Buninyong)", () => {
    const dmsToDeg = (d: number, m: number, s: number) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600)
    const a = { lat: dmsToDeg(-37, 57, 3.7203), lon: dmsToDeg(144, 25, 29.5244) }
    const b = { lat: dmsToDeg(-37, 39, 10.1561), lon: dmsToDeg(143, 55, 35.3839) }
    const r = geodesicInverse(a, b)
    expect(r.method).toBe('vincenty')
    close(r.distanceM, 54972.271, 0.001)
    close(r.initialBearingDeg, dmsToDeg(306, 52, 5.37), 0.5 / 3600)
    close(r.finalBearingDeg, dmsToDeg(127, 10, 25.07) + 180, 0.5 / 3600) // reverse azimuth + 180
  })
  it('gives exact equator and meridian lengths', () => {
    close(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111319.4908, 0.001)
    close(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 110574.3886, 0.01)
    expect(distanceM({ lat: 34.2, lon: -118.1 }, { lat: 34.2, lon: -118.1 })).toBe(0)
  })
  it('measures bearings clockwise from true north', () => {
    const p = { lat: 34.2, lon: -118.1 }
    close(bearingDeg(p, { lat: 34.3, lon: -118.1 }), 0, 1e-9)
    close(bearingDeg(p, { lat: 34.1, lon: -118.1 }), 180, 1e-9)
    close(bearingDeg(p, { lat: 34.2, lon: -118.0 }), 90, 0.05) // the parallel curves: ~90° at the start
    close(bearingDeg(p, { lat: 34.2, lon: -118.2 }), 270, 0.05)
    const ne = bearingDeg(p, { lat: 34.21, lon: -118.09 })
    expect(ne).toBeGreaterThan(35)
    expect(ne).toBeLessThan(45)
  })
  it('crosses the antimeridian and survives nearly antipodal points', () => {
    close(distanceM({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }), 111319.4908, 0.001)
    close(bearingDeg({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }), 90, 1e-6)
    const r = geodesicInverse({ lat: 0, lon: 0 }, { lat: 0.5, lon: 179.5 })
    expect(Number.isFinite(r.distanceM)).toBe(true)
    close(r.distanceM, 19_936_000, 60_000)
  })
  it('agrees with a spherical estimate to ~0.5 % at fire scales', () => {
    const a = { lat: 34.2, lon: -118.1 }
    const b = { lat: 34.25, lon: -118.0 }
    const sphere = 2 * 6371008.8 * Math.asin(Math.sqrt(Math.sin(((b.lat - a.lat) * Math.PI) / 360) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(((b.lon - a.lon) * Math.PI) / 360) ** 2))
    expect(Math.abs(distanceM(a, b) / sphere - 1)).toBeLessThan(0.005)
  })
  it('names 16 compass points', () => {
    expect([0, 22.5, 45, 90, 180, 202.5, 270, 337.5, 359, -45].map(compass16)).toEqual(['N', 'NNE', 'NE', 'E', 'S', 'SSW', 'W', 'NNW', 'N', 'NW'])
  })
})
