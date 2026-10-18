// Draped screen-space "ribbon" lines and screen-sized sprites.
// Ribbons: every polyline segment becomes a quad expanded in screen space (constant pixel width, anti-aliased),
// with vertices holding raw elevation (m) so the shared uExag uniform drapes them at any exaggeration. A small
// depth bias keeps them on top of the terrain without z-fighting. Sprites: instanced quads sized in pixels around a
// projected centre (no gl_PointSize limits).
import * as THREE from 'three'

/** One polyline: xyz triples (x, elevation m, z). `data` = 4 floats per vertex, or `constData` for all vertices. */
export interface RibbonLine {
  pts: ArrayLike<number>
  closed?: boolean
  data?: ArrayLike<number>
  constData?: readonly [number, number, number, number]
}

/** Build the ribbon geometry of many polylines (one draw call). Attributes: position (own end), aOther (other end),
 *  aSide (±1), aEnd (0 start / 1 end of the segment), aAlong (metres along the line), aData (vec4). */
export function ribbonGeometry(lines: RibbonLine[]): THREE.BufferGeometry {
  let segs = 0
  for (const l of lines) {
    const n = Math.floor(l.pts.length / 3)
    if (n >= 2) segs += l.closed ? n : n - 1
  }
  const nv = segs * 4
  const pos = new Float32Array(nv * 3)
  const oth = new Float32Array(nv * 3)
  const side = new Float32Array(nv)
  const end = new Float32Array(nv)
  const along = new Float32Array(nv)
  const data = new Float32Array(nv * 4)
  const index = nv > 65535 ? new Uint32Array(segs * 6) : new Uint16Array(segs * 6)
  let v = 0
  let s = 0
  for (const l of lines) {
    const p = l.pts
    const n = Math.floor(p.length / 3)
    if (n < 2) continue
    const m = l.closed ? n : n - 1
    let dist = 0
    for (let k = 0; k < m; k++) {
      const a = k
      const b = (k + 1) % n
      const ax = p[a * 3]
      const ay = p[a * 3 + 1]
      const az = p[a * 3 + 2]
      const bx = p[b * 3]
      const by = p[b * 3 + 1]
      const bz = p[b * 3 + 2]
      const len = Math.hypot(bx - ax, bz - az)
      for (let q = 0; q < 4; q++) {
        const isEnd = q >= 2
        const o3 = (v + q) * 3
        pos[o3] = isEnd ? bx : ax
        pos[o3 + 1] = isEnd ? by : ay
        pos[o3 + 2] = isEnd ? bz : az
        oth[o3] = isEnd ? ax : bx
        oth[o3 + 1] = isEnd ? ay : by
        oth[o3 + 2] = isEnd ? az : bz
        side[v + q] = q % 2 === 0 ? -1 : 1
        end[v + q] = isEnd ? 1 : 0
        along[v + q] = isEnd ? dist + len : dist
        const vi = isEnd ? b : a
        const o4 = (v + q) * 4
        if (l.data) {
          data[o4] = l.data[vi * 4]
          data[o4 + 1] = l.data[vi * 4 + 1]
          data[o4 + 2] = l.data[vi * 4 + 2]
          data[o4 + 3] = l.data[vi * 4 + 3]
        } else if (l.constData) {
          data[o4] = l.constData[0]
          data[o4 + 1] = l.constData[1]
          data[o4 + 2] = l.constData[2]
          data[o4 + 3] = l.constData[3]
        }
      }
      const i6 = s * 6
      index[i6] = v
      index[i6 + 1] = v + 2
      index[i6 + 2] = v + 1
      index[i6 + 3] = v + 1
      index[i6 + 4] = v + 2
      index[i6 + 5] = v + 3
      v += 4
      s++
      dist += len
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aOther', new THREE.BufferAttribute(oth, 3))
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1))
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1))
  g.setAttribute('aData', new THREE.BufferAttribute(data, 4))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
  return g
}

/** Subdivide a local [x, z] polyline (flat pairs) so no piece is longer than `maxSeg` metres and drape it:
 *  returns xyz triples with the terrain elevation (m). Closed rings repeat no vertex (use `closed` in RibbonLine). */
