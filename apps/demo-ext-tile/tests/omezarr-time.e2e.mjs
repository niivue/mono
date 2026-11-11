/**
 * Browser check of lazy OME-Zarr time in ome.zarr.html, on a synthetic tczyx
 * store served from memory (no network): the slider and Play switch every
 * channel through setFrame4D, playback waits for each frame (no overlapping
 * fetches), a failed timepoint keeps the frame shown, and the canvas changes.
 *
 *   bunx nx e2e demo-ext-tile      # builds first, via Nx
 *
 * BENCH=1 serves a 20 x 2 x 64 x 256 x 256 uint16 store (8 MiB per channel
 * frame) and prints frame-switch times, uncached and cached; set
 * PLAYWRIGHT_CHROMIUM_CHANNEL=chromium for the real GPU.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
const BENCH = process.env.BENCH === '1'
const [T, C, Z, Y, X] = BENCH ? [20, 2, 64, 256, 256] : [6, 2, 8, 16, 16]
// Each chunk answer waits this long, so overlapping playback fetches would show.
const DELAY_MS = BENCH ? 0 : 30
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
}

const json = (v) => Buffer.from(JSON.stringify(v))
const store = new Map([
  ['.zgroup', json({ zarr_format: 2 })],
  [
    '.zattrs',
    json({
      multiscales: [
        {
          version: '0.4',
          axes: ['t', 'c', 'z', 'y', 'x'].map((name) => ({ name })),
          datasets: [{ path: '0' }],
        },
      ],
    }),
  ],
  [
    '0/.zarray',
    json({
      zarr_format: 2,
      shape: [T, C, Z, Y, X],
      chunks: [1, 1, Z, Y, X],
      dtype: '<u2',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  ],
])
/** Voxel i of channel c at time t holds 1000 t + 100 c + i % 100. */
for (let t = 0; t < T; t++)
  for (let c = 0; c < C; c++) {
    const chunk = new Uint16Array(Z * Y * X)
    for (let i = 0; i < chunk.length; i++)
      chunk[i] = 1000 * t + 100 * c + (i % 100)
    store.set(`0/${t}.${c}.0.0.0`, Buffer.from(chunk.buffer))
  }

