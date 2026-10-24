import { describe, expect, it } from 'vitest'
import { defaultTint, VIGNETTE_MAX, VIGNETTE_MIN, VIGNETTE_STEP, vignetteChanged, vignetteGeometry, vignetteStrength } from './atmosphere'

/** Node's fs without @types/node (tests run in Node; the app never imports this). */
interface FsLike {
  readFileSync(p: URL, enc: string): string
}
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as FsLike
const atmosphereCss = fs.readFileSync(new URL('../styles/atmosphere.css', import.meta.url), 'utf8')

describe('globe-like vignette', () => {
  it('strength = clamp((zoom − 3) / 7, .25, 1): faint on the national map, full from z10', () => {
    expect(vignetteStrength(3)).toBe(VIGNETTE_MIN)
    expect(vignetteStrength(4)).toBe(VIGNETTE_MIN) // (4 − 3) / 7 = .14 → .25
    expect(vignetteStrength(4.75)).toBeCloseTo(0.25, 9)
    expect(vignetteStrength(6.5)).toBeCloseTo(0.5, 9)
    expect(vignetteStrength(10)).toBe(VIGNETTE_MAX)
    expect(vignetteStrength(15)).toBe(VIGNETTE_MAX)
    expect(vignetteStrength(0)).toBe(VIGNETTE_MIN)
    expect(vignetteStrength(null)).toBe(VIGNETTE_MIN)
    expect(vignetteStrength(Number.NaN)).toBe(VIGNETTE_MIN)
  })

  it('is written only when it moves by .02 or more, or reaches either end', () => {
    expect(VIGNETTE_STEP).toBe(0.02)
    expect(vignetteChanged(null, 0.25)).toBe(true)
    expect(vignetteChanged(0.5, 0.5)).toBe(false)
    expect(vignetteChanged(0.5, 0.51)).toBe(false)
    expect(vignetteChanged(0.5, 0.52)).toBe(true)
    expect(vignetteChanged(0.5, 0.48)).toBe(true)
    expect(vignetteChanged(0.99, 1)).toBe(true)
    expect(vignetteChanged(0.26, 0.25)).toBe(true)
    // a slow zoom from z3 to z10 in tiny steps writes about 38 times, not once per frame
    let prev: number | null = null
    let writes = 0
    for (let i = 0; i <= 700; i++) {
      const s = vignetteStrength(3 + i / 100)
      if (vignetteChanged(prev, s)) {
        prev = s
        writes++
      }
    }
    expect(prev).toBe(1)
    expect(writes).toBeGreaterThan(30)
    expect(writes).toBeLessThan(45)
  })

  it('is a circle on the safe area’s centre with half its shorter side as radius', () => {
    // Command at 1440 × 1000 with a readout on the left, Official now on the right, timeline below
    expect(vignetteGeometry(1440, 1000, { top: 100, right: 440, bottom: 240, left: 480 })).toEqual({ x: 740, y: 430, r: 260 })
    // no chrome: the whole map
    expect(vignetteGeometry(1440, 1000, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual({ x: 720, y: 500, r: 500 })
  })

  it('scales the insets down like the map padding and never shrinks below a fifth of the map', () => {
    // a phone whose chrome would cover the whole height: at least 120 px stay free
    const g = vignetteGeometry(390, 844, { top: 500, right: 0, bottom: 500, left: 0 })
    expect(g.y).toBeCloseTo(422, 0)
    expect(g.r).toBeCloseTo(78, 0) // 390 / 5
    expect(vignetteGeometry(0, 0, { top: 10, right: 10, bottom: 10, left: 10 })).toEqual({ x: 0, y: 0, r: 0 })
  })

  it('the tint each view gets by default: the national map greyer than a fire view or Command', () => {
    expect(defaultTint('overview')).toBe('overview')
    expect(defaultTint('fire')).toBe('fire')
    expect(defaultTint('command')).toBe('fire')
  })

  it('the stylesheet: the vignette reads the variables, the edges use the screens’ stops, nothing animates under reduced motion, nothing catches the pointer', () => {
    const css = atmosphereCss.replace(/\s+/g, ' ')
    expect(css).toMatch(/opacity: var\(--mw-vignette\)/)
    expect(css).toMatch(/circle at var\(--mw-vig-x\) var\(--mw-vig-y\)/)
    expect(css).toMatch(/calc\(var\(--mw-vig-r\) \* 0\.6\)/)
    // CommandView.dc.html: left 540 .93/.72@62 %, right 500, bottom 230 .96, top 120 .9
    expect(css).toMatch(/rgba\(12, 12, 12, 0\.93\) 0%, rgba\(12, 12, 12, 0\.72\) 62%, rgba\(12, 12, 12, 0\) 100%\) left top \/ min\(540px/)
    expect(css).toMatch(/right top \/ min\(500px/)
    expect(css).toMatch(/rgba\(12, 12, 12, 0\.96\) 0%, rgba\(12, 12, 12, 0\) 100%\) left bottom \/ 100% 230px/)
    expect(css).toMatch(/rgba\(12, 12, 12, 0\.9\) 0%, rgba\(12, 12, 12, 0\) 100%\) left top \/ 100% 120px/)
    // FireView.dc.html: left 560 .9/.72@55 %
    expect(css).toMatch(/\[data-edges='fire'\]::after \{ background: linear-gradient\(90deg, rgba\(12, 12, 12, 0\.9\) 0%, rgba\(12, 12, 12, 0\.72\) 55%, rgba\(12, 12, 12, 0\) 100%\) left top \/ min\(560px/)
    // Main.dc.html: top 200 .85, bottom 200 .9 (rgba 14)
    expect(css).toMatch(/rgba\(14, 14, 14, 0\.85\) 0%, rgba\(14, 14, 14, 0\) 100%\) left top \/ 100% min\(200px/)
    expect(css).toMatch(/rgba\(14, 14, 14, 0\.9\) 0%, rgba\(14, 14, 14, 0\) 100%\) left bottom \/ 100% min\(200px/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.mw-atmo::before, \.mw-atmo::after \{ transition: none; \} \}/)
    expect(css).toMatch(/\.mw-atmo \{[^}]*pointer-events: none;/)
    expect(css).not.toMatch(/\.mw-atmo \{[^}]*z-index/)
  })
})
