import { describe, expect, it } from 'vitest'
import { aoiBounds } from '../lib/fireBounds'
import { localToLonLat } from '../lib/reproject'
import { boundsCenter, CALIFORNIA_BOUNDS, Framing, goalFor, latestPerimeter, MAX_REISSUES, poseMatches, zoomForBounds, type CameraPose, type FrameGoal, type GoalInput } from './framing'

const GRID = { utm_zone: 11, center_e: 401418.0, center_n: 3784849.0, extent_m: 12000, bbox_lonlat: [-118.2, 34.1, -118.07, 34.24] as [number, number, number, number] }
const [PLON, PLAT] = localToLonLat(500, -300, GRID)
const SUMMARY = { id: 'fire-a', lat: PLAT, lon: PLON, acres: 800, bundle_status: 'ready' as const }

/** A 100 x 100 raster with a burned block (rows 40-49, cols 40-49). */
function burned() {
  const data = new Float32Array(100 * 100).fill(1e6)
  for (let r = 40; r < 50; r++) for (let c = 40; c < 50; c++) data[r * 100 + c] = 3
  return { data, width: 100, height: 100 }
}

function input(over: Partial<GoalInput> = {}): GoalInput {
  return {
    target: 'fire-a',
    incidentId: 'fire-a',
    incidentLoading: false,
    summary: SUMMARY,
    manifest: { id: 'fire-a', status: 'ready', grid: GRID as never },
    rasters: 'settled',
    burned: burned(),
    p90: null,
    perimeters: [],
    overviewView: null,
    ...over,
  }
}

/** A pose at the goal's centre (what the controller would compute with cameraForBounds). */
function poseOf(g: FrameGoal, zoom = 11): CameraPose {
  const [lon, lat] = g.view ? [g.view.lon, g.view.lat] : boundsCenter(g.bounds!)
  return { lon, lat, zoom: g.view?.zoom ?? zoom, bearing: 0, pitch: 0 }
}

/** Simulates the controller: issue fits, report moveends; records every fit issued. */
class Driver {
  fits: FrameGoal[] = []
  f: Framing
  constructor(f: Framing) {
    this.f = f
  }
  offer(g: FrameGoal | null) {
    const cmd = this.f.offer(g)
    if (cmd) this.issue(cmd.goal, cmd.reissue)
    return cmd
  }
  issue(g: FrameGoal, reissue = false) {
    this.fits.push(g)
    this.f.started(g, poseOf(g), reissue)
  }
  /** The flight ends at `pose` (default: the goal). A re-issue answer is issued like the controller does. */
  end(pose?: CameraPose, byUser = false) {
    const cmd = this.f.moveEnd(byUser, pose ?? this.f.pose!)
    if (cmd) this.issue(cmd.goal, cmd.reissue)
    return cmd
  }
}

describe('camera helpers', () => {
  it('poseMatches: same place within tolerance; an interrupted flight 34 km off is not', () => {
    const a: CameraPose = { lon: -118.53, lat: 34.07, zoom: 10.31, bearing: 0, pitch: 0 }
    expect(poseMatches(a, { ...a, lon: a.lon + 0.0004, zoom: 10.4 })).toBe(true)
    expect(poseMatches(a, { ...a, lon: -118.224, lat: 34.168, zoom: 10.32 })).toBe(false)
    expect(poseMatches(a, { ...a, bearing: 359.5 })).toBe(true)
    expect(poseMatches(a, { ...a, bearing: 15 })).toBe(false)
    expect(poseMatches(a, { ...a, pitch: 58 })).toBe(false)
  })

  it('zoomForBounds fits a box like MapLibre (California about z5.2 at 1440 x 900, z4.5 on a phone)', () => {
    // the whole 1440 x 900 map below the header; the safe area (overview panel, timeline) lowers it to about 5.2
    const desk = zoomForBounds(CALIFORNIA_BOUNDS, 1440, 900 - 44, 12)
    expect(desk).toBeGreaterThan(5.4)
    expect(desk).toBeLessThan(5.7)
    const safe = zoomForBounds(CALIFORNIA_BOUNDS, 1440 - 340, 900 - 44 - 190, 12)
    expect(safe).toBeGreaterThan(5.0)
    expect(safe).toBeLessThan(5.4)
    const phone = zoomForBounds(CALIFORNIA_BOUNDS, 390, 844 - 200, 8)
    expect(phone).toBeGreaterThan(4.0)
    expect(phone).toBeLessThan(4.9)
    expect(zoomForBounds([-118.1, 34.1, -118.1, 34.1], 100, 100, 0, 15)).toBe(15)
    const [lon, lat] = boundsCenter([-120, 30, -110, 40])
    expect(lon).toBe(-115)
    expect(lat).toBeGreaterThan(35) // Mercator centre lies north of the arithmetic mean
  })

  it('latestPerimeter takes the newest, whatever the order', () => {
    expect(latestPerimeter([{ t_ms: 3 }, { t_ms: 9 }, { t_ms: 1 }])?.t_ms).toBe(9)
    expect(latestPerimeter(null)).toBeNull()
  })
})

