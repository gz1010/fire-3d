// Sky / background dome (SPEC 9.3): a camera-centred sphere on the far plane, coloured by the shared atmosphere
// function (deep green-black gradient; a warm sun glow and disc in the realistic look). Drawn after the opaque
// terrain with a depth test, so only uncovered pixels run its shader; never writes depth.
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphereUniforms, updateAtmosphereUniforms } from './atmosphere'

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // on the far plane
  }
`

const fragmentShader = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform float uSunDisc;
  varying vec3 vDir;
  float skyHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main() {
    vec3 dir = normalize(vDir);
    vec3 c = atmSky(dir);
    // sun disc + tight corona (only above the horizon; blooms in the realistic look)
    float mu = max(dot(dir, uSunDir), 0.0);
    float above = smoothstep(-0.01, 0.02, dir.y);
    c += uSunGlowColor * uSunDisc * above * (smoothstep(0.99985, 0.99993, mu) * 14.0 + pow(mu, 600.0) * 2.5);
    // dither against banding in the dark gradient
    c += (skyHash(gl_FragCoord.xy) - 0.5) * 0.0025;
    gl_FragColor = vec4(max(c, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function Sky() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        name: 'fire3d-sky',
        vertexShader,
        fragmentShader,
        uniforms: { ...atmosphereUniforms(), uSunDisc: { value: 0 } },
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        depthFunc: THREE.LessEqualDepth,
        fog: false,
      }),
    [],
  )
  const geometry = useMemo(() => new THREE.SphereGeometry(1, 48, 24), [])
  useEffect(
    () => () => {
      material.dispose()
      geometry.dispose()
    },
    [material, geometry],
  )
  const meshRef = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => {
    updateAtmosphereUniforms(material.uniforms)
    // the disc reads only where the glow is strong (realistic golden hour)
    material.uniforms.uSunDisc.value = Math.max(0, Math.min(1, (material.uniforms.uSunGlow.value as number) - 0.8))
    const mesh = meshRef.current
    if (mesh) {
      mesh.position.copy(camera.position)
      mesh.scale.setScalar(((camera as THREE.PerspectiveCamera).far || 100000) * 0.5)
    }
  })
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={1000}
      frustumCulled={false}
      name="fire3d-sky"
    />
  )
}
