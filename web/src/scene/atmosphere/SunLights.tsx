// Sun + sky lights (SPEC 9.3 / 9.6). The terrain shader lights itself from the current look; these three.js lights
// exist so standard materials (trees, aircraft, ...) match it and so the sun can cast a shadow map:
//   "sun"  DirectionalLight (first directional light in the scene; scene-fx reads its direction), colour x PI so a
//          Lambert surface gets albedo * sunColor * N.L like the terrain; casts a PCF shadow map at high / medium
//          quality (4096 / 2048), fitted around the orbit target and re-rendered only when needed
//   "sky"  HemisphereLight with the look's sky / ground ambient (x PI for the same reason).
// The terrain does not cast into the shadow map (its self-shadowing is the soft baked sun visibility); it receives.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore, type Quality } from '../../state/store'
import { camState } from '../camera/cameraState'
import { look } from '../look'
import { useSceneStore } from '../sceneStore'

const SHADOW_SIZE: Record<Quality, number> = { high: 4096, medium: 2048, low: 0 }

export function SunLights({ extent, elevMin, elevMax }: { extent: number; elevMin: number; elevMax: number }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const quality = useStore((s) => s.quality)
  const sun = useMemo(() => {
    const l = new THREE.DirectionalLight(0xffffff, Math.PI)
    l.name = 'sun'
    l.shadow.bias = -0.0003
    l.shadow.normalBias = 0
    l.shadow.radius = 2.5
    l.shadow.camera.near = 1
    return l
  }, [])
  const hemi = useMemo(() => {
    const h = new THREE.HemisphereLight(0xffffff, 0x000000, Math.PI)
    h.name = 'sky'
    return h
  }, [])
  const fit = useRef({ cx: Number.NaN, cz: Number.NaN, size: 0, version: -1, exag: 0, shadowVersion: -1, timeMs: 0, wall: 0 })

  useEffect(() => {
    scene.add(sun.target)
    return () => {
      scene.remove(sun.target)
      sun.dispose()
      hemi.dispose()
    }
  }, [scene, sun, hemi])

  // shadow map resolution / enable per quality (static map: rendered on demand)
  useEffect(() => {
    const size = SHADOW_SIZE[quality]
    sun.castShadow = size > 0
    if (size > 0 && sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size)
      sun.shadow.map?.dispose()
      sun.shadow.map = null
    }
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
    fit.current.cx = Number.NaN
  }, [quality, gl, sun])

  useFrame(() => {
    const c = look.current
    sun.color.setRGB(c.sunColor[0], c.sunColor[1], c.sunColor[2])
    hemi.color.setRGB(c.skyAmbient[0], c.skyAmbient[1], c.skyAmbient[2])
    hemi.groundColor.setRGB(c.groundAmbient[0], c.groundAmbient[1], c.groundAmbient[2])

    const s = useStore.getState()
    const f = fit.current
    // fit the shadow frustum around the orbit target (snapped so small moves do not re-render)
    const size = Math.min(extent * 0.75, Math.max(900, camState.distance * 1.15))
    const bucket = Math.pow(2, Math.ceil(Math.log2(size)))
    const snap = bucket / 8
    const cx = Math.round(camState.target.x / snap) * snap
    const cz = Math.round(camState.target.z / snap) * snap
    const shadowVersion = useSceneStore.getState().shadowVersion
    const wall = performance.now()
    let dirty = false
    if (cx !== f.cx || cz !== f.cz || bucket !== f.size || look.version !== f.version || look.progress < 1 || s.exaggeration !== f.exag) {
      f.cx = cx
      f.cz = cz
      f.size = bucket
      f.version = look.version
      f.exag = s.exaggeration
      const exag = s.exaggeration
      const midY = ((elevMin + elevMax) / 2) * exag
      const dist = extent * 1.5 + (elevMax - elevMin) * exag
      sun.target.position.set(cx, midY, cz)
      sun.position.set(cx + c.sunDir[0] * dist, midY + c.sunDir[1] * dist, cz + c.sunDir[2] * dist)
      sun.target.updateMatrixWorld()
      sun.updateMatrixWorld()
      const cam = sun.shadow.camera
      const half = Math.min(bucket * 0.75, extent * 0.75)
      cam.left = -half
      cam.right = half
      cam.top = half
      cam.bottom = -half
      cam.near = 1
      cam.far = dist * 2
      cam.updateProjectionMatrix()
      dirty = true
    }
    if (shadowVersion !== f.shadowVersion) {
      f.shadowVersion = shadowVersion
      dirty = true
    }
    // burned trees change shape with time: refresh at most ~4x per second while the timeline moves
    if (Math.abs(s.timeMs - f.timeMs) > 5 * 60_000 && wall - f.wall > 250) {
      f.timeMs = s.timeMs
      dirty = true
    }
    if (dirty && sun.castShadow) {
      f.wall = wall
      gl.shadowMap.needsUpdate = true
    }
  })

  return (
    <>
      <primitive object={sun} />
      <primitive object={hemi} />
    </>
  )
}