describe('goalFor', () => {
  it('overview: California, or the overview view the user left', () => {
    expect(goalFor(input({ target: null }))).toEqual({ key: 'overview', kind: 'overview', provisional: false, bounds: CALIFORNIA_BOUNDS })
    const g = goalFor(input({ target: null, overviewView: { lon: -118, lat: 34, zoom: 7.5 } }))!
    expect(g.view).toEqual({ lon: -118, lat: 34, zoom: 7.5 })
    expect(g.bounds).toBeUndefined()
  })

  it('ready bundle: waits for the rasters, then frames the fire (final), inside the AOI', () => {
    expect(goalFor(input({ rasters: 'pending' }))).toBeNull()
    const g = goalFor(input())!
    expect(g.kind).toBe('fire')
    expect(g.provisional).toBe(false)
    const aoi = aoiBounds(GRID)
    expect(g.bounds![0]).toBeGreaterThanOrEqual(aoi[0])
    expect(g.bounds![2] - g.bounds![0]).toBeLessThan((aoi[2] - aoi[0]) * 0.6)
    // rasters failed or timed out: the perimeter and point still frame something
    expect(goalFor(input({ rasters: 'expired', burned: null }))?.key).toBe('fire:fire-a:ready')
  })

  it('a summary whose bundle is still loading waits; with no bundle the point + acreage frame it provisionally', () => {
    const loading = input({ manifest: null, incidentLoading: true })
    expect(goalFor(loading)).toBeNull()
    const none = goalFor(input({ manifest: null, summary: { ...SUMMARY, bundle_status: 'none' }, incidentLoading: true }))!
    expect(none.provisional).toBe(true)
    expect(none.key).toBe('fire:fire-a:point')
    // the bundle files failed to load (loading over, no manifest): the point
    expect(goalFor(input({ manifest: null }))?.key).toBe('fire:fire-a:point')
    const building = goalFor(input({ manifest: { id: 'fire-a', status: 'building', grid: GRID as never }, summary: { ...SUMMARY, bundle_status: 'building' } }))!
    expect(building.key).toBe('fire:fire-a:building')
    expect(building.provisional).toBe(true)
  })

  it('ignores data of another incident (a switch in progress) and a missing summary', () => {
    expect(goalFor(input({ incidentId: 'fire-b' }))).toBeNull()
    expect(goalFor(input({ manifest: null, summary: { ...SUMMARY, id: 'fire-b' } }))).toBeNull()
    expect(goalFor(input({ manifest: null, summary: null }))).toBeNull()
  })
})

