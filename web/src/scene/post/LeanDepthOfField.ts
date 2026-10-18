// Depth of field with bokeh (postprocessing DepthOfFieldEffect) that keeps its far-field bokeh buffer at the
// effect's reduced resolution. The library fills that buffer at full resolution, which dominates the cost at
// DPR 2 (7+ megapixels); the far field is blurred anyway, and the kernel radius is defined in full-resolution texel
// units, so the look is unchanged.
import { DepthOfFieldEffect } from 'postprocessing'
import type * as THREE from 'three'

export class LeanDepthOfField extends DepthOfFieldEffect {
  override setSize(width: number, height: number): void {
    super.setSize(width, height)
    const far = (this as unknown as { renderTargetFar?: THREE.WebGLRenderTarget }).renderTargetFar
    const r = this.resolution
    if (far && r.width > 0 && r.height > 0) far.setSize(r.width, r.height)
  }
}
