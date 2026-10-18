// Animates the shared look blackboard toward the store's visualStyle (~0.9 s, instant with reduced motion) at the
// start of every frame, and publishes the lighting/atmosphere as sceneStore.env for other scene materials.
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { atmosphereFrame, fogDensityFor } from './atmosphere/atmosphere'
import { cloneLook, ease, lerpLook, look, LOOK_VALUES, type LookValues } from './look'
import { reducedMotion } from './motion'
import { useSceneStore, type SceneEnv } from './sceneStore'

const TRANSITION_S = 0.9

function envOf(v: LookValues): SceneEnv {
  return {
    style: look.style,
    sunDir: [...v.sunDir],
    sunColor: [...v.sunColor],
    skyAmbient: [...v.skyAmbient],
    groundAmbient: [...v.groundAmbient],
    skyZenith: [...v.skyZenith],
    skyHorizon: [...v.skyHorizon],
    skyGround: [...v.skyGround],
    fogColor: [...v.skyHorizon],
    fogDensity: fogDensityFor(atmosphereFrame.extent, v.fogVisibility),
    fogFalloff: 1 / Math.max(50, v.fogHeightM),
    fogBaseY: atmosphereFrame.baseY,
    reliefMix: v.reliefMix,
    lineGain: v.lineGain,
  }
}

function copyInto(dst: LookValues, src: LookValues) {
  lerpLook(src, src, 0, dst)
}

export function LookDriver() {
  const lastPublish = useRef({ t: 0, extent: 0, baseY: Number.NaN })

  // snap to the current style on mount (no transition at load)
  useLayoutEffect(() => {
    const style = useStore.getState().visualStyle
    look.style = style
    look.target = cloneLook(LOOK_VALUES[style])
    look.from = cloneLook(LOOK_VALUES[style])
    copyInto(look.current, look.target)
    look.progress = 1
    look.version++
    useSceneStore.getState().setEnv(envOf(look.current))
  }, [])

  useFrame((_, dt) => {
    const style = useStore.getState().visualStyle
    if (style !== look.style) {
      look.from = cloneLook(look.current)
      look.target = cloneLook(LOOK_VALUES[style])
      look.style = style
      look.progress = reducedMotion() ? 1 : 0
      look.version++
      if (look.progress >= 1) copyInto(look.current, look.target)
      useSceneStore.getState().setEnv(envOf(look.target))
    }
    const lp = lastPublish.current
    if (look.progress < 1) {
      look.progress = Math.min(1, look.progress + Math.min(dt, 0.1) / TRANSITION_S)
      lerpLook(look.from, look.target, ease(look.progress), look.current)
      if (look.progress >= 1) useSceneStore.getState().setEnv(envOf(look.current))
    }
    // fog frame changes (new incident / exaggeration): republish so fog-matching materials stay in sync
    if (lp.extent !== atmosphereFrame.extent || Math.abs(lp.baseY - atmosphereFrame.baseY) > 0.5) {
      lp.extent = atmosphereFrame.extent
      lp.baseY = atmosphereFrame.baseY
      useSceneStore.getState().setEnv(envOf(look.progress < 1 ? look.target : look.current))
    }
  }, -10)
  return null
}
