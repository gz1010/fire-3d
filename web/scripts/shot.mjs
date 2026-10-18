#!/usr/bin/env node
// Screenshot tool (SPEC 10): headless installed Chrome via Playwright.
//
//   node scripts/shot.mjs <url> <out.png> [--wait 6000] [--w 1720] [--h 1080] [--dpr 1]
//        [--eval "<js, may be async; runs after load>"] [--eval-after-wait "<js>"] [--settle 1200]
//        [--backend auto|gpu|swiftshader] [--fail-on-error]
//
// It first tries the GPU (ANGLE Metal) and checks that WebGL2 really works; otherwise it falls back to SwiftShader.
// Prints the WebGL backend, console errors/warnings and page errors, then writes the PNG.
// --eval code may be an expression or statements, e.g. --eval "window.__store.getState().setVisualStyle('parametric')".
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const USAGE = 'usage: node scripts/shot.mjs <url> <out.png> [--wait ms] [--w px] [--h px] [--dpr n] [--eval js] [--eval-after-wait js] [--settle ms] [--backend auto|gpu|swiftshader] [--fail-on-error]'

function parseArgs(argv) {
  const opts = { wait: 6000, w: 1720, h: 1080, dpr: 1, settle: 1200, backend: 'auto', eval: null, evalAfterWait: null, failOnError: false }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`)
      return argv[++i]
    }
    switch (a) {
      case '--wait': opts.wait = Number(next()); break
      case '--w': opts.w = Number(next()); break
      case '--h': opts.h = Number(next()); break
      case '--dpr': opts.dpr = Number(next()); break
      case '--settle': opts.settle = Number(next()); break
      case '--backend': opts.backend = next(); break
      case '--eval': opts.eval = next(); break
      case '--eval-after-wait': opts.evalAfterWait = next(); break
      case '--fail-on-error': opts.failOnError = true; break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
        pos.push(a)
    }
  }
  if (pos.length !== 2) throw new Error(USAGE)
  return { url: pos[0], out: resolve(pos[1]), ...opts }
}

const PROFILES = {
  gpu: { name: 'GPU (ANGLE Metal)', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] },
  swiftshader: { name: 'SwiftShader (software)', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl'] },
}

/** Create a WebGL2 context, draw one frame, read back a pixel; return renderer info or null. */
async function probeWebGL(browser) {
  const page = await browser.newPage()
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = c.height = 8
      const gl = c.getContext('webgl2')
      if (!gl) return null
      gl.clearColor(0.25, 0.5, 0.75, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const px = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      if (Math.abs(px[1] - 128) > 3) return null
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
        vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
        floatLinear: Boolean(gl.getExtension('OES_texture_float_linear')),
        colorBufferFloat: Boolean(gl.getExtension('EXT_color_buffer_float')),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      }
    })
  } catch {
    return null
  } finally {
    await page.close()
  }
}

async function launch(backend) {
  const order = backend === 'gpu' ? ['gpu'] : backend === 'swiftshader' ? ['swiftshader'] : ['gpu', 'swiftshader']
  for (const key of order) {
    const profile = PROFILES[key]
    let browser
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true, args: profile.args })
    } catch (e) {
      console.warn(`[shot] could not launch Chrome with ${profile.name}: ${e.message.split('\n')[0]}`)
      continue
    }
    const info = await probeWebGL(browser)
    const software = info && /swiftshader|llvmpipe|software/i.test(info.renderer)
    if (info && (key !== 'gpu' || !software)) return { browser, profile, info }
    console.warn(`[shot] ${profile.name}: ${info ? `got software renderer (${info.renderer})` : 'WebGL2 unavailable'}; trying next backend`)
    await browser.close()
  }
  throw new Error('no working WebGL2 backend (GPU and SwiftShader both failed)')
}

async function runJs(page, code, label) {
  if (!code) return
  let result
  try {
    result = await page.evaluate(`(async () => (${code}))()`)
  } catch (e) {
    if (!/SyntaxError/.test(String(e))) throw e
    result = await page.evaluate(`(async () => { ${code} })()`)
  }
  if (result !== undefined) console.log(`[shot] ${label} ->`, typeof result === 'object' ? JSON.stringify(result).slice(0, 500) : result)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { browser, profile, info } = await launch(opts.backend)
  console.log(`[shot] backend: ${profile.name} | renderer: ${info.renderer} | vendor: ${info.vendor} | float-linear: ${info.floatLinear} | max texture: ${info.maxTexture}`)
  const messages = []
  const pageErrors = []
  const failed = []
  try {
    const context = await browser.newContext({ viewport: { width: opts.w, height: opts.h }, deviceScaleFactor: opts.dpr })
    const page = await context.newPage()
    page.on('console', (msg) => {
      const t = msg.type()
      if (t === 'error' || t === 'warning') messages.push(`${t}: ${msg.text()}`)
    })
    page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)))
    page.on('requestfailed', (req) => failed.push(`${req.failure()?.errorText ?? 'failed'} ${req.url()}`))
    const t0 = Date.now()
    await page.goto(opts.url, { waitUntil: 'load', timeout: 60_000 })
    await runJs(page, opts.eval, '--eval')
    await page.waitForTimeout(opts.wait)
    if (opts.evalAfterWait) {
      await runJs(page, opts.evalAfterWait, '--eval-after-wait')
      await page.waitForTimeout(opts.settle)
    }
    mkdirSync(dirname(opts.out), { recursive: true })
    await page.screenshot({ path: opts.out })
    console.log(`[shot] wrote ${opts.out} (${opts.w}x${opts.h} @${opts.dpr}x) after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  } finally {
    await browser.close()
  }
  const uniq = (a) => [...new Set(a)]
  console.log(`[shot] console errors/warnings: ${messages.length}`)
  for (const m of uniq(messages).slice(0, 40)) console.log(`  ${m.slice(0, 400)}`)
  console.log(`[shot] page errors: ${pageErrors.length}`)
  for (const e of uniq(pageErrors).slice(0, 20)) console.log(`  ${e.slice(0, 800)}`)
  if (failed.length) {
    console.log(`[shot] failed requests: ${failed.length}`)
    for (const f of uniq(failed).slice(0, 20)) console.log(`  ${f}`)
  }
  if (opts.failOnError && (pageErrors.length || messages.some((m) => m.startsWith('error')))) process.exit(1)
}

main().catch((e) => {
  console.error(`[shot] ${e.message}`)
  process.exit(2)
})
