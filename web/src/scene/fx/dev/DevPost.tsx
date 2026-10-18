// FX dev post-processing: bloom on emissive values (luminance threshold), optional depth of field focused on the
// orbit target, AgX tone mapping, vignette and a whisper of film grain (approximates scene-core's pipeline).
import { Bloom, DepthOfField, EffectComposer, Noise, ToneMapping, Vignette } from '@react-three/postprocessing'
import { useFrame, useThree } from '@react-three/fiber'
import { BlendFunction, ToneMappingMode } from 'postprocessing'
import { useMemo } from 'react'
import * as THREE from 'three'
import { useStore } from '../../../state/store'

export function DevPost() {
  const quality = useStore((s) => s.quality)
  const dof = useStore((s) => s.dof)
  const viewMode = useStore((s) => s.viewMode)
  const style = useStore((s) => s.visualStyle)
  const threshold = style === 'realistic' ? 1.0 : style === 'parametric' ? 0.85 : 0.92
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null
  const target = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    if (controls?.target) target.copy(controls.target)
  })
  const useDof = dof && quality !== 'low' && viewMode === '3d'
  return (
    <EffectComposer multisampling={quality === 'low' ? 0 : 4}>
      <Bloom mipmapBlur luminanceThreshold={threshold} luminanceSmoothing={0.3} intensity={0.9} radius={0.74} />
      <>{useDof && <DepthOfField target={target} worldFocusRange={2600} bokehScale={2.2} />}</>
      <ToneMapping mode={style === 'realistic' ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.AGX} />
      <Vignette eskil={false} offset={0.28} darkness={0.62} />
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.18} />
    </EffectComposer>
  )
}