describe('Framing state machine', () => {
  const ready = () => goalFor(input())!

  it('flies once, when the bundle and its rasters are ready (delayed responses: summary, then manifest, then rasters)', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: 'fire-a' }))
    expect(d.offer(goalFor(input({ manifest: null, summary: null, incidentLoading: true })))).toBeNull()
    expect(d.offer(goalFor(input({ manifest: null, incidentLoading: true })))).toBeNull() // summary only
    expect(d.offer(goalFor(input({ rasters: 'pending' })))).toBeNull() // manifest, rasters loading
    d.offer(ready())
    expect(d.fits).toHaveLength(1)
    expect(d.f.phase).toBe('flying')
    d.end()
    expect(d.f.phase).toBe('done')
    // later data (live refresh: new rasters, bigger fire) never re-frames a final goal
    expect(d.offer({ ...ready(), bounds: [-118.3, 34, -118, 34.3] })).toBeNull()
    expect(d.fits).toHaveLength(1)
    expect(d.f.framedKind()).toBe('fire')
  })

  it('null -> id is a first load: a view restored for the linked incident is kept', () => {
    const f = new Framing({ incidentId: null, restoredView: true, urlIncident: 'fire-a' })
    expect(f.phase).toBe('done') // the overview is not framed over the deep-linked view
    f.setTarget('fire-a')
    expect(f.phase).toBe('done')
    expect(f.offer(ready())).toBeNull()
    // a restored view while the incident is already set (hand-off from Forensic) is kept too
    const g = new Framing({ incidentId: 'fire-a', restoredView: true, urlIncident: null })
    expect(g.offer(goalFor(input({ manifest: null, summary: { ...SUMMARY, bundle_status: 'none' } })))).toBeNull()
  })

  it('a restored view does not stick to a different first incident (or to the overview without a linked fire)', () => {
    const f = new Framing({ incidentId: null, restoredView: true, urlIncident: 'fire-a' })
    f.setTarget('fire-b')
    expect(f.phase).toBe('waiting')
    const g = new Framing({ incidentId: null, restoredView: true, urlIncident: null })
    g.setTarget('fire-a')
    expect(g.phase).toBe('waiting')
  })

  it('without a restored view, the overview frames California, then a fire opened from it is flown to', () => {
    const d = new Driver(new Framing({ incidentId: null, restoredView: false, urlIncident: null }))
    d.offer(goalFor(input({ target: null })))
    expect(d.fits[0].bounds).toEqual(CALIFORNIA_BOUNDS)
    d.end()
    d.f.setTarget('fire-a')
    expect(d.f.phase).toBe('waiting')
    d.offer(ready())
    expect(d.fits).toHaveLength(2)
    d.end()
    // "← All fires": back to the overview view the user left
    d.f.setTarget(null)
    d.offer(goalFor(input({ target: null, overviewView: { lon: -118.2, lat: 34.2, zoom: 7 } })))
    expect(d.fits[2].view).toEqual({ lon: -118.2, lat: 34.2, zoom: 7 })
  })

  it('a non-user call that stops the fit off target (e.g. the compass 250 ms in) re-issues it', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    d.offer(ready())
    const target = d.f.pose!
    const cmd = d.end({ ...target, lon: target.lon + 0.31, lat: target.lat + 0.1, zoom: 10.32 })
    expect(cmd?.reissue).toBe(true)
    expect(d.fits).toHaveLength(2)
    expect(d.f.phase).toBe('flying')
    d.end()
    expect(d.f.phase).toBe('done')
  })

  it('a user gesture during the flight ends framing; nothing re-frames afterwards', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    d.offer(ready())
    d.f.userGesture()
    expect(d.end({ lon: 0, lat: 0, zoom: 3, bearing: 0, pitch: 0 })).toBeNull()
    expect(d.f.phase).toBe('user')
    expect(d.offer(ready())).toBeNull()
    // a user move reported only by the moveend (originalEvent) does the same
    const e = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    e.offer(ready())
    e.end(undefined, true)
    expect(e.f.phase).toBe('user')
  })

  it('an explicit request while waiting (a search result) wins over the late opening fit', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    expect(d.offer(goalFor(input({ rasters: 'pending' })))).toBeNull()
    d.f.explicit()
    expect(d.offer(ready())).toBeNull()
    expect(d.fits).toHaveLength(0)
  })

  it('gives up re-issuing after MAX_REISSUES (a camera that never matches exactly) and counts it as framed', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    d.offer(ready())
    const off = { ...d.f.pose!, zoom: d.f.pose!.zoom - 1 }
    for (let i = 0; i < MAX_REISSUES; i++) expect(d.end(off)?.reissue).toBe(true)
    expect(d.end(off)).toBeNull()
    expect(d.f.phase).toBe('done')
    expect(d.fits).toHaveLength(1 + MAX_REISSUES)
  })

  it('unbuilt fire: point estimate, then the building grid, then the ready fire, unless the user moved', () => {
    const none = goalFor(input({ manifest: null, summary: { ...SUMMARY, bundle_status: 'none' } }))
    const building = goalFor(input({ manifest: { id: 'fire-a', status: 'building', grid: GRID as never }, summary: { ...SUMMARY, bundle_status: 'building' } }))
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    d.offer(none)
    d.end()
    expect(d.f.phase).toBe('done')
    d.offer(none) // same key: no new flight
    d.offer(building)
    d.end()
    d.offer(ready())
    d.end()
    expect(d.fits.map((g) => g.key)).toEqual(['fire:fire-a:point', 'fire:fire-a:building', 'fire:fire-a:ready'])
    // the user moved after the point estimate: the better data does not move the camera
    const u = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    u.offer(none)
    u.end()
    u.end({ lon: 1, lat: 1, zoom: 9, bearing: 0, pitch: 0 }, true)
    expect(u.offer(building)).toBeNull()
    expect(u.offer(ready())).toBeNull()
  })

  it('a fire focused by zooming (and the overview reached by zooming out) is never framed', () => {
    const d = new Driver(new Framing({ incidentId: null, restoredView: false, urlIncident: null }))
    d.offer(goalFor(input({ target: null })))
    d.end()
    d.f.setTarget('fire-a', { keepCamera: true })
    expect(d.f.phase).toBe('user')
    expect(d.offer(goalFor(input({ rasters: 'pending' })))).toBeNull()
    expect(d.offer(ready())).toBeNull()
    d.f.setTarget(null, { keepCamera: true })
    expect(d.offer(goalFor(input({ target: null })))).toBeNull()
    expect(d.fits).toHaveLength(1)
    // an explicit open afterwards is framed again
    d.f.setTarget('fire-a')
    expect(d.offer(ready())?.goal.key).toBe('fire:fire-a:ready')
  })

  it('a switch to another fire mid-flight waits for that fire; the old flight ending does not count', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null }))
    d.offer(ready())
    d.f.setTarget('fire-b')
    expect(d.f.phase).toBe('waiting')
    expect(d.end({ lon: 0, lat: 0, zoom: 4, bearing: 0, pitch: 0 })).toBeNull()
    expect(d.f.phase).toBe('waiting')
  })

  it('"Incident" requests are tracked like a fit and toggle fire / modeled area', () => {
    const d = new Driver(new Framing({ incidentId: 'fire-a', restoredView: true, urlIncident: null }))
    expect(d.f.framedKind()).toBeNull()
    const area: FrameGoal = { key: 'area:fire-a', kind: 'area', provisional: true, bounds: aoiBounds(GRID) }
    const cmd = d.f.request(area)
    expect(cmd.goal.provisional).toBe(false)
    d.issue(cmd.goal)
    d.end()
    expect(d.f.framedKind()).toBe('area')
    d.end(undefined, true)
    expect(d.f.framedKind()).toBeNull()
    expect(d.f.viewIsSettled()).toBe(true)
  })

  it('views are saved only once settled (never mid-flight or while waiting)', () => {
    const f = new Framing({ incidentId: 'fire-a', restoredView: false, urlIncident: null })
    expect(f.viewIsSettled()).toBe(false)
    f.started(ready(), poseOf(ready()))
    expect(f.viewIsSettled()).toBe(false)
    f.moveEnd(false, f.pose!)
    expect(f.viewIsSettled()).toBe(true)
  })
})
