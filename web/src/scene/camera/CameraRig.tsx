// Camera rig (SPEC 9.3): map-style controls with damping (left-drag pan, right-drag orbit/tilt, wheel zooms toward
// the cursor), an initial oblique view from the south-south-east framing the fire, 2D = animated top-down,
// store.flyTo and one-shot camera commands (compass reset-north, frame fire, zoom) animate smoothly. The orbit target
// is kept on the terrain under the view centre (so the DOF focus and orbit pivot are on the ground) and the
// projection is shifted so the target sits in the middle of the area not covered by UI panels (sceneStore.viewInsets).
// Brief 4 (decisions f, k): the heading turns in 2D as in 3D. In 2D the controls rotate too, with the top-down polar
// clamp kept (azimuth only: right-drag, Ctrl / Shift / Cmd + drag, a two-finger drag or twist); 2D <-> 3D keeps the
// heading; the commands 'rotate' (deg) and 'set-heading' (deg) turn it (Q / E, the ⟲ ⟳ buttons, the compass drag);
// the rig registers the view's RotationTarget (state/rotation.ts: Q / E / N reach it), takes Safari's trackpad twist
// (lib/rotateGesture.ts) and a touch twist on the canvas, and applies store.flyTo.bearingDeg (the map's heading on the
// hand-off, ui/shell/handoff.ts). Every turn goes through a camera command, so the hand-off sees the user's turn.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { raycastHeightfield } from '../../lib/geo'
import { attachRotateGesture } from '../../lib/rotateGesture'
import { registerRotation } from '../../state/rotation'
import { useStore } from '../../state/store'
import type { IncidentAssets } from '../assets'
import { fireFrameWithForecast } from '../frame'
import { reducedMotion } from '../motion'
import { useSceneStore, type CameraCommand, type ViewInsets } from '../sceneStore'
import { camState } from './cameraState'
import { azimuthOfHeading, headingOfAzimuth, turnedAzimuth, TwistTracker } from './heading'

const DEG = Math.PI / 180
const POLAR_3D = 61 * DEG // from vertical (29 deg above the horizon)
const AZ_SSE = 22.5 * DEG // camera south-south-east of the target, looking north-north-west
const POLAR_2D = 0.0005
const MAX_POLAR = 84 * DEG
/** A ⟲ / ⟳ / Q / E turn (15°) animates this long (instant under reduced motion). */
const TURN_S = 0.35

interface Pose {
  tx: number
  ty: number
  tz: number
  dist: number
  polar: number
  azimuth: number
}

interface Tween {
  from: Pose
  to: Pose
  t0: number
  dur: number
  /** A heading turn ('rotate'): the next turn continues from this one's goal. */
  turn?: boolean
}

const _pose: Pose = { tx: 0, ty: 0, tz: 0, dist: 1, polar: 0, azimuth: 0 }
const _v = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _hit = new THREE.Vector3()
const _sph = new THREE.Spherical()

function poseOf(camera: THREE.Camera, target: THREE.Vector3): Pose {
  _v.copy(camera.position).sub(target)
  _sph.setFromVector3(_v)
  return { tx: target.x, ty: target.y, tz: target.z, dist: _sph.radius, polar: _sph.phi, azimuth: _sph.theta }
}

