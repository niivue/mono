/**
 * Tile-stack baseline (scratch plan-tile-final section 1). Builds the demo plus
 * bench/slide3d.html, serves them and the pinned stores (bench/fetch.mjs) from
 * one origin on BENCH_PORT, and drives Chromium on the real GPU, both backends.
 *
 *   TILE_BENCH_DATA=<dir> bunx nx bench demo-ext-tile
 *
 * Env: BENCH_REPEATS (5), BENCH_DPR (2), BENCH_PORT (5397),
 * BENCH_ONLY=slide,wl,heap,slide3d,remote (default all), BENCH_STORES=<keys
 * of STORES> (default all), BENCH_OUT.
 * Writes one JSON per run, then summary.json and summary.md, to BENCH_OUT.
 *
 * Sharp: every tile of the chosen level (after the cache/texture capacity cap)
 * is resident when a frame is drawn. Cold: fresh browser context. Warm: reload
 * in the same context (HTTP cache warm; decoded and GPU caches are per page).
 * Request counts and bytes come from this server's log (all local reads,
 * workers included); the remote store counts Playwright request events.
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { cpus, homedir, release, tmpdir, totalmem } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { build } from 'vite'

const DATA =
  process.env.TILE_BENCH_DATA ?? join(homedir(), '.cache/niivue-tile-bench')
const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = execSync('git rev-parse --short HEAD', { cwd: APP })
  .toString()
  .trim()
const DIRTY = execSync('git status --porcelain', { cwd: APP }).length > 0
const OUT = process.env.BENCH_OUT ?? join(tmpdir(), 'tile-bench', SHA)
const DIST = join(OUT, 'dist')
const PORT = Number(process.env.BENCH_PORT ?? 5397)
const REPEATS = Number(process.env.BENCH_REPEATS ?? 5)
const DPR = Number(process.env.BENCH_DPR ?? 2)
const ONLY = process.env.BENCH_ONLY?.split(',')
const BACKENDS = ['webgpu', 'webgl2']
const STORES = {
  'cmu1-svs': '/bench-data/cmu-1.svs',
  'dicom-3dhistech1': '/bench-data/3dhistech-1/manifest.json',
  'imc-27ch-zarr': '/bench-data/imc.ome.zarr',
  'sentinel2-u16-zarr': '/bench-data/sentinel2.ome.zarr',
}
const REMOTE = {
  'ome-tiff-brain (remote, advisory)':
    'https://viv-demo.storage.googleapis.com/brain.pyramid.ome.tif',
}
const run = (name) => !ONLY || ONLY.includes(name)

// Hash of bench/fetch.mjs's per-file SHA256SUMS: equal means same fixtures.
// Read first, so a missing $TILE_BENCH_DATA fails before the run.
const FIXTURES = createHash('sha256')
  .update(await readFile(join(DATA, 'SHA256SUMS')))
  .digest('hex')
  .slice(0, 16)
await mkdir(OUT, { recursive: true })
await build({
  configFile: false,
  root: APP,
  logLevel: 'warn',
  worker: { format: 'es' },
  build: {
    outDir: DIST,
    emptyOutDir: true,
    target: 'esnext',
    rolldownOptions: {
      input: [join(APP, 'index.html'), join(APP, 'bench/slide3d.html')],
    },
  },
})

// Static server with Range, validators and a request log.
const log = []
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
}
const server = createServer(async (req, res) => {
  const path = normalize(
    decodeURIComponent(new URL(req.url, 'http://x').pathname),
  )
  const file = path.startsWith('/bench-data/')
    ? join(DATA, path.slice(12))
    : join(DIST, path === '/' ? 'index.html' : path)
  const entry = { path, range: req.headers.range, status: 404, bytes: 0 }
  log.push(entry)
  const st = await stat(file).catch(() => null)
  if (!st?.isFile()) return void res.writeHead(404).end()
  const etag = `"${st.size}-${st.mtimeMs}"`
  const headers = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'max-age=3600',
    etag,
  }
  if (req.headers['if-none-match'] === etag) {
    entry.status = 304
    return void res.writeHead(304, headers).end()
  }
  let start = 0
  let end = st.size - 1
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (m) {
    if (m[1]) [start, end] = [Number(m[1]), m[2] ? Number(m[2]) : end]
    else start = st.size - Number(m[2])
    end = Math.min(end, st.size - 1)
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`
  }
  entry.status = m ? 206 : 200
  headers['content-length'] = end - start + 1
  res.writeHead(entry.status, headers)
  // HEAD sends no body, so it reads and counts nothing.
  if (req.method === 'HEAD') return void res.end()
  const stream = createReadStream(file, { start, end })
  stream.on('data', (chunk) => {
    entry.bytes += chunk.length
  })
  stream.pipe(res)
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${PORT}`
const dataReads = (from) => {
  const reads = log.slice(from).filter((e) => e.path.startsWith('/bench-data/'))
  return {
    requests: reads.length,
    bytes: reads.reduce((n, e) => n + e.bytes, 0),
    notModified: reads.filter((e) => e.status === 304).length,
  }
}

const browser = await chromium.launch({
  channel: 'chromium',
  args: [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-precise-memory-info',
  ],
})
const newContext = () =>
  browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: DPR,
  })

// In-page probe: wraps the renderer's draw to time frames and detect sharp.
function probe() {
  const b = window.nvBench
  const r = b.renderer
  const name = r.draw ? 'draw' : 'render'
  const draw = r[name].bind(r)
  const px = new Uint8Array(4)
  const p = {
    t0: 0,
    firstAt: null,
    sharpAt: null,
    sync: false,
    frames: 0,
    waiters: [],
    reset() {
      p.t0 = performance.now()
      p.firstAt = p.sharpAt = null
    },
    nextFrame: () => new Promise((resolve) => p.waiters.push(resolve)),
    gpuBytes: () => r._textures.bytes + r._fuser.poolBytes,
    state() {
      const s = b.slide()
      return {
        pending: s.pendingCount,
        queued: s._loadQueue.length,
        active: s._activeLoads,
        wanted: s._wanted.size,
        cpuCacheBytes: s.cacheBytes,
        gpuBytes: p.gpuBytes(),
        stats: { ...s.stats, lastRequests: undefined },
      }
    },
  }
  r[name] = (...args) => {
    const t = performance.now()
    draw(...args)
    const s = b.slide()
    const v = s?.lastVisibleTiles
    const cached = v ? v.tiles.filter((x) => s._cache.has(x.key)).length : 0
    if (cached && p.firstAt === null) p.firstAt = t - p.t0
    if (v?.tiles.length && cached === v.tiles.length && p.sharpAt === null)
      p.sharpAt = performance.now() - p.t0
    p.frames++
    const settle = (ms) => {
      const frame = { ms, level: v?.level?.index, tiles: v?.tiles.length }
      for (const w of p.waiters.splice(0)) w(frame)
    }
    if (!p.sync) return settle(performance.now() - t)
    // GL: `draw(gl, ...)` (before ENG-07) or `render` with the stored context.
    const gl = name === 'draw' ? args[0] : r._gl
    if (gl) {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      settle(performance.now() - t)
    } else
      r._device.queue
        .onSubmittedWorkDone()
        .then(() => settle(performance.now() - t))
  }
  window.bench = p
}

async function env(page) {
  return page.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
    const c = document.querySelector('canvas')
    return {
      userAgent: navigator.userAgent,
      webgl: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      webgpu: adapter && {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
      dpr: devicePixelRatio,
      canvas: [c.width, c.height, c.clientWidth, c.clientHeight],
    }
  })
}

const waitSharp = (page, ms = 60000) =>
  page
    .waitForFunction(() => window.bench.sharpAt !== null, null, { timeout: ms })
    .then(() =>
      page.evaluate(() => ({ firstMs: bench.firstAt, sharpMs: bench.sharpAt })),
    )
    .catch(() => ({ firstMs: null, sharpMs: null, timeout: true }))

// Runs `fn(arg)` in the page as a view change, then waits for sharp and counts reads.
async function step(page, fn, arg) {
  const mark = log.length
  const before = await page.evaluate(() => {
    bench.reset()
    return bench.state().stats
  })
  await page.evaluate(fn, arg)
  await page.evaluate(() => nvBench.requestRender())
  const t = await waitSharp(page)
  const after = await page.evaluate(() => bench.state())
  return {
    ...t,
    ...dataReads(mark),
    tileRequests: after.stats.requested - before.requested,
    aborted: after.stats.aborted - before.aborted,
    failures: after.stats.failures - before.failures,
    wireBytes: after.stats.wireBytes - before.wireBytes,
    pendingAfter: after.pending,
  }
}

async function openSlide(page, backend, url) {
  await page.waitForFunction(() => window.nvBench)
  const shown = await page.$eval('#backend', (e) => e.value)
  if (shown !== backend) throw new Error(`asked ${backend}, got ${shown}`)
  await page.evaluate(probe)
  const mark = log.length
  const openMs = await page.evaluate(async (u) => {
    bench.reset()
    await nvBench.openUrl(u)
    return performance.now() - bench.t0
  }, url)
  const open = { openMs, ...dataReads(mark) }
  const status = await page.$eval('#status', (e) => e.textContent)
  if (!(await page.evaluate(() => !!nvBench.slide()))) throw new Error(status)
  const t = await waitSharp(page)
  const info = await page.evaluate(() => {
    const s = nvBench.slide()
    return {
      levels: s.manifest.levels.length,
      size: [s.manifest.width, s.manifest.height],
      visibleChannels: s.channels.filter((c) => c.visible).length,
      interpolation: nvBench.renderer.isNearestInterpolation
        ? 'nearest'
        : 'linear',
      cacheBudget: s._cache.maxBytes,
      maxConcurrentLoads: s._maxConcurrentLoads,
      level: s.lastVisibleTiles?.level?.index,
      tiles: s.lastVisibleTiles?.tiles.length,
    }
  })
  const failures = await page.evaluate(() => nvBench.slide().stats.failures)
  return { open, firstPaint: { ...t, ...dataReads(mark), failures }, info }
}

// Working view: zoomed so ten quarter-screen pans to the right stay on the slide.
function panStart() {
  const s = nvBench.slide()
  const sc = nvBench.screen()
  const m = s.manifest
  const scale = Math.max(s.fitScaleFor(sc) * 2, (3.5 * sc.widthCss) / m.width)
  s.setViewport({
    centerX: sc.widthCss / (2 * scale),
    centerY: m.height / 2,
    scale,
  })
}
function pan() {
  nvBench
    .slide()
    .panByScreenDelta(-nvBench.screen().widthCss / 4, 0, nvBench.screen())
}
function zoomOut() {
  const s = nvBench.slide()
  s.setViewport({ ...s.viewport, scale: s.viewport.scale / 2 })
}
function showChannels(n) {
  const s = nvBench.slide()
  s.channels.forEach((ch, c) => {
    if (ch.visible !== c < n) s.setChannel(c, { visible: c < n })
  })
}

async function wl(page) {
  return page.evaluate(async () => {
    const s = nvBench.slide()
    const c0 = { ...s.channels[0] }
    bench.sync = true
    const ms = []
    for (let i = 0; i < 33; i++) {
      const done = bench.nextFrame()
      const k = 0.5 + 0.05 * (i % 10)
      s.setChannel(0, { calMax: c0.calMin + (c0.calMax - c0.calMin) * k })
      ms.push((await done).ms)
    }
    bench.sync = false
    s.setChannel(0, c0)
    return ms.slice(3)
  })
}

const results = []
async function save(rec) {
  results.push(rec)
  const name = [rec.scenario, rec.store, rec.backend, rec.phase, rec.rep].join(
    '_',
  )
  await writeFile(
    join(OUT, `${name.replace(/[^\w.-]+/g, '-')}.json`),
    JSON.stringify(rec, null, 2),
  )
  console.log(name, JSON.stringify(rec.metrics).slice(0, 200))
}

let environment = null
for (let rep = 0; rep < REPEATS; rep++)
  for (const backend of BACKENDS) {
    // W/L is measured on an opened slide, so it needs the store loop too.
    if (run('slide') || run('wl'))
      for (const [store, path] of Object.entries(STORES)) {
        if (process.env.BENCH_STORES?.split(',').includes(store) === false)
          continue
        const ctx = await newContext()
        const page = await ctx.newPage()
        try {
          for (const phase of ['cold', 'warm']) {
            if (phase === 'cold')
              await page.goto(
                `${ORIGIN}/index.html?bench&url=&backend=${backend}`,
              )
            else await page.reload()
            const o = await openSlide(page, backend, path)
            environment ??= await env(page)
            const pans = [await step(page, panStart)]
            for (let i = 0; i < 10; i++) pans.push(await step(page, pan))
            const out = await step(page, zoomOut)
            const metrics = {
              ...o,
              panStart: pans[0],
              pan: pans.slice(1),
              zoomOut: out,
            }
            if (run('wl') && store.endsWith('zarr'))
              for (const channels of [1, 6]) {
                metrics[`channels${channels}`] = await step(
                  page,
                  showChannels,
                  channels,
                )
                for (const minimap of [true, false]) {
                  await page.getByLabel('Minimap').setChecked(minimap)
                  metrics[`wl_${channels}ch_minimap${minimap ? 'On' : 'Off'}`] =
                    await wl(page)
                }
                await page.getByLabel('Minimap').setChecked(true)
              }
            await save({
              scenario: 'slide',
              store,
              backend,
              phase,
              rep,
              metrics,
            })
          }
        } catch (err) {
          await save({
            scenario: 'slide',
            store,
            backend,
            phase: 'error',
            rep,
            metrics: { error: String(err) },
          })
        }
        await ctx.close()
      }

    // Heap and GPU bytes after a 60 s pan that bounces off the slide's edges.
    if (run('heap') && rep < 2) {
      const ctx = await newContext()
      const page = await ctx.newPage()
      await page.goto(`${ORIGIN}/index.html?bench&url=&backend=${backend}`)
      await openSlide(page, backend, STORES['imc-27ch-zarr'])
      await step(page, panStart)
      const mark = log.length
      const peak = await page.evaluate(async () => {
        const s = nvBench.slide()
        let dx = -nvBench.screen().widthCss / 20
        let dy = -nvBench.screen().heightCss / 30
        const peak = { gpuBytes: 0, cpuCacheBytes: 0, pending: 0, wanted: 0 }
        for (const end = performance.now() + 60000; performance.now() < end; ) {
          const { centerX, centerY } = s.viewport
          s.panByScreenDelta(dx, dy, nvBench.screen())
          s.clampViewport(nvBench.screen())
          if (s.viewport.centerX === centerX) dx = -dx
          if (s.viewport.centerY === centerY) dy = -dy
          nvBench.requestRender()
          await new Promise((r) => setTimeout(r, 50))
          const st = bench.state()
          for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], st[k])
        }
        return peak
      })
      await page.waitForTimeout(2000)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = await cdp.send('Runtime.getHeapUsage')
      const after = await page.evaluate(() => bench.state())
      await save({
        scenario: 'heap60s',
        store: 'imc-27ch-zarr',
        backend,
        phase: 'cold',
        rep,
        metrics: {
          heap, // main-thread V8 heap; worker heaps are not included
          peak,
          after,
          ...dataReads(mark),
        },
      })
      await ctx.close()
    }

    // 3D slide plane: orbit and zoom in ten steps, sampling the load queue each frame.
    if (run('slide3d') && rep < 3) {
      const ctx = await newContext()
      const page = await ctx.newPage()
      const mark = log.length
      await page.goto(
        `${ORIGIN}/bench/slide3d.html?backend=${backend}&url=${STORES['cmu1-svs']}`,
      )
      await page.waitForFunction(() => window.bench3d, null, { timeout: 60000 })
      const metrics = await page
        .evaluate(async (want) => {
          const { nv, slide } = bench3d
          if (nv.backend !== want)
            throw new Error(`asked ${want}, got ${nv.backend}`)
          const peak = { pending: 0, queued: 0, active: 0, wanted: 0 }
          const sample = () => {
            const now = {
              pending: slide.pendingCount,
              queued: slide._loadQueue.length,
              active: slide._activeLoads,
              wanted: slide._wanted.size,
            }
            for (const k of Object.keys(peak))
              peak[k] = Math.max(peak[k], now[k])
            return now
          }
          const frames = (n) =>
            new Promise((resolve) => {
              const tick = () => {
                sample()
                if (--n > 0) requestAnimationFrame(tick)
                else resolve()
              }
              requestAnimationFrame(tick)
            })
          await frames(60)
          for (let i = 1; i <= 10; i++) {
            nv.azimuth = 120 + i * 15
            nv.scaleMultiplier = 1 + i * 0.4
            await frames(30)
          }
          const t = performance.now()
          while (slide.pendingCount && performance.now() - t < 20000)
            await frames(10)
          return {
            peak,
            final: sample(),
            settleMs: performance.now() - t,
            stats: { ...slide.stats, lastRequests: undefined },
          }
        }, backend)
        .catch((err) => ({ error: String(err) }))
      await save({
        scenario: 'slide3d',
        store: 'cmu1-svs',
        backend,
        phase: 'cold',
        rep,
        metrics: { ...metrics, ...dataReads(mark) },
      })
      await ctx.close()
    }

    // Open-time reads of a remote store too large to pin (12.8 GB).
    if (run('remote') && rep < 3)
      for (const [store, url] of Object.entries(REMOTE)) {
        const ctx = await newContext()
        const page = await ctx.newPage()
        const reqs = []
        ctx.on('requestfinished', async (r) => {
          if (r.url() === url) reqs.push((await r.sizes()).responseBodySize)
        })
        try {
          await page.goto(`${ORIGIN}/index.html?bench&url=&backend=${backend}`)
          await page.waitForFunction(() => window.nvBench)
          const openMs = await page.evaluate(async (u) => {
            const t = performance.now()
            await nvBench.openUrl(u)
            if (!nvBench.slide())
              throw new Error(document.getElementById('status').textContent)
            return performance.now() - t
          }, url)
          await page.waitForTimeout(500) // sizes() of the last replies
          await save({
            scenario: 'open-remote',
            store,
            backend,
            phase: 'cold',
            rep,
            metrics: {
              openMs,
              requests: reqs.length,
              bytes: reqs.reduce((a, b) => a + b, 0),
            },
          })
        } catch (err) {
          await page.waitForTimeout(500) // sizes() of the last replies
          await save({
            scenario: 'open-remote',
            store,
            backend,
            phase: 'error',
            rep,
            metrics: { error: String(err) },
          })
        }
        await ctx.close()
      }
  }

// Summary: median and p95 of every numeric leaf, per scenario/store/backend/phase.
const push = (o, k, vs) => {
  o[k] = (o[k] ?? []).concat(vs)
}
const leaves = (o, pre = '', out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = pre ? `${pre}.${k}` : k
    if (typeof v === 'number') push(out, key, [v])
    else if (Array.isArray(v) && typeof v[0] === 'number') push(out, key, v)
    else if (Array.isArray(v)) for (const x of v) leaves(x, `${key}[]`, out)
    else if (v && typeof v === 'object') leaves(v, key, out)
  }
  return out
}
const groups = {}
for (const r of results) {
  const id = [r.scenario, r.store, r.backend, r.phase].join(' | ')
  groups[id] ??= {}
  for (const [k, vs] of Object.entries(leaves(r.metrics)))
    push(groups[id], k, vs)
}
const q = (vs, p) =>
  vs.toSorted((a, b) => a - b)[
    Math.min(vs.length - 1, Math.floor(p * vs.length))
  ]
const summary = {
  commit: SHA,
  dirty: DIRTY,
  date: new Date().toISOString(),
  machine: {
    model: execSync('sysctl -n hw.model').toString().trim(),
    cpu: cpus()[0].model,
    cores: cpus().length,
    memGB: totalmem() / 2 ** 30,
    darwin: release(),
  },
  browser: `Chromium ${browser.version()}`,
  environment,
  settings: {
    viewport: '1920x1080',
    dpr: DPR,
    repeats: REPEATS,
    network: `local http://127.0.0.1:${PORT}, no throttling`,
    data: DATA,
    fixtures: FIXTURES,
  },
  groups: Object.fromEntries(
    Object.entries(groups).map(([g, m]) => [
      g,
      Object.fromEntries(
        Object.entries(m).map(([k, vs]) => [
          k,
          { n: vs.length, median: q(vs, 0.5), p95: q(vs, 0.95) },
        ]),
      ),
    ]),
  ),
}
await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2))
const md = [
  `# tile bench ${SHA}${DIRTY ? ' (dirty)' : ''}`,
  '',
  '```json',
  JSON.stringify({ ...summary, groups: undefined }, null, 2),
  '```',
]
for (const [g, m] of Object.entries(summary.groups)) {
  md.push(
    '',
    `## ${g}`,
    '',
    '| metric | n | median | p95 |',
    '|---|---|---|---|',
  )
  for (const [k, s] of Object.entries(m))
    md.push(
      `| ${k} | ${s.n} | ${+s.median.toFixed(2)} | ${+s.p95.toFixed(2)} |`,
    )
}
await writeFile(join(OUT, 'summary.md'), `${md.join('\n')}\n`)
console.log(`results in ${OUT}`)
await browser.close()
server.close()