let inFlight = 0
let maxInFlight = 0
let brokenT = -1
const server = createServer(async (req, res) => {
  const path =
    normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') ||
    'index.html'
  if (path.startsWith('store.zarr/')) {
    const key = path.slice('store.zarr/'.length)
    const body = store.get(key)
    const chunkT = /^0\/(\d+)\./.exec(key)?.[1]
    if (chunkT === undefined)
      return body ? res.end(body) : res.writeHead(404).end()
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, DELAY_MS))
    inFlight -= 1
    if (Number(chunkT) === brokenT) return res.writeHead(500).end()
    return res.end(body)
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

const failed = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}
const t0 = performance.now()
// WebGPU on the real GPU with a channel, else on SwiftShader (the flags
// packages/niivue/e2e/launchOptions.ts uses).
const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || undefined
const browser = await chromium.launch({
  channel,
  args: channel
    ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
    : [
        '--enable-unsafe-swiftshader',
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
      ],
})
async function check(backend) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The page opens a remote sample first; refuse it so the run stays offline.
  await page.route(/^https:/, (route) => route.abort())
  await page.goto(`http://127.0.0.1:${port}/ome.zarr.html?backend=${backend}`)
  const status = () => page.locator('#status').textContent()
  const fail = (msg) => failed(`${backend}: ${msg}`)
  await page.waitForFunction(() =>
    /Could not open/.test(document.getElementById('status').textContent),
  )
  await page.fill('#url', `http://127.0.0.1:${port}/store.zarr`)
  await page.click('#fetchUrl')
  await page.waitForFunction(() =>
    /timepoint\(s\)/.test(document.getElementById('status').textContent),
  )
  if (!(await page.locator('#timepoint').isVisible()))
    fail('the timepoint slider is hidden for a time series')
  await page.click('#load')
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Showing'),
  )
  const state = () =>
    page.evaluate(() => {
      const nv = window.nv1
      return {
        frame: nv.getFrame4D(nv.volumes[0].id),
        first: nv.volumes.map((v) => v.img[0]),
        count: nv.volumes[0].frameSource?.count,
        slider: document.getElementById('timepoint').value,
      }
    })
  const canvasShot = async () => {
    await page.evaluate(() => window.nv1.whenUpdatesSettle())
    await page.waitForTimeout(200)
    return (await page.locator('#gl1').screenshot()).toString('base64')
  }
  const attached = await page.evaluate(() => window.nv1.backend)
  if (attached !== backend) fail(`attached ${attached}`)
  let s = await state()
  if (s.count !== T || s.frame !== 0 || s.first.join() !== '0,100')
    fail(`after load: ${JSON.stringify(s)}`)
  const before = await canvasShot()

  // The slider switches every channel.
  await page.evaluate(() => {
    const slider = document.getElementById('timepoint')
    slider.value = '2'
    slider.dispatchEvent(new Event('input'))
  })
  await page.waitForFunction(
    () => window.nv1.getFrame4D(window.nv1.volumes[0].id) === 2,
  )
  s = await state()
  if (s.first.join() !== '2000,2100') fail(`slider to 2: ${JSON.stringify(s)}`)
  if ((await canvasShot()) === before)
    fail('the canvas did not change with the frame')

  // Rapid requests: the latest wins.
  await page.evaluate(async () => {
    const nv = window.nv1
    const id = nv.volumes[0].id
    await Promise.all([
      nv.setFrame4D(id, 1),
      nv.setFrame4D(id, 3),
      nv.setFrame4D(id, 0),
    ])
  })
  s = await state()
  if (s.frame !== 0 || s.first.join() !== '0,100')
    fail(`latest wins: ${JSON.stringify(s)}`)

  // Playback waits for each frame: never more than one frame's chunks in flight.
  // The aborted reads above may still be answering.
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 10))
  maxInFlight = 0
  await page.evaluate(() => {
    window.__seen = new Set()
    window.nv1.addEventListener('frameChange', (e) =>
      window.__seen.add(e.detail.frame),
    )
  })
  await page.click('#play')
  await page.waitForFunction(() => window.__seen.size >= 2, null, {
    timeout: 10000,
  })
  await page.click('#play')
  if (maxInFlight > C)
    fail(`playback overlapped fetches: ${maxInFlight} in flight`)
  if ((await page.locator('#play').textContent()) !== 'Play')
    fail('pause did not stop playback')

  // A failed timepoint keeps the frame shown and says so.
  brokenT = T - 1
  const shown = (await state()).frame
  await page.evaluate((t) => {
    const slider = document.getElementById('timepoint')
    slider.value = String(t)
    slider.dispatchEvent(new Event('input'))
  }, brokenT)
  await page.waitForFunction(() =>
    /Could not load that timepoint/.test(
      document.getElementById('status').textContent,
    ),
  )
  s = await state()
  if (s.frame !== shown || s.slider !== String(shown))
    fail(`failed fetch moved the frame: ${JSON.stringify(s)}`)
  brokenT = -1

  if (BENCH) {
    const times = await page.evaluate(async (T) => {
      const nv = window.nv1
      const id = nv.volumes[0].id
      const run = async (from, to) => {
        const out = []
        for (let t = from; t < to; t++) {
          const start = performance.now()
          await nv.setFrame4D(id, t)
          out.push(performance.now() - start)
        }
        return out
      }
      // Playback stopped by frame 4, so 6..T-2 were never fetched; then
      // revisit them from the cache.
      const cold = await run(6, T - 1)
      await nv.setFrame4D(id, 0)
      const warm = await run(6, T - 1)
      return { cold, warm }
    }, T)
    const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1].toFixed(1)
    console.log(
      `bench ${backend} ${C} x ${X}x${Y}x${Z} uint16: switch median uncached ${median(times.cold)} ms, cached ${median(times.warm)} ms (${times.cold.length} frames)`,
    )
  }
  if (errors.length) fail(`page errors: ${errors.join('; ')}`)
  if (process.exitCode) console.error(await status())
  await page.close()
}

try {
  for (const backend of ['webgl2', 'webgpu']) await check(backend)
} finally {
  await browser.close()
  server.close()
}
console.log(
  `${process.exitCode ? 'FAILED' : 'ok'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
