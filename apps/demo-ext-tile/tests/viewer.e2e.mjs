/**
 * Browser check of the viewer shell (createSlideView and its UIKit extras) on
 * a synthetic 2-channel 64 x 48 uint8 OME-Zarr store served from memory (no
 * network):
 * the status bar (credit, hover readout, fixed layout at any width), the
 * contrast box off for RGB (a 3-channel store), the channel panel reached by keyboard with visible focus, a
 * window/level drag, double-click zoom, and the side-by-side and lens compare
 * views linked to the main one.
 *
 *   bunx nx e2e demo-ext-tile      # builds first, via Nx
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
const [C, Y, X] = [2, 48, 64]
const json = (v) => Buffer.from(JSON.stringify(v))
// Long enough to truncate at 360 px.
const CREDIT = `Synthetic test store ${'with a long credit '.repeat(4)}`.trim()
// C channels: two show composited, three uint8 show as RGB.
const makeStore = (C) =>
  new Map([
    ['.zgroup', json({ zarr_format: 2 })],
    [
      '.zattrs',
      json({
        attribution: { title: CREDIT },
        multiscales: [
          {
            version: '0.4',
            axes: [
              { name: 'c', type: 'channel' },
              { name: 'y', type: 'space', unit: 'micrometer' },
              { name: 'x', type: 'space', unit: 'micrometer' },
            ],
            datasets: [
              {
                path: '0',
                coordinateTransformations: [
                  { type: 'scale', scale: [1, 0.5, 0.5] },
                ],
              },
            ],
          },
        ],
        omero: {
          channels: ['00FF00', 'FF00FF'].map((color, c) => ({
            label: `ch${c}`,
            color,
            active: true,
            window: { start: 0, end: 255, min: 0, max: 255 },
          })),
        },
      }),
    ],
    [
      '0/.zarray',
      json({
        zarr_format: 2,
        shape: [C, Y, X],
        chunks: [1, Y, X],
        dtype: '|u1',
        compressor: null,
        fill_value: 0,
        order: 'C',
        filters: null,
      }),
    ],
    ...Array.from({ length: C }, (_, c) => {
      // Channel 0 holds 3x, the others 4y.
      const chunk = new Uint8Array(Y * X)
      for (let y = 0; y < Y; y++)
        for (let x = 0; x < X; x++) chunk[y * X + x] = c ? 4 * y : 3 * x
      return [`0/${c}.0.0`, Buffer.from(chunk.buffer)]
    }),
  ])
const stores = { 's.zarr': makeStore(C), 'rgb.zarr': makeStore(3) }
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
}
let failStore = false
const server = createServer(async (req, res) => {
  const path =
    normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') ||
    'index.html'
  // GET /fail-store?on|off: the store answers 500 meanwhile (a failed open).
  if (path === 'fail-store') {
    failStore = req.url.endsWith('?on')
    return res.end()
  }
  const [name, ...key] = path.split('/')
  if (stores[name]) {
    if (failStore) return res.writeHead(500).end()
    const body = stores[name].get(key.join('/'))
    return body ? res.end(body) : res.writeHead(404).end()
  }
  try {
    const body = await readFile(join(DIST, path))
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()

const failOn = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}
const t0 = performance.now()
// E2E_BROWSER=firefox|webkit runs the same checks in those engines (#738).
const engine = process.env.E2E_BROWSER ?? 'chromium'
// PLAYWRIGHT_CHROMIUM_CHANNEL=chromium: the real GPU, where WebGPU must start.
const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine !== 'chromium'
    ? {}
    : channel
      ? { channel, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] }
      : { args: ['--enable-unsafe-swiftshader'] },
)
async function check(backend) {
  const fail = (msg) => failOn(`${backend}: ${msg}`)
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/^https:/, (route) => route.abort())
  await page.goto(
    `http://127.0.0.1:${port}/index.html?backend=${backend}&bench&url=${encodeURIComponent(`http://127.0.0.1:${port}/s.zarr/`)}`,
  )
  await page.waitForFunction(() =>
    /tiles +\d+ visible, 0 pending.*failures +0/s.test(
      document.getElementById('hud').textContent,
    ),
  )
  const got = await page.inputValue('#backend')
  // Without a real GPU (SwiftShader, CI) WebGPU falls back: only a channel run insists.
  if (got !== backend && (channel || backend === 'webgl2'))
    fail(`backend ${got}`)
  const box = await page.locator('#canvas').boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // Status bar: the credit on load, the readout while hovering, the credit
  // again on leave; the toolbar, view and bar never change size meanwhile.
  const layout = () =>
    page.evaluate(() =>
      ['header', 'main', 'footer']
        .map((s) => {
          const r = document.querySelector(s).getBoundingClientRect()
          return `${r.width}x${r.height}`
        })
        .join(' '),
    )
  const creditShown = () =>
    page.evaluate(() => {
      const credit = document.getElementById('credit')
      return !credit.hidden && document.getElementById('readout').hidden
        ? credit.textContent
        : null
    })
  const hoverKeepsLayout = async (x, y) => {
    const before = await layout()
    if ((await creditShown()) !== CREDIT) fail(`credit ${await creditShown()}`)
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.id,
      [x, y],
    )
    if (top !== 'canvas') return fail(`${top} covers the hover point`)
    await page.mouse.move(x, y)
    await page.waitForFunction(() => document.getElementById('credit').hidden)
    const during = await layout()
    const { x: fx, y: fy } = await page.locator('footer').boundingBox()
    await page.mouse.move(fx + 4, fy + 4)
    await page.waitForFunction(() => !document.getElementById('credit').hidden)
    if ((await creditShown()) !== CREDIT) fail('credit not back on leave')
    const after = await layout()
    if (during !== before || after !== before)
      fail(`layout moved on hover: ${before} | ${during} | ${after}`)
  }
  await hoverKeepsLayout(cx, cy)
  // Narrow: nothing scrolls sideways, the view keeps its room.
  await page.setViewportSize({ width: 360, height: 700 })
  const narrow = await page.evaluate(() => {
    const credit = document.getElementById('credit')
    return {
      scroll: document.documentElement.scrollWidth,
      view: document.querySelector('main').getBoundingClientRect().height,
      cut: credit.scrollWidth > credit.clientWidth,
      tooltip: credit.title,
    }
  })
  if (narrow.tooltip !== CREDIT) fail(`credit tooltip ${narrow.tooltip}`)
  if (narrow.scroll > 360 || narrow.view < 200 || !narrow.cut)
    fail(`narrow layout ${JSON.stringify(narrow)}`)
  const nbox = await page.locator('#canvas').boundingBox()
  // Clear of the overlaid panels: bottom left.
  await hoverKeepsLayout(nbox.x + 24, nbox.y + nbox.height - 24)
  await page.setViewportSize({ width: 900, height: 700 })

  // Hover readout: base pixel, the channel and its value, the level read.
  await page.mouse.move(cx, cy)
  await page.waitForFunction(() =>
    /^\d+,\d+ ch0 \d+, ch1 \d+ \(L0\)$/.test(
      document.getElementById('readout').value,
    ),
  )
  const [px, py, v0, v1] = (await page.textContent('#readout'))
    .match(/^(\d+),(\d+) ch0 (\d+), ch1 (\d+)/)
    .slice(1)
    .map(Number)
  if (v0 !== 3 * px || v1 !== 4 * py)
    fail(`readout ${await page.textContent('#readout')}`)

  // The channel panel shows for a monochrome slide, and Tab reaches it with
  // a visible focus ring.
  if (await page.locator('#channels').isHidden())
    fail('channel panel hidden for a 2-channel slide')
  await page.focus('#compare')
  let reached = null
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Tab')
    reached = await page.evaluate(() => {
      const el = document.activeElement
      if (!el?.closest('#channels') || el.tagName === 'SUMMARY') return null
      return {
        label: el.getAttribute('aria-label') ?? el.parentElement?.textContent,
        outline: getComputedStyle(el).outlineStyle,
      }
    })
  }
  if (!reached) fail('Tab never reached a channel control')
  else if (reached.outline === 'none')
    fail(`no visible focus on ${reached.label}`)

  // Plane controls: hidden for a fixed source; for one stating planes (the
  // plane contract, stubbed here) a keyboard step switches, a failure reverts.
  if (!(await page.locator('#planes').isHidden()))
    fail('plane control shown for a fixed source')
  await page.evaluate(() => {
    const s = nvBench.slide()
    let at = { z: 0, t: 0 }
    window.planeCalls = []
    Object.defineProperty(s, 'planes', {
      value: { z: 3, t: 2, zPositionsUm: [0, 1.5, 3] },
      configurable: true,
    })
    Object.defineProperty(s, 'planeIndex', {
      get: () => at,
      configurable: true,
    })
    // Slow, as a real switch holds the old plane until the new one is ready.
    s.setPlaneIndex = async (p) => {
      window.planeCalls.push(p)
      await new Promise((r) => setTimeout(r, 150))
      if (window.planeFail) throw new RangeError('no such plane')
      at = p
      return true
    }
    nvBench.requestRender()
  })
  await page.waitForFunction(() => !document.getElementById('planes').hidden)
  const sliders = page.locator('#planes input[type=range]')
  if ((await sliders.count()) !== 2) fail('a slider each for z and t')
  const zSlider = sliders.nth(0)
  // t moved while the z switch is pending: the t request keeps the new z,
  // and the z slider does not snap back meanwhile.
  await zSlider.focus()
  await page.keyboard.press('ArrowRight')
  await sliders.nth(1).focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(50)
  if ((await zSlider.inputValue()) !== '1')
    fail('z slider snapped back during a pending switch')
  await page.waitForFunction(() => {
    const p = nvBench.slide().planeIndex
    return p.z === 1 && p.t === 1
  })
  const calls = await page.evaluate(() => window.planeCalls)
  if (JSON.stringify(calls.at(-1)) !== JSON.stringify({ z: 1, t: 1 }))
    fail(`plane requests ${JSON.stringify(calls)}`)
  await zSlider.focus()
  const label = await page.locator('#planes output').first().textContent()
  if (label !== '2/3 (1.5 um)') fail(`plane label ${label}`)
  await page.evaluate(() => {
    window.planeFail = true
  })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() =>
    /Plane not shown/.test(
      document.querySelector('#planes [role=status]').textContent,
    ),
  )
  if ((await zSlider.inputValue()) !== '1')
    fail(`failed switch left the slider at ${await zSlider.inputValue()}`)

  // Window/level drag: the channel window follows, and the panel shows it.
  const max = page.locator('#channels input[type=number]').nth(1)
  const before = await page.evaluate(() => nvBench.slide().channels[0].calMax)
  await page.selectOption('#drag', '9')
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy, { steps: 6 })
  await page.mouse.up()
  const after = await page.evaluate(() => nvBench.slide().channels[0].calMax)
  if (!(after > before)) fail(`W/L drag left calMax ${before} -> ${after}`)
  await page.waitForFunction(
    (v) =>
      Math.abs(
        Number(
          document.querySelectorAll('#channels input[type=number]')[1].value,
        ) - v,
      ) < 1,
    after,
  )
  // Typing a window in the panel sets it.
  await max.fill('200')
  await max.press('Enter')
  await page.waitForFunction(() => nvBench.slide().channels[0].calMax === 200)

  // Double-click zooms about the pointer: shift halves the scale.
  await page.selectOption('#drag', '3')
  const scale = () => page.evaluate(() => nvBench.slide().viewport.scale)
  const s0 = await scale()
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.down('Shift')
  await page.mouse.dblclick(cx, cy)
  await page.keyboard.up('Shift')
  const s1 = await scale()
  if (Math.abs(s1 - s0 / 2) > 1e-6)
    fail(`shift double-click: scale ${s0} -> ${s1}`)

  // Side by side: a second view of the slide, linked to this one.
  // A compare pane whose open fails leaves no cover or dead pane behind.
  for (const mode of ['lens', 'side']) {
    await page.evaluate(() => fetch('/fail-store?on'))
    await page.selectOption('#compare', mode)
    await page.waitForFunction(() =>
      /^Compare view:/.test(document.getElementById('status').textContent),
    )
    if (!(await page.locator('#canvas2').isHidden()))
      fail(`${mode}: failed compare canvas still shown`)
    // Nothing covers the main canvas, and it still takes the wheel.
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.id,
      [cx, cy],
    )
    if (top !== 'canvas') fail(`${mode}: ${top} covers the main view`)
    const before = await page.evaluate(() => nvBench.slide().viewport.scale)
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, -100)
    await page.waitForFunction(
      (s) => nvBench.slide().viewport.scale !== s,
      before,
    )
    await page.selectOption('#compare', 'single')
    await page.evaluate(() => fetch('/fail-store?off'))
  }

  const mainView = await page.evaluate(() => ({ ...nvBench.slide().viewport }))
  await page.selectOption('#compare', 'side')
  await page.waitForFunction(() => nvBench.compare())
  // Opening the compare view keeps this view where the user left it (the
  // pane narrows, so only the centre is comparable).
  await page.waitForTimeout(200)
  const kept = await page.evaluate(() => ({ ...nvBench.slide().viewport }))
  if (
    Math.abs(kept.centerX - mainView.centerX) > 1e-6 ||
    Math.abs(kept.centerY - mainView.centerY) > 1e-6
  )
    fail(`compare moved the main view: ${JSON.stringify([mainView, kept])}`)
  const half = await page.locator('#canvas2').boundingBox()
  if (!(half && Math.abs(half.width - box.width / 2) < 4))
    fail(`side-by-side canvas width ${half?.width}`)
  const left = await page.locator('#canvas').boundingBox()
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2)
  await page.mouse.down()
  await page.mouse.move(left.x + left.width / 2 + 40, left.y + 40, {
    steps: 4,
  })
  await page.mouse.up()
  await page.waitForFunction(() => {
    const a = nvBench.slide().viewport
    const b = nvBench.compare().viewport
    return Math.abs(a.centerX - b.centerX) < 1e-6 && a.scale === b.scale
  })

  // Lens: the compare canvas covers this one, clipped to a circle at the pointer.
  await page.selectOption('#compare', 'lens')
  await page.waitForFunction(() => nvBench.compare())
  await page.mouse.move(cx, cy)
  const clip = await page
    .locator('#canvas2')
    .evaluate((c) => getComputedStyle(c).clipPath)
  if (!clip.startsWith('circle(96px')) fail(`lens clip ${clip}`)
  await page.selectOption('#compare', 'single')
  if ((await page.locator('#channels input[type=checkbox]').count()) !== C)
    fail('the channel panel lists every channel')
  if (!(await page.locator('#canvas2').isHidden()))
    fail('compare canvas still shown')

  // Contrast box: off for RGB (which falls back to pan), back for scalar.
  const openStore = async (name, rgb) => {
    await page.evaluate(
      (url) => nvBench.openUrl(url),
      `http://127.0.0.1:${port}/${name}/`,
    )
    await page.waitForFunction(
      (rgb) => !nvBench.slide().manifest.channelInfo === rgb,
      rgb,
    )
  }
  const contrastOff = () =>
    page.evaluate(() => document.getElementById('contrastBox').disabled)
  await page.selectOption('#drag', '1')
  await openStore('rgb.zarr', true)
  if (!(await contrastOff()) || (await page.inputValue('#drag')) !== '3')
    fail('RGB slide kept the contrast box')
  const centre = () => page.evaluate(() => nvBench.slide().viewport.centerX)
  const c0 = await centre()
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 40, cy, { steps: 4 })
  await page.mouse.up()
  if ((await centre()) === c0) fail('RGB slide: a left drag does not pan')
  await openStore('s.zarr', false)
  if (await contrastOff()) fail('scalar slide: contrast box still disabled')

  if (errors.length) fail(`page errors: ${errors.join('; ')}`)
  await page.close()
}
try {
  for (const backend of (
    process.env.DEMO_E2E_BACKENDS ?? 'webgl2,webgpu'
  ).split(','))
    await check(backend)
} finally {
  await browser.close()
  server.close()
}
console.log(
  `${process.exitCode ? 'failed' : 'ok'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
