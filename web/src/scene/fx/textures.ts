// Procedural textures for the effects: a 2x2 atlas of soft smoke puffs (fractal noise, domain warped, circular
// falloff so sprites can rotate freely) and a 2-cell aircraft glyph atlas (fixed-wing, rotor) drawn on a canvas.
import * as THREE from 'three'

function valueNoise(seed: number): (x: number, y: number) => number {
  const perm = new Uint8Array(512)
  let s = seed >>> 0
  for (let i = 0; i < 256; i++) perm[i] = i
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    const t = perm[i]
    perm[i] = perm[j]
    perm[j] = t
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i]
  const val = (x: number, y: number) => perm[(perm[x & 255] + y) & 255] / 255
  return (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a = val(xi, yi)
    const b = val(xi + 1, yi)
    const c = val(xi, yi + 1)
    const d = val(xi + 1, yi + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
}

let smokeAtlas: THREE.DataTexture | null = null

/** 256x256 single-channel atlas, 4 puff variants of 128 px (density in R). Shared, created once. */
export function getSmokeAtlas(): THREE.DataTexture {
  if (smokeAtlas) return smokeAtlas
  const S = 128
  const W = S * 2
  const out = new Uint8Array(W * W)
  for (let v = 0; v < 4; v++) {
    const n1 = valueNoise(1013 + v * 77)
    const n2 = valueNoise(4421 + v * 31)
    const ox = (v % 2) * S
    const oy = Math.floor(v / 2) * S
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const px = (x + 0.5) / S - 0.5
        const py = (y + 0.5) / S - 0.5
        const r = Math.hypot(px, py) * 2
        // domain warp for billowy edges
        const wx = (n2(px * 4 + 7, py * 4 + 3) - 0.5) * 0.35
        const wy = (n2(px * 4 + 19, py * 4 + 11) - 0.5) * 0.35
        let f = 0
        let amp = 0.55
        let freq = 3
        for (let o = 0; o < 5; o++) {
          f += amp * n1((px + wx) * freq + 13.1 * o, (py + wy) * freq + 7.7 * o)
          amp *= 0.52
          freq *= 2.03
        }
        const rr = r + (wx + wy) * 0.6
        const fall = Math.max(0, 1 - rr)
        const body = fall * fall * (3 - 2 * fall)
        let d = body * (0.35 + 1.1 * f) - 0.12
        d = Math.min(1, Math.max(0, d * 1.25))
        if (r > 0.98) d = 0
        out[(oy + y) * W + ox + x] = Math.round(d * 255)
      }
    }
  }
  const tex = new THREE.DataTexture(out, W, W, THREE.RedFormat, THREE.UnsignedByteType)
  tex.unpackAlignment = 1
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  smokeAtlas = tex
  return tex
}

let glyphAtlas: THREE.Texture | null = null

/** 128x64 alpha atlas: left cell fixed-wing (nose toward +y / top), right cell rotorcraft. Shared, created once. */
export function getAircraftGlyphs(): THREE.Texture {
  if (glyphAtlas) return glyphAtlas
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // fixed wing (airtanker silhouette), cell centre (32, 32)
    ctx.beginPath()
    ctx.moveTo(32, 6) // nose
    ctx.quadraticCurveTo(35.5, 9, 35.5, 16)
    ctx.lineTo(35.5, 25)
    ctx.lineTo(58, 33) // right wing tip
    ctx.lineTo(58, 37)
    ctx.lineTo(35.5, 33.5)
    ctx.lineTo(35, 47)
    ctx.lineTo(44, 52) // right stabiliser
    ctx.lineTo(44, 55)
    ctx.lineTo(32, 53)
    ctx.lineTo(20, 55)
    ctx.lineTo(20, 52)
    ctx.lineTo(29, 47)
    ctx.lineTo(28.5, 33.5)
    ctx.lineTo(6, 37)
    ctx.lineTo(6, 33)
    ctx.lineTo(28.5, 25)
    ctx.lineTo(28.5, 16)
    ctx.quadraticCurveTo(28.5, 9, 32, 6)
    ctx.closePath()
    ctx.fill()
    // rotorcraft, cell centre (96, 32): rotor disc ring + blades + fuselage + tail boom
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    ctx.arc(96, 28, 21, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(96 - 19, 28 - 7)
    ctx.lineTo(96 + 19, 28 + 7)
    ctx.moveTo(96 - 7, 28 + 19)
    ctx.lineTo(96 + 7, 28 - 19)
    ctx.stroke()
    ctx.beginPath()
    ctx.ellipse(96, 30, 6, 10, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(96, 38)
    ctx.lineTo(96, 58)
    ctx.moveTo(90, 57)
    ctx.lineTo(102, 57)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  glyphAtlas = tex
  return tex
}
