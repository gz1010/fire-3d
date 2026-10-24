// Compass heading maths (brief 4 decision f; CONTRACT §15.3). Pure and shared by the map (Public/Command) and the
// Forensic camera: headings are compass bearings in degrees, clockwise from north, as MapLibre's map bearing and the
// Forensic CameraInfo.bearingDeg. Screen angles use CSS pixels (y grows downwards).

/** A heading in [0, 360). Non-finite input gives 0. */
export function normalizeDeg(d: number): number {
  if (!Number.isFinite(d)) return 0
  const r = d % 360
  const n = r < 0 ? r + 360 : r
  // -0 and 360 - epsilon rounding both read as 0
  return n >= 360 || Object.is(n, -0) ? 0 : n
}

/** A heading in (-180, 180] (MapLibre's own range). Non-finite input gives 0. */
export function signedDeg(d: number): number {
  const n = normalizeDeg(d)
  return n > 180 ? n - 360 : n
}

/** The shortest signed turn from heading `a` to heading `b`, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  return signedDeg(b - a)
}

/** One rotation step: `d` turned by `step` degrees (clockwise when positive), in (-180, 180]. Q / E and the ⟲ ⟳
 *  buttons turn by exactly 15°, so steps add up the same from any heading. */
export function stepDeg(d: number, step: number): number {
  return signedDeg(d + step)
}

/** The screen angle of a pointer around a centre, as a compass bearing: 0 = straight up, 90 = right, 180 = down,
 *  270 = left. Null when the pointer is too close to the centre to give a stable angle (`deadPx`). */
export function pointerBearing(cx: number, cy: number, x: number, y: number, deadPx = 0): number | null {
  const dx = x - cx
  const dy = y - cy
  if (Math.hypot(dx, dy) <= deadPx) return null
  return normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/** The heading while the compass is dragged: the needle follows the pointer, so turning the pointer clockwise by
 *  `turnedDeg` (accumulated, may exceed a full turn) turns the map's heading back by the same amount. */
export function dragHeading(startHeading: number, turnedDeg: number): number {
  return signedDeg(startHeading - turnedDeg)
}

/** A heading as the compass shows it: whole degrees, three digits ("000°", "045°", "315°"). */
export function headingLabel(d: number): string {
  const n = Math.round(normalizeDeg(d)) % 360
  return `${String(n).padStart(3, '0')}°`
}

/** The map is turned away from north by more than half a degree. */
export function isRotated(d: number): boolean {
  return Math.abs(signedDeg(d)) > 0.5
}
