/**
 * Browser check of the DICOM-WSI custom-files workflow, on the synthetic fixtures only
 * (packages/nv-ext-tile/fixtures/dicom-wsi, ~70 KB). Seconds, not minutes; not in CI.
 *
 *   bunx nx e2e demo-ext-tile      # builds first, via Nx
 *
 * Picks the fixture files through the Custom files input, checks the slide
 * list and the skipped files, opens `colors` (TILED_SPARSE 3 x 2, four solid-colour
 * JPEG tiles, two holes) and reads the canvas: each tile shows its colour and each
 * hole shows the background, with no placeholder and no request for it.
 * Then opens a missing manifest by Custom URL and checks that the failure keeps
 * the Slide and Series menus and that the Series menu still opens a slide.
 * The minimap must draw top right, and a click on it must move the view.
 * Last, dropped loose files and a (fake-entry) folder must open as Custom files.
 */

import { readdirSync } from 'node:fs'
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
  await page.setInputFiles(
    '#files',
    readdirSync(FIXTURES).map((f) => join(FIXTURES, f)),
  )
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
    /^colors: 1 levels.*requests +4\/4 done.*failures +0/s.test(
      document.getElementById('hud').textContent,
    ),
  )
  await page.uncheck('#hudToggle') // the HUD covers the top-left cell
  const canvasShot = async () => {
    await page.waitForTimeout(300)
    return (await page.locator('#canvas').screenshot()).toString('base64')
  }
  // The box of pixels that differ between two shots, or that are not black in one.
  const boxOf = (a, b = null) =>
    page.evaluate(
      async ([a, b]) => {
        const pixels = async (png) => {
          const img = new Image()
          img.src = `data:image/png;base64,${png}`
          await img.decode()
          const c = new OffscreenCanvas(img.width, img.height)
          const ctx = c.getContext('2d')
          ctx.drawImage(img, 0, 0)
          return [ctx.getImageData(0, 0, img.width, img.height).data, img.width]
        }
        const [pa, w] = await pixels(a)
        const pb = b ? (await pixels(b))[0] : null
        let [left, top, right, bottom] = [w, pa.length, -1, -1]
        for (let i = 0; i < pa.length; i += 4) {
          const hit = pb
            ? pa[i] !== pb[i] ||
              pa[i + 1] !== pb[i + 1] ||
              pa[i + 2] !== pb[i + 2]
            : pa[i] + pa[i + 1] + pa[i + 2] > 0
          if (!hit) continue
          const x = (i / 4) % w
          const y = Math.floor(i / 4 / w)
          left = Math.min(left, x)
          right = Math.max(right, x)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
        }
        return { left, top, right, bottom, width: w }
      },
      [a, b],
    )
  const minimap = page.getByLabel('Minimap')
  const withMinimap = await canvasShot()
  // The minimap would widen the non-black box below.
  await minimap.uncheck()
  // Sample each cell centre of the fitted 40 x 30 slide from a screenshot.
  const shot = await canvasShot()
  const map = await boxOf(withMinimap, shot)
  if (!(map.right >= map.left && map.left > map.width / 2))
    fail(`minimap not drawn top right: ${JSON.stringify(map)}`)
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

  // A click near the minimap's top-left corner recentres the view there. The
  // fitted 40 x 30 slide is past native resolution, so it cannot zoom in and
  // the pan clamp leaves it a small move: assert only that it moved.
  const fitted = await boxOf(shot)
  await minimap.check()
  await page.waitForTimeout(300)
  await page.locator('#canvas').click({
    position: {
      x: map.left + (map.right - map.left) * 0.15,
      y: map.top + (map.bottom - map.top) * 0.15,
    },
  })
  await minimap.uncheck()
  const moved = await boxOf(await canvasShot())
  if (moved.left === fitted.left && moved.top === fitted.top)
    fail(
      `minimap click did not move the view: ${JSON.stringify({ fitted, moved })}`,
    )

  // A failed custom open keeps the slide on screen and its menu state.
  await page.selectOption('#source', 'custom-url')
  await page.fill('#customUrl', `http://127.0.0.1:${port}/missing.json`)
  await page.press('#customUrl', 'Enter')
  await page.waitForFunction(() =>
    /HTTP 404/.test(document.getElementById('status').textContent),
  )
  if ((await page.inputValue('#source')) !== 'local')
    fail('failed open did not restore the Slide menu')
  if (!(await page.locator('#series').isVisible()))
    fail('failed open hid the Series menu')
  const paths = await page
    .locator('#slides option', { hasText: /^paths / })
    .first()
    .getAttribute('value')
  await page.selectOption('#slides', paths)
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Indexed in'),
  )

  // Loose files dropped on the canvas open like Custom files.
  const dropped = await Promise.all(
    ['colors.dcm', 'not-dicom.dcm'].map(async (name) => [
      name,
      (await readFile(join(FIXTURES, name))).toString('base64'),
    ]),
  )
  await page.check('#hudToggle')
  const highlighted = await page.evaluate((dropped) => {
    const dt = new DataTransfer()
    for (const [name, b64] of dropped)
      dt.items.add(
        new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name),
      )
    const canvas = document.getElementById('canvas')
    const fire = (type) =>
      canvas.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      )
    fire('dragenter')
    fire('dragover')
    const on = document.querySelector('main').classList.contains('drop')
    fire('drop')
    return on
  }, dropped)
  if (!highlighted) fail('dragover did not highlight the drop zone')
  await page.waitForFunction(
    () => document.querySelectorAll('#slides option').length === 1,
  )
  await page.waitForFunction(() =>
    /^colors: 1 levels.*requests +4\/4 done/s.test(
      document.getElementById('hud').textContent,
    ),
  )
  if (await page.locator('main.drop').count())
    fail('drop left the highlight on')
  if (
    !(await page.locator('#status').getAttribute('title'))?.includes(
      'not-dicom.dcm',
    )
  )
    fail('dropped not-dicom.dcm not in the skipped list')

  // A dropped folder: a script-made DataTransfer has no entries, so fake one
  // (types, items) holding real Files. Opening proves the synthesized keys
  // (slide/sub/colors.dcm) index and look up in Chromium.
  await page.evaluate((dropped) => {
    const entry = (fullPath, rest) => ({ fullPath, ...rest })
    const fileEntry = ([name, b64], dir) =>
      entry(`${dir}/${name}`, {
        isFile: true,
        file: (ok) =>
          ok(
            new File(
              [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))],
              name,
            ),
          ),
      })
    const dirEntry = (fullPath, children) =>
      entry(fullPath, {
        isFile: false,
        createReader: () => {
          let left = children
          return {
            readEntries: (ok) => {
              ok(left)
              left = []
            },
          }
        },
      })
    const tree = dirEntry('/slide', [
      dirEntry('/slide/sub', [fileEntry(dropped[0], '/slide/sub')]),
      fileEntry(dropped[1], '/slide'),
    ])
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    drop.dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file', webkitGetAsEntry: () => tree }],
    }
    document.getElementById('canvas').dispatchEvent(drop)
  }, dropped)
  await page.waitForFunction(() =>
    document.getElementById('status').title.includes('slide/not-dicom.dcm'),
  )
  await page.waitForFunction(() =>
    /^colors: 1 levels.*requests +4\/4 done.*failures +0/s.test(
      document.getElementById('hud').textContent,
    ),
  )
  await page.waitForTimeout(300)
  if (!(await page.textContent('#status')).startsWith('Indexed in'))
    fail(`folder drop: ${await page.textContent('#status')}`)
  // A slow folder walk must not replace an open started after it: hold the
  // walk's file callback, finish a newer loose drop, then release the walk.
  await page.evaluate((dropped) => {
    const file = ([name, b64]) =>
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name)
    const tree = {
      fullPath: '/old',
      isFile: false,
      createReader: () => {
        let left = [
          {
            fullPath: '/old/not-dicom.dcm',
            isFile: true,
            file: (ok) => {
              globalThis.releaseOldWalk = () => ok(file(dropped[1]))
            },
          },
        ]
        return {
          readEntries: (ok) => {
            ok(left)
            left = []
          },
        }
      },
    }
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    drop.dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file', webkitGetAsEntry: () => tree }],
    }
    document.getElementById('canvas').dispatchEvent(drop)
    const dt = new DataTransfer()
    dt.items.add(file(dropped[0]))
    document.getElementById('canvas').dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      }),
    )
  }, dropped)
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Indexed in'),
  )
  await page.evaluate(() => globalThis.releaseOldWalk())
  await page.waitForTimeout(300)
  if (!(await page.textContent('#status')).startsWith('Indexed in'))
    fail(
      `stale folder walk replaced a newer open: ${await page.textContent('#status')}`,
    )

  if (errors.length) fail(`page errors: ${errors.join('; ')}`)
} finally {
  await browser.close()
  server.close()
}
console.log(
  `${process.exitCode ? 'FAILED' : 'ok'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
