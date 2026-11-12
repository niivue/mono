/**
 * Browser check of the OME-Zarr slide path in index.html, on the small
 * zarr-python fixtures of packages/nv-ext-tile/fixtures/zarr-variants (no
 * network), both backends: each encoding opens as a 2-channel slide with its
 * attribution, reads exact samples at level 0, draws, and showing a hidden
 * channel again is served by the source's byte cache (no request).
 *
 *   bunx nx e2e demo-ext-tile      # builds first, via Nx
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')
const VARIANTS = join(
  HERE,
  '../../../packages/nv-ext-tile/fixtures/zarr-variants',
)
const STORES = [
  'v3-shard-per-level',
  'v3-c-spanning',
  'v2-zlib-dot-bigendian',
  'v2-blosc-lz4-slash',
]
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
}

/** Store requests, by path. */
const requests = []
const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname)
  const store = path.startsWith('/variants/')
  const file = store
    ? join(VARIANTS, path.slice('/variants/'.length))
    : join(DIST, path === '/' ? 'index.html' : path)
  if (store) requests.push(path)
  let body
  try {
    body = await readFile(file)
  } catch {
    return res.writeHead(404).end()
  }
  const headers = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  // zarrita reads a shard index's offset from a HEAD's Content-Length.
  if (!m)
    return res
      .writeHead(200, { ...headers, 'content-length': body.length })
      .end(req.method === 'HEAD' ? undefined : body)
  const start = m[1] ? Number(m[1]) : body.length - Number(m[2])
  const end = m[1] && m[2] ? Number(m[2]) : body.length - 1
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${body.length}`,
  })
  res.end(body.subarray(start, end + 1))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()
const origin = `http://127.0.0.1:${port}`

const failed = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}
const t0 = performance.now()
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

// Level 0 of every variant: channel c at (x, y) holds (7x + 13y + 1000c) % 4096.
const expected = (x, y) => [0, 1].map((c) => (7 * x + 13 * y + 1000 * c) % 4096)

async function check(backend, name) {
  const fail = (msg) => failed(`${backend} ${name}: ${msg}`)
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/^https:/, (route) => route.abort())
  const url = `${origin}/variants/${name}.ome.zarr/`
  await page.goto(
    `${origin}/index.html?bench&backend=${backend}&url=${encodeURIComponent(url)}`,
  )
  await page.waitForFunction(
    () => window.nvBench?.slide()?.manifest.format === 'ome-zarr',
    null,
    { timeout: 20000 },
  )
  const info = await page.evaluate(() => {
    const slide = window.nvBench.slide()
    return {
      channels: slide.channels.map((c) => c.visible),
      levels: slide.manifest.levels.length,
      attribution: slide.manifest.attribution ?? null,
    }
  })
  if (info.channels.join() !== 'true,true' || info.levels !== 3)
    fail(`opened as ${JSON.stringify(info)}`)
  if (
    name === 'v3-shard-per-level' &&
    info.attribution?.title !== 'Synthetic ramp'
  )
    fail(`attribution ${JSON.stringify(info.attribution)}`)
  for (const [x, y] of [
    [37, 21],
    [159, 95],
  ]) {
    const got = await page.evaluate(
      async ([x, y]) =>
        (await window.nvBench.slide().loadSampleAt(x, y)).map((s) => s.value),
      [x, y],
    )
    if (got.join() !== expected(x, y).join())
      fail(`sample at ${x},${y}: ${got} (want ${expected(x, y)})`)
  }
  // It draws: some canvas pixel is not background.
  await page.waitForFunction(
    () => {
      const s = window.nvBench.slide()
      const v = s.visibleTiles(window.nvBench.screen())
      return v.tiles.length > 0 && v.tiles.every((t) => s._cache.has(t.key))
    },
    null,
    { timeout: 20000 },
  )
  await page.evaluate(() => window.nvBench.requestRender())
  await page.waitForTimeout(200)
  // A GPU canvas cannot be read back after its frame: count lit pixels of a
  // screenshot instead.
  const shot = (await page.locator('canvas').first().screenshot()).toString(
    'base64',
  )
  const lit = await page.evaluate(async (png) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const g = Object.assign(document.createElement('canvas'), {
      width: img.width,
      height: img.height,
    }).getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4)
      if (d[i] + d[i + 1] + d[i + 2] > 30) n++
    return n
  }, shot)
  if (lit === 0) fail('nothing drawn')
  // Hide and show channel 1: its samples come back from the byte cache.
  const before = requests.length
  await page.evaluate(async () => {
    const slide = window.nvBench.slide()
    slide.setChannel(1, { visible: false })
    slide.setChannel(1, { visible: true })
    await slide.loadSampleAt(37, 21)
    const screen = window.nvBench.screen()
    while (
      !slide.visibleTiles(screen).tiles.every((t) => slide._cache.has(t.key))
    )
      await new Promise((r) => setTimeout(r, 20))
  })
  const again = requests.slice(before)
  if (again.length) fail(`re-showing a channel requested ${again.join(', ')}`)
  if (errors.length) fail(`page errors: ${errors.join('; ')}`)
  await page.close()
}

try {
  for (const backend of ['webgl2', 'webgpu'])
    for (const name of STORES) await check(backend, name)
} finally {
  await browser.close()
  server.close()
}
if (!process.exitCode)
  console.log(`ok in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