export function drape(xz: ArrayLike<number>, heightAt: (x: number, z: number) => number, maxSeg: number, closed = false): Float32Array {
  const n = Math.floor(xz.length / 2)
  if (n === 0) return new Float32Array(0)
  const m = closed ? n : n - 1
  let total = n
  for (let k = 0; k < m; k++) {
    const a = k
    const b = (k + 1) % n
    const len = Math.hypot(xz[b * 2] - xz[a * 2], xz[b * 2 + 1] - xz[a * 2 + 1])
    total += Math.max(0, Math.ceil(len / maxSeg) - 1)
  }
  const out = new Float32Array(total * 3)
  let o = 0
  const push = (x: number, z: number) => {
    out[o++] = x
    out[o++] = heightAt(x, z)
    out[o++] = z
  }
  for (let k = 0; k < n; k++) {
    const ax = xz[k * 2]
    const az = xz[k * 2 + 1]
    push(ax, az)
    if (k === n - 1 && !closed) break
    const b = (k + 1) % n
    const bx = xz[b * 2]
    const bz = xz[b * 2 + 1]
    const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / maxSeg))
    for (let q = 1; q < pieces; q++) push(ax + ((bx - ax) * q) / pieces, az + ((bz - az) * q) / pieces)
  }
  return o === out.length ? out : out.subarray(0, o)
}

/** Vertex GLSL for ribbons (needs GLSL_COMMON + GLSL_VERT). fxRibbon(widthCssPx, liftM, bias) returns clip coords. */
export const GLSL_RIBBON_VERT = /* glsl */ `
attribute vec3 aOther;
attribute float aSide;
attribute float aEnd;
attribute float aAlong;
attribute vec4 aData;
varying float vSide;
varying vec2 vHalf; // x: visual half width (px), y: expanded half width incl. AA margin (px)
varying float vAlong;
vec4 fxRibbon(float widthCss, float lift, float bias) {
  vec3 wa = vec3(position.x, position.y * uExag + lift, position.z);
  vec3 wb = vec3(aOther.x, aOther.y * uExag + lift, aOther.z);
  vec4 ca = projectionMatrix * fxViewPos(wa, bias);
  vec4 cb = projectionMatrix * fxViewPos(wb, bias);
  vSide = aSide;
  vAlong = aAlong;
  if (ca.w < 1.0e-3) { vHalf = vec2(0.0, 1.0); return vec4(2.0, 2.0, 2.0, 1.0); }
  if (cb.w < 1.0e-3) cb = mix(ca, cb, (ca.w - 1.0e-3) / max(ca.w - cb.w, 1.0e-6));
  vec2 sa = ca.xy / ca.w * uViewport;
  vec2 sb = cb.xy / cb.w * uViewport;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1.0e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) * (aEnd > 0.5 ? -1.0 : 1.0);
  float halfVis = max(0.5 * widthCss * uPixelRatio, 0.35);
  float halfExp = halfVis + 1.0;
  vHalf = vec2(halfVis, halfExp);
  ca.xy += nrm * (aSide * halfExp * 2.0 / uViewport) * ca.w;
  return ca;
}
`

/** Fragment GLSL for ribbons: anti-aliased coverage and a soft glow profile across the width. */
export const GLSL_RIBBON_FRAG = /* glsl */ `
varying float vSide;
varying vec2 vHalf;
varying float vAlong;
float fxRibbonAlpha() { float d = abs(vSide) * vHalf.y; return clamp(vHalf.x - d + 0.5, 0.0, 1.0); }
float fxRibbonGlow() { float d = abs(vSide) * vHalf.y; return exp(-(d * d) / max(vHalf.x * vHalf.x * 1.6, 0.3)); }
`

/** Instanced screen sprite: a unit quad (position.xy in [-1, 1]) placed around a projected centre. */
export function spriteGeometry(instances: number, attrs: Record<string, { array: Float32Array; size: number }>): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, new THREE.InstancedBufferAttribute(a.array, a.size))
  g.instanceCount = instances
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7)
  return g
}

/** Vertex GLSL for sprites (needs GLSL_COMMON). fxSprite(world, halfSizeDevicePx, bias) returns clip coords;
 *  vQuad holds the corner in [-1, 1]. */
export const GLSL_SPRITE_VERT = /* glsl */ `
varying vec2 vQuad;
vec4 fxSprite(vec3 world, float halfPx, float bias) {
  vec4 c = projectionMatrix * fxViewPos(world, bias);
  vQuad = position.xy;
  if (c.w < 1.0e-3) return vec4(2.0, 2.0, 2.0, 1.0);
  c.xy += position.xy * (halfPx * 2.0 / uViewport) * c.w;
  return c;
}
`
