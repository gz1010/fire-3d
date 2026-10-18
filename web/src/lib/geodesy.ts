// WGS84 point helpers for location selection (owner: location; CONTRACT §5): parsing pasted coordinates (decimal
// with signs or N/S/E/W, comma / space / semicolon separated, degrees-minutes(-seconds), map links), formatting,
// ellipsoidal geodesic distance and bearing (Vincenty on WGS84) and compass words. Three.js-free and pure.
export interface LatLon {
  lat: number
  lon: number
}

export type CoordinateNotation = 'decimal' | 'dm' | 'dms'

export interface ParsedLatLon extends LatLon {
  /** 'lon-lat' when hemisphere letters, labels or a first value beyond ±90° show longitude came first. */
  order: 'lat-lon' | 'lon-lat'
  notation: CoordinateNotation
  /** Read from a map link (Google / Apple / OpenStreetMap style URL). */
  fromLink: boolean
}

const RAD = Math.PI / 180

// ------------------------------------------------------------------------------------------------- parsing
type Axis = 'lat' | 'lon'
interface Part {
  value: number
  hemi: 'N' | 'S' | 'E' | 'W' | null
  label: Axis | null
  notation: CoordinateNotation
}

const NUM = String.raw`\d+(?:\.\d+)?|\.\d+`
const HEMI_WORD: Record<string, 'N' | 'S' | 'E' | 'W'> = { N: 'N', NORTH: 'N', S: 'S', SOUTH: 'S', E: 'E', EAST: 'E', W: 'W', WEST: 'W' }
const LABELS: Record<string, Axis> = { LAT: 'lat', LATITUDE: 'lat', LON: 'lon', LNG: 'lon', LONG: 'lon', LONGITUDE: 'lon' }