function applyPose(p: Pose, camera: THREE.Camera, controls: MapControls) {
  _sph.set(p.dist, Math.max(1e-4, p.polar), p.azimuth)
  controls.target.set(p.tx, p.ty, p.tz)
  camera.position.setFromSpherical(_sph).add(controls.target)
  camera.lookAt(controls.target)
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/** Stop the controls' leftover drag inertia (their damping keeps turning / panning for a while after a drag), so an
 *  animation or a set heading does not drift afterwards. three.js has no public call for it: these are the fields its
 *  own update() clears (OrbitControls r186). */
function stopInertia(controls: MapControls, pan = true): void {
  const c = controls as unknown as { _sphericalDelta?: THREE.Spherical; _panOffset?: THREE.Vector3 }
  c._sphericalDelta?.set(0, 0, 0)
  if (pan) c._panOffset?.set(0, 0, 0)
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** Pose framing the fire (observed + forecast reach) inside the free screen area, from the SSE. */
export function framingPose(assets: IncidentAssets, exag: number, width: number, height: number, insets: ViewInsets, fovDeg: number, polar = POLAR_3D, azimuth = AZ_SSE): Pose {
  const ff = fireFrameWithForecast(assets)
  const cx = (ff.minX + ff.maxX) / 2
  const cz = (ff.minZ + ff.maxZ) / 2
  const r = (Math.max(ff.maxX - ff.minX, ff.maxZ - ff.minZ) / 2) * 1.3 + 500
  const freeW = Math.max(200, width - insets.left - insets.right)
  const freeH = Math.max(150, height - insets.top - insets.bottom)
  const tanH = Math.tan((fovDeg * DEG) / 2) * (freeH / Math.max(1, height))
  const aspect = freeW / freeH
  const elev = Math.PI / 2 - polar
  const distV = (r * (Math.sin(elev) * 0.9 + 0.25)) / tanH
  const distH = r / (tanH * aspect)
  const dist = Math.min(assets.extent * 1.7, Math.max(1500, Math.max(distV, distH)))
  return { tx: cx, ty: assets.heightAt(cx, cz) * exag, tz: cz, dist, polar, azimuth }
}

export function CameraRig({ assets }: { assets: IncidentAssets | null }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const gl = useThree((s) => s.gl)
  const size = useThree((s) => s.size)
  const set = useThree((s) => s.set)
  const insets = useSceneStore((s) => s.viewInsets)
  const viewMode = useStore((s) => s.viewMode)

  // constructed without a DOM element (no listeners: StrictMode may build and discard one), connected in an effect
  const controls = useMemo(() => {
    const c = new MapControls(camera)
    c.enableDamping = true
    c.dampingFactor = 0.09
    c.screenSpacePanning = false
    c.zoomToCursor = true
    c.minDistance = 120
    c.maxDistance = 60000
    c.maxPolarAngle = MAX_POLAR
    c.rotateSpeed = 0.55
    c.zoomSpeed = 1.15
    return c
  }, [camera])

  const tween = useRef<Tween | null>(null)
  const last3dPolar = useRef(POLAR_3D)
  const framedKey = useRef<string | null>(null)
  const exagRef = useRef(useStore.getState().exaggeration)
  const publish = useRef({ t: 0, key: '' })
  // what the camera-command subscription needs from the latest render
  const latest = useRef({ assets, width: size.width, height: size.height })
  useLayoutEffect(() => {
    latest.current = { assets, width: size.width, height: size.height }
  }, [assets, size.width, size.height])

  // no keyboard panning: the timeline owns the arrow keys
  useEffect(() => {
    controls.connect(gl.domElement)
    set({ controls })
    const onStart = () => useSceneStore.getState().setInteracting(true)
    const onEnd = () => useSceneStore.getState().setInteracting(false)
    controls.addEventListener('start', onStart)
    controls.addEventListener('end', onEnd)
    return () => {
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('end', onEnd)
      controls.dispose()
      set({ controls: null })
      useSceneStore.getState().setInteracting(false)
    }
  }, [controls, gl, set])

  // projection shift so the orbit target sits in the centre of the uncovered area
  useEffect(() => {
    const dx = (insets.left - insets.right) / 2
    const dy = (insets.top - insets.bottom) / 2
    if (dx === 0 && dy === 0) camera.clearViewOffset()
    else camera.setViewOffset(size.width, size.height, -dx, -dy, size.width, size.height)
    camera.updateProjectionMatrix()
  }, [camera, size.width, size.height, insets])

  const startTween = (to: Pose, dur = 1.2, turn = false) => {
    stopInertia(controls)
    const from = poseOf(camera, controls.target)
    tween.current = { from, to, t0: performance.now(), dur: reducedMotion() ? 0.05 : dur, turn }
    camState.animating = true
    controls.enabled = false
  }

  // frame the fire once per incident (live bundle refreshes keep the user's view)
  const assetKey = assets ? assets.manifest.id : null
  useEffect(() => {
    if (!assets || !assetKey || framedKey.current === assetKey) return
    framedKey.current = assetKey
    const exag = useStore.getState().exaggeration
    exagRef.current = exag
    const vm = useStore.getState().viewMode
    const pose = framingPose(assets, exag, size.width, size.height, useSceneStore.getState().viewInsets, camera.fov, vm === '2d' ? POLAR_2D : POLAR_3D, vm === '2d' ? 0 : AZ_SSE)
    tween.current = null
    applyPose(pose, camera, controls)
    controls.maxDistance = assets.extent * 2.6
    controls.update()
    camState.ready = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetKey])

  // 2D / 3D: the heading is kept both ways (decision k); 2D clamps the polar angle to top-down, so the controls only
  // turn the azimuth there (right-drag, modifier + drag, two fingers)
  useEffect(() => {
    if (!assets) return
    controls.enableRotate = true
    controls.minPolarAngle = viewMode === '3d' ? 0 : POLAR_2D
    controls.maxPolarAngle = viewMode === '3d' ? MAX_POLAR : POLAR_2D
    const cur = poseOf(camera, controls.target)
    if (viewMode === '2d') {
      if (cur.polar > POLAR_2D * 4) last3dPolar.current = cur.polar
      startTween({ ...cur, polar: POLAR_2D, dist: cur.dist * (cur.polar > 0.3 ? 1.15 : 1) }, 1.1)
    } else if (cur.polar < 0.05) {
      startTween({ ...cur, polar: last3dPolar.current, dist: cur.dist / 1.15 }, 1.1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  // store.flyTo (with the map's heading on the hand-off from the map: flyTo.bearingDeg)
  const flyNonce = useStore((s) => s.flyTo?.nonce ?? null)
  useEffect(() => {
    const f = useStore.getState().flyTo
    if (!f || !assets) return
    const exag = useStore.getState().exaggeration
    const cur = poseOf(camera, controls.target)
    const dist = f.distance ?? Math.min(cur.dist, assets.extent * 0.32)
    const azimuth = f.bearingDeg != null && Number.isFinite(f.bearingDeg) ? azimuthOfHeading(f.bearingDeg) : cur.azimuth
    startTween({ tx: f.x, ty: assets.heightAt(f.x, f.z) * exag, tz: f.z, dist: Math.max(controls.minDistance, dist), polar: cur.polar, azimuth }, 1.5)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyNonce])

  // one-shot camera commands (compass, turn buttons and keys, frame fire, zoom buttons), handled as they are issued
  // (a store subscription: a compass drag sends one per frame without re-rendering this component)
  useEffect(() => {
    const run = (cmd: CameraCommand) => {
      const { assets: a, width, height } = latest.current
      if (!a) return
      const cur = poseOf(camera, controls.target)
      const exag = useStore.getState().exaggeration
      const tw = tween.current
      if (cmd.kind === 'reset-north' || cmd.kind === 'rotate') {
        if (cmd.kind === 'rotate' && cmd.deg == null) return
        const goal = (from: number) => (cmd.kind === 'rotate' ? turnedAzimuth(from, cmd.deg ?? 0) : 0)
        // during another animation (2D <-> 3D, a fly-to, framing) the turn joins it: same end, new heading
        if (tw && !tw.turn) {
          tw.to.azimuth = goal(tw.to.azimuth)
          return
        }
        // a turn during a turn continues from that turn's goal, so repeated presses add up to whole steps
        const base = tw?.turn ? tw.to.azimuth : cur.azimuth
        startTween({ ...cur, azimuth: goal(base) }, cmd.kind === 'rotate' ? TURN_S : 0.9, true)
      } else if (cmd.kind === 'set-heading') {
        if (cmd.deg == null) return
        const azimuth = azimuthOfHeading(cmd.deg)
        if (tw) {
          // an animation is running (2D <-> 3D, a fly-to): it ends at this heading
          tw.from.azimuth = azimuth
          tw.to.azimuth = azimuth
          return
        }
        stopInertia(controls, false)
        applyPose({ ...cur, azimuth }, camera, controls)
        controls.update()
      } else if (cmd.kind === 'zoom-in') startTween({ ...cur, dist: Math.max(controls.minDistance, cur.dist * 0.6) }, 0.5)
      else if (cmd.kind === 'zoom-out') startTween({ ...cur, dist: Math.min(controls.maxDistance, cur.dist / 0.6) }, 0.5)
      else if (cmd.kind === 'frame-fire') {
        // fit the whole fire, keeping the heading (north up only on request)
        const vm = useStore.getState().viewMode
        startTween(framingPose(a, exag, width, height, useSceneStore.getState().viewInsets, camera.fov, vm === '2d' ? POLAR_2D : POLAR_3D, cur.azimuth), 1.4)
      }
    }
    return useSceneStore.subscribe((s, p) => {
      if (s.cameraCommand && s.cameraCommand !== p.cameraCommand) run(s.cameraCommand)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls])

  // the visible view's rotation for Q / E / N (state/rotation.ts) and the compass; every turn is a camera command
  useEffect(() => {
    const issue = useSceneStore.getState().issueCameraCommand
    return registerRotation({
      rotateBy: (deg) => issue('rotate', deg),
      northUp: () => issue('reset-north'),
      setBearing: (deg) => issue('set-heading', deg),
      bearing: () => headingOfAzimuth(camState.azimuth),
    })
  }, [])

  // Safari's two-finger trackpad twist and a two-finger twist on a touch screen turn the view with the fingers
  useEffect(() => {
    const el = gl.domElement
    const heading = () => headingOfAzimuth(poseOf(camera, controls.target).azimuth)
    const setHeading = (deg: number) => useSceneStore.getState().issueCameraCommand('set-heading', deg)
    let safariStart = 0
    const detachSafari = attachRotateGesture(el, {
      start: () => {
        safariStart = heading()
      },
      rotate: (delta) => setHeading(safariStart - delta),
      end: () => undefined,
    })
    const twist = new TwistTracker()
    let twistStart = 0
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') twist.down(e.pointerId, e.clientX, e.clientY)
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      const step = twist.move(e.pointerId, e.clientX, e.clientY)
      if (!step) return
      if (step.start) twistStart = heading()
      setHeading(twistStart - step.turned)
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') twist.up(e.pointerId)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      detachSafari()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [gl, camera, controls])

  useFrame(() => {
    const s = useStore.getState()
    // exaggeration changes: keep the view anchored to the same ground point
    if (assets && s.exaggeration !== exagRef.current) {
      const old = exagRef.current
      exagRef.current = s.exaggeration
      const h = assets.heightAt(controls.target.x, controls.target.z)
      const dy = h * (s.exaggeration - old)
      controls.target.y += dy
      camera.position.y += dy
      if (tween.current) {
        tween.current.to.ty += dy
        tween.current.from.ty += dy
      }
    }

    const tw = tween.current
    if (tw) {
      const p = Math.min(1, (performance.now() - tw.t0) / (tw.dur * 1000))
      const e = easeInOut(p)
      const a = tw.from
      const b = tw.to
      const pose = _pose
      pose.tx = a.tx + (b.tx - a.tx) * e
      pose.ty = a.ty + (b.ty - a.ty) * e
      pose.tz = a.tz + (b.tz - a.tz) * e
      pose.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * e)
      pose.polar = a.polar + (b.polar - a.polar) * e
      pose.azimuth = lerpAngle(a.azimuth, b.azimuth, e)
      applyPose(pose, camera, controls)
      if (p >= 1) {
        tween.current = null
        camState.animating = false
        controls.enabled = true
        controls.update()
      }
    } else {
      controls.update()
      if (assets) {
        // keep the target inside the AOI and on the ground under the view centre
        const lim = assets.extent * 0.55
        const cx = THREE.MathUtils.clamp(controls.target.x, -lim, lim)
        const cz = THREE.MathUtils.clamp(controls.target.z, -lim, lim)
        if (cx !== controls.target.x || cz !== controls.target.z) {
          camera.position.x += cx - controls.target.x
          camera.position.z += cz - controls.target.z
          controls.target.x = cx
          controls.target.z = cz
        }
        const ground = assets.heightAt(controls.target.x, controls.target.z) * s.exaggeration
        if (Math.abs(controls.target.y - ground) > 1.5) {
          _dir.copy(controls.target).sub(camera.position)
          const hit = raycastHeightfield(camera.position, _dir, assets, s.exaggeration, _hit)
          if (hit && hit.distanceTo(camera.position) > controls.minDistance * 0.5) controls.target.copy(hit)
          else controls.target.y = ground
        }
      }
    }

    // clip planes follow the zoom (depth precision for draped overlays)
    const dist = camera.position.distanceTo(controls.target)
    const ext = assets?.extent ?? 20000
    const near = THREE.MathUtils.clamp(dist * 0.004, 0.8, 40)
    const far = Math.max(ext * 8, dist * 10)
    if (Math.abs(near - camera.near) > camera.near * 0.15 || Math.abs(far - camera.far) > camera.far * 0.15) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }

    // blackboard + throttled summary for the overlays
    camState.target.copy(controls.target)
    camState.distance = dist
    _v.copy(camera.position).sub(controls.target)
    _sph.setFromVector3(_v)
    camState.polar = _sph.phi
    camState.azimuth = _sph.theta
    const now = performance.now()
    const pub = publish.current
    if (now - pub.t > 66) {
      const bearing = (((-_sph.theta * 180) / Math.PI) % 360 + 360) % 360
      const mpp = (2 * dist * Math.tan((camera.fov * DEG) / 2)) / Math.max(1, size.height)
      const t = controls.target
      const key = `${bearing.toFixed(1)}|${(_sph.phi / DEG).toFixed(1)}|${mpp.toPrecision(3)}|${Math.round(t.x)},${Math.round(t.y)},${Math.round(t.z)}`
      if (key !== pub.key) {
        pub.key = key
        pub.t = now
        useSceneStore.getState().setCamera({
          bearingDeg: bearing,
          polarDeg: _sph.phi / DEG,
          distance: dist,
          metersPerPixel: mpp,
          target: [t.x, t.y, t.z],
        })
        useSceneStore.getState().setFocusDistance(dist)
      }
    }
  }, -5)

  return null
}
