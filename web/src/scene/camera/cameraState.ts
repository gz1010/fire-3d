// Mutable per-frame camera blackboard written by <CameraRig/> and read by other scene-core components (terrain
// isochrone step, shadow fitting, depth-of-field focus). Never triggers React renders.
import * as THREE from 'three'

export const camState = {
  /** Orbit target (world, y exaggerated): kept on the terrain surface under the view centre. */
  target: new THREE.Vector3(),
  /** Camera -> target distance (m). */
  distance: 10000,
  /** Spherical angles of the camera around the target: polar from +Y, azimuth from +Z (south) toward +X (east). */
  polar: 0.9,
  azimuth: 0.39,
  /** True once the rig has framed the current incident. */
  ready: false,
  /** True while an animated camera move (fly-to, 2D/3D, reset) runs. */
  animating: false,
}