/** Unicode clean-up: minus signs, primes and degree look-alikes to ASCII; upper case. */
function clean(text: string): string {
  return text
    .replace(/[º˚∘]/g, '°') // before NFKC, which turns "º" into "o"
    .replace(/[″”“]/g, '"')
    .replace(/[′’‘´`]/g, "'")
    .normalize('NFKC')
    .replace(/[−‐‑‒–﹣－]/g, '-')
    .replace(/''/g, '"')
    .toUpperCase()
    .trim()
}

/** One coordinate: [label] [hemi] [sign] D[°|:] [M['|:] [S["]]] [hemi]. */
function parsePart(raw: string): Part | null {
  let s = raw.trim()
  let label: Axis | null = null
  const lm = s.match(/^(LATITUDE|LONGITUDE|LAT|LONG|LON|LNG)\b\s*[:=]?\s*/)
  if (lm) {
    label = LABELS[lm[1]]
    s = s.slice(lm[0].length)
  }
  let hemi: Part['hemi'] = null
  const pre = s.match(/^(NORTH|SOUTH|EAST|WEST|[NSEW])(?![A-Z])\s*/)
  if (pre) {
    hemi = HEMI_WORD[pre[1]]
    s = s.slice(pre[0].length)
  }
  const post = s.match(/\s*(?<![A-Z])(NORTH|SOUTH|EAST|WEST|[NSEW])$/)
  if (post) {
    if (hemi) return null
    hemi = HEMI_WORD[post[1]]
    s = s.slice(0, s.length - post[0].length)
  }
  const m = s.match(new RegExp(String.raw`^([+-])?\s*(${NUM})\s*(°|:)?\s*(?:(${NUM})\s*('|:)?\s*(?:(${NUM})\s*"?)?)?\s*$`))
  if (!m) return null
  const [, sign, dS, , mS, , sS] = m
  const d = Number(dS)
  const min = mS != null ? Number(mS) : 0
  const sec = sS != null ? Number(sS) : 0
  if (mS != null && (!Number.isInteger(d) || min >= 60)) return null
  if (sS != null && (!Number.isInteger(min) || sec >= 60)) return null
  let value = d + min / 60 + sec / 3600
  if (sign === '-') {
    if (hemi === 'N' || hemi === 'E') return null // "-34 N" contradicts itself
    value = -value
  }
  if (hemi === 'S' || hemi === 'W') value = -Math.abs(value)
  return { value, hemi, label, notation: sS != null ? 'dms' : mS != null ? 'dm' : 'decimal' }
}

/** Split coordinate text into its two parts (strong separators, hemisphere letters, degree marks or counts). */
function splitParts(s: string): string[] | null {
  const strong = s
    .split(/\s*[,;|/]\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (strong.length === 2) return strong
  if (strong.length > 2) return null
  // no strong separator: hemisphere letters close (suffix style) or open (prefix style) a part
  const letter = /(?<![A-Z])(?:NORTH|SOUTH|EAST|WEST|[NSEW])(?![A-Z])/g
  if (letter.test(s)) {
    letter.lastIndex = 0
    const prefixStyle = /^(?:(?:LATITUDE|LONGITUDE|LAT|LONG|LON|LNG)\b\s*[:=]?\s*)?(?:NORTH|SOUTH|EAST|WEST|[NSEW])(?![A-Z])/.test(s)
    const cuts: number[] = []
    for (let m = letter.exec(s); m; m = letter.exec(s)) cuts.push(prefixStyle ? m.index : m.index + m[0].length)
    const pieces: string[] = []
    let from = 0
    for (const c of cuts) {
      if (c > from) pieces.push(s.slice(from, c))
      from = c
    }
    pieces.push(s.slice(from))
    const out = pieces.map((p) => p.trim()).filter(Boolean)
    return out.length === 2 ? out : null
  }
  // labels without letters: "lat 34.2 lon -118.1"
  const lab = s.match(/^((?:LATITUDE|LAT)\b.*?)\s+((?:LONGITUDE|LONG|LON|LNG)\b.*)$/) ?? s.match(/^((?:LONGITUDE|LONG|LON|LNG)\b.*?)\s+((?:LATITUDE|LAT)\b.*)$/)
  if (lab) return [lab[1], lab[2]]
  // degree marks: a new degree value starts the second part
  const degs = [...s.matchAll(new RegExp(String.raw`[+-]?(?:${NUM})\s*°`, 'g'))]
  if (degs.length === 2 && degs[1].index != null && degs[1].index > 0) return [s.slice(0, degs[1].index), s.slice(degs[1].index)]
  // plain numbers: 2 -> D D, 4 -> DM DM, 6 -> DMS DMS
  const nums = s.split(/\s+/).filter(Boolean)
  if (!nums.every((n) => new RegExp(String.raw`^[+-]?(?:${NUM})$`).test(n))) return null
  if (nums.length !== 2 && nums.length !== 4 && nums.length !== 6) return null
  const h = nums.length / 2
  if (nums.slice(1, h).some((n) => /^[+-]/.test(n)) || nums.slice(h + 1).some((n) => /^[+-]/.test(n))) return null
  return [nums.slice(0, h).join(' '), nums.slice(h).join(' ')]
}

const axisOf = (p: Part): Axis | null => p.label ?? (p.hemi === 'N' || p.hemi === 'S' ? 'lat' : p.hemi === 'E' || p.hemi === 'W' ? 'lon' : null)

/** Latitude/longitude from a map link: ".../@34.2,-118.1,15z", "?q=34.2,-118.1", "ll=", "#map=15/34.2/-118.1". */
function parseLink(s: string): LatLon | null {
  if (!/^(?:HTTPS?:\/\/|WWW\.|GEO:)/.test(s) && !/MAPS|OPENSTREETMAP/.test(s)) return null
  const n = String.raw`(-?\d{1,3}(?:\.\d+)?)`
  const m =
    s.match(new RegExp(String.raw`^GEO:${n},${n}`)) ??
    s.match(new RegExp(String.raw`@${n},${n}`)) ??
    s.match(new RegExp(String.raw`[?&](?:Q|LL|QUERY|CENTER|SLL|DADDR|DESTINATION)=${n}(?:,|%2C)\s*${n}`)) ??
    s.match(new RegExp(String.raw`MAP=\d+(?:\.\d+)?\/${n}\/${n}`))
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null
}

/** Parse pasted coordinates with how they were read; null when the text is not a latitude/longitude pair.
 *  Accepts "34.2048, -118.1027", "34.2048 N 118.1027 W", "N34.2048 W118.1027", "34°12'17.3"N 118°6'9.7"W",
 *  "34 12.29 N, 118 6.16 W", "34:12:17N 118:06:10W", "lat 34.2 lon -118.1", "-118.1027, 34.2048" (read as
 *  longitude, latitude because 118 > 90), "geo:34.2,-118.1" and map links. Without letters or labels the
 *  order is latitude, longitude. */
export function parseLatLonDetailed(text: string): ParsedLatLon | null {
  if (!text || text.length > 200) return null
  const s = clean(text).replace(/^\(|\)$/g, '').replace(/^\[|\]$/g, '').trim()
  const link = parseLink(s)
  if (link) return { ...link, order: 'lat-lon', notation: 'decimal', fromLink: true }
  const pieces = splitParts(s)
  if (!pieces) return null
  const a = parsePart(pieces[0])
  const b = parsePart(pieces[1])
  if (!a || !b) return null
  let axA = axisOf(a)
  let axB = axisOf(b)
  if (axA && axB && axA === axB) return null
  if (axA && !axB) axB = axA === 'lat' ? 'lon' : 'lat'
  if (axB && !axA) axA = axB === 'lat' ? 'lon' : 'lat'
  if (!axA) {
    // no letters or labels: latitude first, unless the first value cannot be a latitude
    const swap = Math.abs(a.value) > 90 && Math.abs(b.value) <= 90
    axA = swap ? 'lon' : 'lat'
    axB = swap ? 'lat' : 'lon'
  }
  const lat = axA === 'lat' ? a.value : b.value
  const lon = axA === 'lat' ? b.value : a.value
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const rank = { decimal: 0, dm: 1, dms: 2 } as const
  const notation = rank[a.notation] >= rank[b.notation] ? a.notation : b.notation
  return { lat, lon, order: axA === 'lat' ? 'lat-lon' : 'lon-lat', notation, fromLink: false }
}

/** Parse pasted coordinates (see parseLatLonDetailed); null when the text is not a latitude/longitude pair. */
export function parseLatLon(text: string): LatLon | null {
  const p = parseLatLonDetailed(text)
  return p ? { lat: p.lat, lon: p.lon } : null
}

// ------------------------------------------------------------------------------------------------- formatting
/** "34.2048° N, 118.1027° W" (WGS84). */
export function formatLatLon(lat: number, lon: number, digits = 4): string {
  return `${formatLat(lat, digits)}, ${formatLon(lon, digits)}`
}

/** "34.20480° N". */
export function formatLat(lat: number, digits = 5): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}`
}

/** "118.10270° W". */
export function formatLon(lon: number, digits = 5): string {
  return `${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`
}

/** Signed decimal pair for copying / pasting into other tools: "34.20480, -118.10270" (latitude, longitude). */
export function formatDecimalPair(lat: number, lon: number, digits = 5): string {
  const f = (v: number) => (Object.is(Number(v.toFixed(digits)), -0) ? 0 : v).toFixed(digits)
  return `${f(lat)}, ${f(lon)}`
}

function dms(v: number, pos: string, neg: string, secDigits: number): string {
  const a = Math.abs(v)
  let d = Math.floor(a)
  let m = Math.floor((a - d) * 60)
  let s = Number(((a - d - m / 60) * 3600).toFixed(secDigits))
  if (s >= 60) {
    s = 0
    m += 1
  }
  if (m >= 60) {
    m = 0
    d += 1
  }
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(secDigits).padStart(secDigits ? 3 + secDigits : 2, '0')}″ ${v >= 0 ? pos : neg}`
}

/** Degrees-minutes-seconds: "34°12′17.3″ N, 118°06′09.7″ W". */
export function formatDms(lat: number, lon: number, secDigits = 1): string {
  return `${dms(lat, 'N', 'S', secDigits)}, ${dms(lon, 'E', 'W', secDigits)}`
}

// ------------------------------------------------------------------------------------------------- geodesy
const A_WGS = 6378137
const F_WGS = 1 / 298.257223563
const B_WGS = A_WGS * (1 - F_WGS)
const R_MEAN = 6_371_008.8

export interface GeodesicResult {
  /** Ellipsoidal (WGS84) distance in metres. */
  distanceM: number
  /** Direction from the first to the second point at the first point, degrees clockwise from true north. */
  initialBearingDeg: number
  /** Direction of travel on arrival at the second point. */
  finalBearingDeg: number
  /** 'vincenty' (mm accuracy); 'sphere' for nearly antipodal points where Vincenty does not converge. */
  method: 'vincenty' | 'sphere'
}

const norm360 = (deg: number) => ((deg % 360) + 360) % 360

function sphereInverse(a: LatLon, b: LatLon): GeodesicResult {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  const bearing = (p: LatLon, q: LatLon) => {
    const y = Math.sin((q.lon - p.lon) * RAD) * Math.cos(q.lat * RAD)
    const x = Math.cos(p.lat * RAD) * Math.sin(q.lat * RAD) - Math.sin(p.lat * RAD) * Math.cos(q.lat * RAD) * Math.cos((q.lon - p.lon) * RAD)
    return norm360(Math.atan2(y, x) / RAD)
  }
  return { distanceM: 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(h))), initialBearingDeg: bearing(a, b), finalBearingDeg: norm360(bearing(b, a) + 180), method: 'sphere' }
}

/** Vincenty's inverse solution on the WGS84 ellipsoid: distance and bearings between two points. */
export function geodesicInverse(a: LatLon, b: LatLon): GeodesicResult {
  const L = (b.lon - a.lon) * RAD
  const U1 = Math.atan((1 - F_WGS) * Math.tan(a.lat * RAD))
  const U2 = Math.atan((1 - F_WGS) * Math.tan(b.lat * RAD))
  const sinU1 = Math.sin(U1)
  const cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2)
  const cosU2 = Math.cos(U2)
  let lambda = L
  let sinSigma = 0
  let cosSigma = 1
  let sigma = 0
  let cos2Alpha = 1
  let cos2SigmaM = 0
  let sinLambda = 0
  let cosLambda = 1
  let converged = false
  for (let i = 0; i < 200; i++) {
    sinLambda = Math.sin(lambda)
    cosLambda = Math.cos(lambda)
    const t1 = cosU2 * sinLambda
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2)
    if (sinSigma === 0) return { distanceM: 0, initialBearingDeg: 0, finalBearingDeg: 0, method: 'vincenty' } // same point
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0 // equatorial line
    const C = (F_WGS / 16) * cos2Alpha * (4 + F_WGS * (4 - 3 * cos2Alpha))
    const prev = lambda
    lambda = L + (1 - C) * F_WGS * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (Math.abs(lambda - prev) < 1e-12) {
      converged = true
      break
    }
  }
  if (!converged || !Number.isFinite(lambda)) return sphereInverse(a, b)
  const uSq = (cos2Alpha * (A_WGS * A_WGS - B_WGS * B_WGS)) / (B_WGS * B_WGS)
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const dSigma =
    B * sinSigma * (cos2SigmaM + (B / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) - (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
  const s = B_WGS * A * (sigma - dSigma)
  const a1 = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
  const a2 = Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda)
  return { distanceM: s, initialBearingDeg: norm360(a1 / RAD), finalBearingDeg: norm360(a2 / RAD), method: 'vincenty' }
}

/** Geodesic (WGS84 ellipsoid) distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  return geodesicInverse(a, b).distanceM
}

/** Initial geodesic bearing from a to b, degrees clockwise from true north (0..360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  return geodesicInverse(a, b).initialBearingDeg
}

const C16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

/** 16-point compass abbreviation for a bearing in degrees. */
export function compass16(deg: number): string {
  return C16[Math.round(norm360(deg) / 22.5) % 16]
}
