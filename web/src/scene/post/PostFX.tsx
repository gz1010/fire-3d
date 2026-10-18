// Post-processing (SPEC 9.0 / 9.3 / 9.6), vanilla `postprocessing` driven from one useFrame (priority 1, so it also
// renders the frame). Passes, in HDR until the grade:
//   1. depth of field with bokeh, focused on the orbit target (store.dof; off in 2D and at low quality)
//   2. bloom (mipmap blur, luminance threshold ~1 so only emissive fire / lines / glints glow) + filmic tone
//      mapping & grade + vignette
//   3. SMAA (on the graded image; skipped at DPR >= 1.75 where edges are already fine) + film grain
// Strengths follow the current look; quality picks resolutions and presets.
import { useFrame, useThree } from '@react-three/fiber'
import { BlendFunction, BloomEffect, EdgeDetectionMode, EffectComposer, EffectPass, KernelSize, NoiseEffect, RenderPass, SMAAEffect, SMAAPreset, VignetteEffect } from 'postprocessing'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../../state/store'
import { camState } from '../camera/cameraState'
import { look } from '../look'
import { FilmGradeEffect } from './FilmGradeEffect'
import { LeanDepthOfField } from './LeanDepthOfField'

export function PostFX() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const quality = useStore((s) => s.quality)

  const hiDpr = dpr >= 1.75
  const pipe = useMemo(() => {
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0, depthBuffer: true, stencilBuffer: false })
    composer.addPass(new RenderPass(scene, camera))
    const dof =
      quality === 'low'
        ? null
        : new LeanDepthOfField(camera, { focusDistance: 5000, focusRange: 3000, bokehScale: 3, resolutionScale: hiDpr ? 0.32 : quality === 'high' ? 0.5 : 0.4 })
    const dofPass = dof ? new EffectPass(camera, dof) : null
    if (dofPass) composer.addPass(dofPass)
    const bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.92,
      luminanceSmoothing: 0.3,
      intensity: 0.9,
      radius: 0.74,
      levels: quality === 'low' ? 5 : 7,
      kernelSize: KernelSize.LARGE,
    })
    const grade = new FilmGradeEffect()
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.6 })
    const noise = new NoiseEffect({ premultiply: false, blendFunction: BlendFunction.SOFT_LIGHT })
    if (hiDpr) {
      // at DPR >= 1.75 edges are already fine: no SMAA, the grain joins the grade pass (one full-screen pass less)
      composer.addPass(new EffectPass(camera, bloom, grade, vignette, noise))
    } else {
      composer.addPass(new EffectPass(camera, bloom, grade, vignette))
      const smaa = new SMAAEffect({ preset: quality === 'high' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM, edgeDetectionMode: EdgeDetectionMode.COLOR })
      composer.addPass(new EffectPass(camera, smaa, noise))
    }
    const passes = composer.passes.filter((p): p is EffectPass => p instanceof EffectPass)
    return { composer, dof, dofPass, bloom, grade, vignette, noise, passes }
  }, [gl, scene, camera, quality, hiDpr])

  useEffect(() => {
    const prev = gl.toneMapping
    gl.toneMapping = THREE.NoToneMapping
    return () => {
      gl.toneMapping = prev
      pipe.composer.dispose()
    }
  }, [pipe, gl])

  useEffect(() => {
    pipe.composer.setSize(size.width, size.height)
  }, [pipe, size.width, size.height, dpr])

  useFrame((_, dt) => {
    const s = useStore.getState()
    const c = look.current
    const { dof, dofPass, bloom, grade, vignette, noise, passes } = pipe
    // the camera rig adapts near/far to the zoom; materials copied them by value at construction
    const cam = camera as THREE.PerspectiveCamera
    for (const p of passes) {
      const nf = (p.fullscreenMaterial as THREE.ShaderMaterial | null)?.uniforms?.cameraNearFar?.value as THREE.Vector2 | undefined
      nf?.set(cam.near, cam.far)
    }
    if (dof && dofPass) {
      const on = s.dof && s.viewMode === '3d' && c.bokeh > 0
      dofPass.enabled = on
      if (on) {
        const u = dof.cocMaterial.uniforms
        u.cameraNear.value = cam.near
        u.cameraFar.value = cam.far
        const d = Math.max(1, camState.distance)
        dof.cocMaterial.focusDistance = d
        dof.cocMaterial.focusRange = d * 1.15
        dof.bokehScale = c.bokeh * (quality === 'high' ? 1 : 0.8)
      }
    }
    bloom.intensity = c.bloomIntensity
    bloom.luminanceMaterial.threshold = c.bloomThreshold
    grade.set(c)
    vignette.darkness = c.vignette
    noise.blendMode.opacity.value = c.grain
    pipe.composer.render(dt)
  }, 1)

  return null
}
