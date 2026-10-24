// Selected point in the 3D scene (brief 2 O-R7; owner: shell): the map's shared selection (useWorkspace.selection:
// a searched address, pasted coordinates, a clicked point) drawn as a light-blue pin standing on the terrain (brief 4:
// the handoff's selected-point colour #9fd6ff, as on the map), so the point
// the location card describes is visible in Forensic too. A click on the terrain sets the selection (ProbeDriver).
// Constant on-screen size; drawn over the terrain (a ridge never hides it); nothing outside the modeled area, where
// the scene has no terrain.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { lonLatToLocal } from '../../lib/geo'
import { useStore } from '../../state/store'
import { useWorkspace } from '../../state/workspace'
import type { IncidentAssets } from '../assets'

/** The pin's height (world units at a camera distance of 1): ~7 % of the view height at the scene's 35 deg fov. */
const SIZE = 0.045
const CYAN = new THREE.Color('#9fd6ff')
const CYAN_STRONG = new THREE.Color('#cfeaff')

export function SelectionPin({ assets }: { assets: IncidentAssets }) {
  const sel = useWorkspace((s) => s.selection)
  const visible = useWorkspace((s) => s.mapLayers.selection)
  const exaggeration = useStore((s) => s.exaggeration)
  const group = useRef<THREE.Group>(null)
  const grid = assets.manifest.grid
  const half = grid.extent_m / 2

  const pos = useMemo(() => {
    if (!sel) return null
    const [x, z] = lonLatToLocal(sel.lon, sel.lat, grid)
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > half || Math.abs(z) > half) return null
    return new THREE.Vector3(x, assets.heightAt(x, z) * exaggeration, z)
  }, [sel, grid, half, assets, exaggeration])

  const parts = useMemo(() => {
    const over = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false }
    return {
      stem: new THREE.CylinderGeometry(0.035, 0.035, 1, 8).translate(0, 0.5, 0),
      head: new THREE.SphereGeometry(0.16, 20, 14).translate(0, 1.08, 0),
      ring: new THREE.RingGeometry(0.16, 0.24, 40).rotateX(-Math.PI / 2),
      stemMat: new THREE.MeshBasicMaterial({ color: CYAN, opacity: 0.95, ...over }),
      headMat: new THREE.MeshBasicMaterial({ color: CYAN_STRONG, opacity: 1, ...over }),
      ringMat: new THREE.MeshBasicMaterial({ color: CYAN, opacity: 0.8, side: THREE.DoubleSide, ...over }),
    }
  }, [])
  useEffect(
    () => () => {
      for (const v of Object.values(parts)) v.dispose()
    },
    [parts],
  )

  useFrame(({ camera }) => {
    const g = group.current
    if (!g || !pos) return
    g.position.copy(pos)
    g.scale.setScalar(Math.max(1, camera.position.distanceTo(pos) * SIZE))
  })

  if (!pos || !visible) return null
  return (
    <group ref={group} position={pos} renderOrder={20}>
      <mesh geometry={parts.ring} material={parts.ringMat} renderOrder={20} />
      <mesh geometry={parts.stem} material={parts.stemMat} renderOrder={21} />
      <mesh geometry={parts.head} material={parts.headMat} renderOrder={22} />
    </group>
  )
}
