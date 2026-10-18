// Atmosphere shared by the sky dome, the terrain and (optionally) any other scene material: a sky colour per view
// direction, exponential height fog (aerial perspective) and the AOI edge fade. The terrain fades into exactly the
// colour the dome shows behind it, so the square AOI edge never reads as a hard border (SPEC 9.0).
//
// Usage in a ShaderMaterial: spread atmosphereUniforms() into the uniforms, prepend ATMOSPHERE_GLSL to the fragment
// shader and call updateAtmosphereUniforms(uniforms) once per frame (it reads the current look + scene frame).
// Draped / standing objects match the terrain exactly with:
//   col = atmApply(col, cameraPosition, worldPos);
//   col = mix(atmSky(normalize(worldPos - cameraPosition)), col, atmEdgeFade(planeUv, 0.08));
import * as THREE from 'three'
import { look } from '../look'

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunGlowColor;
uniform float uSunGlow;
uniform float uFogDensity; // extinction per metre at uFogBaseY
uniform float uFogFalloff; // 1 / height scale (per metre)
uniform float uFogBaseY;   // world y (exaggerated) of the valley floor

// Sky / haze colour seen in direction dir (unit vector, world space). No sun disc.
vec3 atmSky(vec3 dir) {
  float y = dir.y;
  vec3 c = y >= 0.0
    ? mix(uSkyHorizon, uSkyZenith, pow(clamp(y, 0.0, 1.0), 0.42))
    : mix(uSkyHorizon, uSkyGround, pow(clamp(-y * 2.4, 0.0, 1.0), 0.6));
  float mu = max(dot(dir, uSunDir), 0.0);
  float halo = pow(mu, 6.0) * 0.5 + pow(mu, 40.0) * 0.8;
  float band = exp(-abs(y - uSunDir.y * 0.35) * 4.0);
  return c + uSunGlowColor * (uSunGlow * halo * mix(0.3, 1.0, band));
}

// Transmittance of exponential height fog between the camera and world point p.
float atmTransmittance(vec3 cam, vec3 p) {
  vec3 d = p - cam;
  float dist = length(d);
  float k = uFogFalloff;
  float y0 = clamp(cam.y - uFogBaseY, -3000.0, 60000.0);
  float kdy = clamp(k * d.y, -60.0, 60.0);
  float shape = abs(kdy) > 1e-4 ? (1.0 - exp(-kdy)) / kdy : 1.0;
  float od = uFogDensity * dist * exp(-k * y0) * shape;
  return exp(-max(od, 0.0));
}

// Apply aerial perspective to a surface colour at world point p.
vec3 atmApply(vec3 color, vec3 cam, vec3 p) {
  vec3 dir = normalize(p - cam);
  return mix(atmSky(dir), color, atmTransmittance(cam, p));
}

// AOI edge fade (1 inside .. 0 at the border) on a rounded square (superellipse, n = 7) touching the AOI edges, so
// neither the edges nor the corners read as a hard square. uv = plane UV (0..1); width = fade width (~0.08).
float atmEdgeFade(vec2 uv, float width) {
  vec2 e = pow(abs(uv * 2.0 - 1.0), vec2(7.0));
  float d = 1.0 - pow(e.x + e.y, 1.0 / 7.0);
  return smoothstep(0.0, width * 1.6, d);
}
`

export function atmosphereUniforms(): Record<string, THREE.IUniform> {
  return {
    uSunDir: { value: new THREE.Vector3(0.5, 0.5, 0.5).normalize() },
    uSkyZenith: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uSkyGround: { value: new THREE.Color() },
    uSunGlowColor: { value: new THREE.Color() },
    uSunGlow: { value: 0 },
    uFogDensity: { value: 1 / 20000 },
    uFogFalloff: { value: 1 / 1300 },
    uFogBaseY: { value: 0 },
  }
}

/** Scene frame the fog is scaled to (set by the terrain when an incident loads / exaggeration changes). */
export const atmosphereFrame = { extent: 12000, baseY: 0 }

/** Copy the current look into atmosphere uniforms (cheap; call every frame). */
export function updateAtmosphereUniforms(u: Record<string, THREE.IUniform>): void {
  const c = look.current
  ;(u.uSunDir.value as THREE.Vector3).set(c.sunDir[0], c.sunDir[1], c.sunDir[2])
  ;(u.uSkyZenith.value as THREE.Color).setRGB(c.skyZenith[0], c.skyZenith[1], c.skyZenith[2])
  ;(u.uSkyHorizon.value as THREE.Color).setRGB(c.skyHorizon[0], c.skyHorizon[1], c.skyHorizon[2])
  ;(u.uSkyGround.value as THREE.Color).setRGB(c.skyGround[0], c.skyGround[1], c.skyGround[2])
  ;(u.uSunGlowColor.value as THREE.Color).setRGB(c.sunGlowColor[0], c.sunGlowColor[1], c.sunGlowColor[2])
  u.uSunGlow.value = c.sunGlow
  u.uFogDensity.value = fogDensityFor(atmosphereFrame.extent, c.fogVisibility)
  u.uFogFalloff.value = 1 / Math.max(50, c.fogHeightM)
  u.uFogBaseY.value = atmosphereFrame.baseY
}

/** Extinction per metre at the valley floor for a visibility expressed as a multiple of the AOI extent. */
export function fogDensityFor(extent: number, visibility: number): number {
  return 1 / Math.max(500, extent * visibility)
}
