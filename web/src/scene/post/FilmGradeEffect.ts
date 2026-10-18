// Filmic tone mapping + grade (SPEC 9.0: "Tone mapping (AgX or ACES) with a filmic grade: lifted green-black
// shadows, warm highlights"). One postprocessing Effect: exposure -> AgX / ACES (blendable for style transitions)
// -> display-space contrast, shadow lift toward a green-black, warm highlight gain, saturation -> back to linear.
import { BlendFunction, Effect } from 'postprocessing'
import * as THREE from 'three'

const fragmentShader = /* glsl */ `
#include <tonemapping_pars_fragment>
uniform float exposure;
uniform float agx;
uniform vec3 lift;
uniform float liftAmount;
uniform vec3 gain;
uniform float saturation;
uniform float contrast;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 hdr = max(inputColor.rgb, 0.0) * exposure;
  vec3 tm = mix(ACESFilmicToneMapping(hdr * 0.6), AgXToneMapping(hdr), agx);
  vec3 d = pow(clamp(tm, 0.0, 1.0), vec3(1.0 / 2.2));
  // gentle S-curve around the mid tones
  vec3 s = d * d * (3.0 - 2.0 * d);
  d = mix(d, s, clamp(contrast - 1.0, 0.0, 1.0) * 1.6);
  // shadows lifted toward the green-black of the atmosphere, highlights tinted warm
  float luma = dot(d, vec3(0.2126, 0.7152, 0.0722));
  d += lift * liftAmount * pow(1.0 - luma, 3.0);
  d *= mix(vec3(1.0), gain, smoothstep(0.35, 1.0, luma));
  luma = dot(d, vec3(0.2126, 0.7152, 0.0722));
  d = mix(vec3(luma), d, saturation);
  outputColor = vec4(pow(clamp(d, 0.0, 1.0), vec3(2.2)), inputColor.a);
}
`

export class FilmGradeEffect extends Effect {
  constructor() {
    super('FilmGradeEffect', fragmentShader, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['exposure', new THREE.Uniform(1)],
        ['agx', new THREE.Uniform(1)],
        ['lift', new THREE.Uniform(new THREE.Vector3())],
        ['liftAmount', new THREE.Uniform(1)],
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['saturation', new THREE.Uniform(1)],
        ['contrast', new THREE.Uniform(1)],
      ]),
    })
  }

  set(values: { exposure: number; agx: number; lift: [number, number, number]; liftAmount: number; gain: [number, number, number]; saturation: number; contrast: number }) {
    const u = this.uniforms
    u.get('exposure')!.value = values.exposure
    u.get('agx')!.value = values.agx
    ;(u.get('lift')!.value as THREE.Vector3).set(values.lift[0], values.lift[1], values.lift[2])
    u.get('liftAmount')!.value = values.liftAmount
    ;(u.get('gain')!.value as THREE.Vector3).set(values.gain[0], values.gain[1], values.gain[2])
    u.get('saturation')!.value = values.saturation
    u.get('contrast')!.value = values.contrast
  }
}
