// GPU bake of terrain lighting terms that only change with the sun direction or the vertical exaggeration
// (render grid, plane UV, RGBA8):
//   r = soft sun visibility: heightfield ray-march toward the sun with a penumbra from an enlarged sun disc
//       (ridges cast long soft shadows across valleys; 0 shadow .. 1 lit),
//   g = multi-scale cavity: 0.5 flat, < 0.5 gullies / crevices, > 0.5 ridges and crests.
// Two render targets let the terrain cross-fade between the previous and the new sun during a style transition.
import * as THREE from 'three'
import type { Vec3 } from '../look'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uElev;
  uniform vec2 uTexel;
  uniform float uExtent;
  uniform float uExag;
  uniform vec3 uSunDir;
  uniform float uSunRadius;   // effective angular radius of the sun disc (rad) -> penumbra width
  uniform float uMaxDist;     // metres
  varying vec2 vUv;

  float H(vec2 uv) { return texture2D(uElev, uv).r * uExag; }

  void main() {
    float h0 = H(vUv);
    float res = uExtent * uTexel.x;

    // ---- soft sun visibility
    float horiz = length(uSunDir.xz);
    vec2 dirUv = horiz > 1e-5 ? vec2(uSunDir.x, -uSunDir.z) / horiz : vec2(0.0);
    float tanSun = uSunDir.y / max(horiz, 1e-4);
    float vis = 1.0;
    float t = res * 0.9;
    for (int i = 0; i < 110; i++) {
      vec2 uv = vUv + dirUv * (t / uExtent);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || t > uMaxDist) break;
      float clearance = h0 + t * tanSun + res * 0.05 - H(uv);
      // angle of the occluder edge seen from the point, relative to the sun disc
      vis = min(vis, 0.5 + 0.5 * (clearance / t) / uSunRadius);
      if (vis <= 0.0) break;
      t = t * 1.055 + res * 0.35;
    }
    vis = clamp(vis, 0.0, 1.0);
    vis = vis * vis * (3.0 - 2.0 * vis);

    // ---- multi-scale cavity (difference to the mean of a ring of samples)
    float cav = 0.0;
    float rs[3];
    rs[0] = 1.5; rs[1] = 5.0; rs[2] = 14.0;
    float ws[3];
    ws[0] = 1.0 / 6.0; ws[1] = 1.0 / 18.0; ws[2] = 1.0 / 46.0;
    for (int k = 0; k < 3; k++) {
      float acc = 0.0;
      for (int j = 0; j < 8; j++) {
        float a = float(j) * 0.78539816 + float(k) * 0.3;
        acc += H(vUv + vec2(cos(a), sin(a)) * rs[k] * uTexel);
      }
      cav += (acc / 8.0 - h0) * ws[k];
    }
    float cavity = clamp(0.5 - cav * 0.22, 0.0, 1.0);

    gl_FragColor = vec4(vis, cavity, 0.0, 1.0);
  }
`

export class SunBaker {
  readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: THREE.ShaderMaterial
  private readonly quad: THREE.Mesh

  constructor(size = 1024) {
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(size, size, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      })
      rt.texture.colorSpace = THREE.NoColorSpace
      rt.texture.name = 'terrain_sun_bake'
      return rt
    }
    this.targets = [make(), make()]
    this.material = new THREE.ShaderMaterial({
      name: 'fire3d-sun-bake',
      vertexShader,
      fragmentShader,
      uniforms: {
        uElev: { value: null },
        uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
        uExtent: { value: 12000 },
        uExag: { value: 1.5 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunRadius: { value: 0.045 },
        uMaxDist: { value: 6000 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  /** Render the bake for the given inputs into targets[index]. */
  bake(renderer: THREE.WebGLRenderer, index: 0 | 1, elevation: THREE.Texture, elevWidth: number, extent: number, exaggeration: number, sunDir: Vec3): THREE.Texture {
    const u = this.material.uniforms
    u.uElev.value = elevation
    ;(u.uTexel.value as THREE.Vector2).set(1 / elevWidth, 1 / elevWidth)
    u.uExtent.value = extent
    u.uExag.value = exaggeration
    ;(u.uSunDir.value as THREE.Vector3).set(sunDir[0], sunDir[1], sunDir[2]).normalize()
    u.uMaxDist.value = Math.min(9000, extent * 0.5)
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    const prevXr = renderer.xr.enabled
    renderer.xr.enabled = false
    renderer.autoClear = true
    renderer.setRenderTarget(this.targets[index])
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(prevTarget)
    renderer.autoClear = prevAutoClear
    renderer.xr.enabled = prevXr
    return this.targets[index].texture
  }

  dispose(): void {
    this.targets[0].dispose()
    this.targets[1].dispose()
    this.material.dispose()
    this.quad.geometry.dispose()
  }
}
