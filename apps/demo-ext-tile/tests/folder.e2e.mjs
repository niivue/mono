/**
 * Browser check of the DICOM-WSI folder workflow, on the synthetic fixtures only
 * (packages/nv-ext-tile/fixtures/dicom-wsi, ~70 KB). Seconds, not minutes; not in CI.
 *
 *   bunx nx e2e demo-ext-tile      # builds first, via Nx
 *
 * Opens the fixture folder through the webkitdirectory input, checks the slide
 * list and the skipped files, opens `colors` (TILED_SPARSE 3 x 2, four solid-colour
 * JPEG tiles, two holes) and reads the canvas: each tile shows its colour and each
 * hole shows the background, with no placeholder and no request for it.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
const FIXTURES = join(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'nv-ext-tile',
  'fixtures',
  'dicom-wsi',
)
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
}

const server = createServer(async (req, res) => {
  const path =
    normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') ||
    'index.html'
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

const fail = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}
const t0 = performance.now()
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // No ?url= default slide: the page starts empty.
  await page.goto(`http://127.0.0.1:${port}/index.html?url=`)
  await page.setInputFiles('#folder', FIXTURES)
  await page.waitForFunction(() =>
    /Indexed in/.test(document.getElementById('status').textContent),
  )
  const options = await page.locator('#slides option').allTextContents()
  const skipped = await page.locator('#status').getAttribute('title')
  // Six JPEG-labelled series, plus two optical paths and the e2e slide; four refused files.
  if (
    !options.some(
      (o) => o.startsWith('colors ') && /sparse, 4 frames, 2 holes/.test(o),
    )
  )
    fail(`no sparse colors slide in ${JSON.stringify(options)}`)
  if (options.filter((o) => o.startsWith('paths ')).length !== 2)
    fail('two optical paths should make two slides')
  for (const r of [
    'implicit.dcm: transfer-syntax',
    'bigendian.dcm: transfer-syntax',
    'deflated.dcm: transfer-syntax',
    'not-dicom.dcm: not-dicom',
  ])
    if (!skipped?.includes(r)) fail(`missing skipped entry ${r}`)

  const value = await page
    .locator('#slides option', { hasText: /^colors / })
    .getAttribute('value')
  await page.selectOption('#slides', value)
  await page.waitForFunction(() =>
    /colors: 1 levels, 4 tiles, .* 0 failed/.test(
      document.getElementById('status').textContent,
    ),
  )
  await page.waitForTimeout(300)
  // Sample each cell centre of the fitted 40 x 30 slide from a screenshot.
  const shot = (await page.locator('#canvas').screenshot()).toString('base64')
  const cells = await page.evaluate(async (png) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    // The slide is the non-black box: outside it the canvas is cleared to black,
    // inside it the slide background (and the holes) are not.
    const px = ctx.getImageData(0, 0, img.width, img.height).data
    let [left, top, right, bottom] = [img.width, img.height, -1, -1]
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4
        if (px[i] + px[i + 1] + px[i + 2] === 0) continue
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
      }
    const s = (right - left + 1) / 40
    const x0 = left
    const y0 = top
    const out = []
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 3; col++) {
        const cx = Math.round(
          x0 + (col * 16 + Math.min(16, 40 - col * 16) / 2) * s,
        )
        const cy = Math.round(
          y0 + (row * 16 + Math.min(16, 30 - row * 16) / 2) * s,
        )
        out.push([...ctx.getImageData(cx, cy, 1, 1).data.slice(0, 3)])
      }
    return out
  }, shot)
  console.log('cells (screen rows top to bottom):', JSON.stringify(cells))
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 12)
  const red = [220, 30, 30],
    green = [30, 160, 40],
    blue = [40, 60, 220],
    yellow = [230, 200, 30]
  const bg = [7, 16, 13] // SlideRenderer's default background: a hole shows it
  // DICOM row 0 at the top of the screen (displayYAxis 'down'), as OpenSlide shows it.
  const expected = [red, bg, green, bg, blue, yellow]
  cells.forEach((c, i) => {
    if (!near(c, expected[i])) fail(`cell ${i}: ${c} is not ${expected[i]}`)
  })
  if (errors.length) fail(`page errors: ${errors.join('; ')}`)
} finally {
  await browser.close()
  server.close()
}
console.log(
  `${process.exitCode ? 'FAILED' : 'ok'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
