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

// A segmentation of the same grid: label (t % 2) + 1, coloured by image-label.
const seg = new Map([
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
      'image-label': {
        colors: [
          { 'label-value': 1, rgba: [255, 0, 0, 255] },
          { 'label-value': 2, rgba: [0, 0, 255, 255] },
        ],
      },
    }),
  ],
  [
    '0/.zarray',
    json({
      zarr_format: 2,
      shape: [T, 1, Z, Y, X],
      chunks: [1, 1, Z, Y, X],
      dtype: '|u1',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
  ],
])
for (let t = 0; t < T; t++)
  seg.set(`0/${t}.0.0.0.0`, Buffer.alloc(Z * Y * X, (t % 2) + 1))

// Armed, the next segmentation chunk request waits until segRelease().
let segArmed = false
let segHeld = false
let segRelease = () => {}

/** Timepoints whose chunks the page has requested. */
const requestedT = new Set()
let inFlight = 0
let maxInFlight = 0
// The last timepoint always fails, so no prefetch can have cached it when the
// failure check asks for it.
const brokenT = T - 1
const server = createServer(async (req, res) => {
  const path =
    normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') ||
    'index.html'
  if (path.startsWith('seg.zarr/')) {
    if (segArmed && /^seg\.zarr\/0\/\d/.test(path)) {
      segArmed = false
      segHeld = true
      await new Promise((r) => {
        segRelease = r
      })
      segHeld = false
    }
    const body = seg.get(path.slice('seg.zarr/'.length))
    return body ? res.end(body) : res.writeHead(404).end()
  }
  if (path.startsWith('store.zarr/')) {
    const key = path.slice('store.zarr/'.length)
    const body = store.get(key)
    const chunkT = /^0\/(\d+)\./.exec(key)?.[1]
    if (chunkT === undefined)
      return body ? res.end(body) : res.writeHead(404).end()
    requestedT.add(Number(chunkT))
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
  // Showing 2 prefetched 3, which nothing asked for yet.
  for (let i = 0; i < 100 && !requestedT.has(3); i++)
    await new Promise((r) => setTimeout(r, 10))
  if (!requestedT.has(3)) fail('frame 3 was not prefetched after showing 2')
  const stamp = await page.locator('#timestamp').textContent()
  if (stamp !== `t 2 / ${T - 1}`) fail(`timestamp reads "${stamp}"`)

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

  // A segmentation still opening when the channels are reloaded is dropped.
  await page.fill('#segUrl', `http://127.0.0.1:${port}/seg.zarr`)
  const heldAdd = async () => {
    segArmed = true
    await page.click('#addSeg')
    while (!segHeld) await new Promise((r) => setTimeout(r, 10))
  }
  await heldAdd()
  await page.evaluate(() => document.getElementById('load').onclick())
  segRelease()
  await page.waitForFunction(() =>
    /Dropped segmentation/.test(document.getElementById('status').textContent),
  )
  if ((await page.evaluate(() => window.nv1.volumes.length)) !== C)
    fail('a superseded segmentation was attached')
  // One still opening when the frame moves attaches at the new frame, in the
  // channels' group.
  const from = await page.evaluate(() =>
    window.nv1.getFrame4D(window.nv1.volumes[0].id),
  )
  const to = (from + 1) % (T - 1)
  await heldAdd()
  await page.evaluate(async (t) => {
    const nv = window.nv1
    await nv.setFrame4D(nv.volumes[0].id, t)
  }, to)
  segRelease()
  await page.waitForFunction(() =>
    /Added segmentation/.test(document.getElementById('status').textContent),
  )
  const raced = await page.evaluate(() => {
    const nv = window.nv1
    const [raw] = nv.volumes
    const v = nv.volumes[nv.volumes.length - 1]
    return {
      n: nv.volumes.length,
      sameGroup: v.frameSource?.group === raw.frameSource?.group,
      frame: nv.getFrame4D(raw.id),
      segFrame: nv.getFrame4D(v.id),
      label: v.img[0],
    }
  })
  if (
    raced.n !== C + 1 ||
    !raced.sameGroup ||
    raced.frame !== to ||
    raced.segFrame !== to ||
    raced.label !== (to % 2) + 1
  )
    fail(`segmentation attached out of step: ${JSON.stringify(raced)}`)
  // The same two races while the segmentation's NIfTI is being prepared on
  // the volume worker (after its data read): its first File message is held.
  const reload = () =>
    page.evaluate(async () => {
      await document.getElementById('load').onclick()
    })
  const heldPrepare = async () => {
    await page.evaluate(() => {
      window.releasePrepare = null
      const post = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message?.url instanceof File) {
          Worker.prototype.postMessage = post
          window.releasePrepare = () => post.call(this, message, ...rest)
          return
        }
        return post.call(this, message, ...rest)
      }
    })
    await page.click('#addSeg')
    await page.waitForFunction(() => window.releasePrepare)
  }
  await reload()
  await heldPrepare()
  await reload()
  await page.evaluate(() => window.releasePrepare())
  await page.waitForFunction(() =>
    /Dropped segmentation/.test(document.getElementById('status').textContent),
  )
  if ((await page.evaluate(() => window.nv1.volumes.length)) !== C)
    fail('a segmentation superseded during its preparation was attached')
  const from2 = await page.evaluate(() =>
    window.nv1.getFrame4D(window.nv1.volumes[0].id),
  )
  const to2 = (from2 + 1) % (T - 1)
  await heldPrepare()
  await page.evaluate(async (t) => {
    const nv = window.nv1
    await nv.setFrame4D(nv.volumes[0].id, t)
  }, to2)
  await page.evaluate(() => window.releasePrepare())
  await page.waitForFunction(() =>
    /Added segmentation/.test(document.getElementById('status').textContent),
  )
  const prepRaced = await page.evaluate(() => {
    const nv = window.nv1
    const [raw] = nv.volumes
    const v = nv.volumes[nv.volumes.length - 1]
    return {
      n: nv.volumes.length,
      sameGroup: v.frameSource?.group === raw.frameSource?.group,
      frame: nv.getFrame4D(raw.id),
      segFrame: nv.getFrame4D(v.id),
      label: v.img[0],
    }
  })
  if (
    prepRaced.n !== C + 1 ||
    !prepRaced.sameGroup ||
    prepRaced.frame !== to2 ||
    prepRaced.segFrame !== to2 ||
    prepRaced.label !== (to2 % 2) + 1
  )
    fail(
      `segmentation prepared across a frame change is out of step: ${JSON.stringify(prepRaced)}`,
    )
  // A reload while addVolume awaits its GPU update: the stale segmentation's
  // cleanup must not touch the replacement scene's channels.
  await reload()
  await page.evaluate(() => {
    const nv = window.nv1
    window.beforeRaw = nv.volumes[0]
    window.releaseGpu = null
    const original = nv.view.updateBindGroups
    nv.view.updateBindGroups = async function (...args) {
      nv.view.updateBindGroups = original
      await new Promise((r) => {
        window.releaseGpu = r
      })
      return original.apply(this, args)
    }
  })
  await page.click('#addSeg')
  await page.waitForFunction(() => window.releaseGpu)
  await page.evaluate(() => {
    window.reloading = document.getElementById('load').onclick()
  })
  await page.waitForFunction(() => window.nv1.volumes[0] !== window.beforeRaw)
  await page.evaluate(() => window.releaseGpu())
  await page.evaluate(() => window.reloading)
  await page.waitForFunction(() => !document.getElementById('addSeg').disabled)
  const afterGpu = await page.evaluate(() =>
    window.nv1.volumes.map((v) => `${v.name}:${v.colormap}`),
  )
  if (afterGpu.length !== C || afterGpu.some((n) => n.endsWith('labels')))
    fail(`the replacement scene lost a channel: ${JSON.stringify(afterGpu)}`)

  // Start the plain check from the channels alone.
  await page.evaluate(() => document.getElementById('load').onclick())
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Showing'),
  )

  // A segmentation joins the time group, coloured by its image-label table.
  await page.click('#addSeg')
  await page.waitForFunction(() =>
    /Added segmentation/.test(document.getElementById('status').textContent),
  )
  const segState = () =>
    page.evaluate(() => {
      const nv = window.nv1
      const v = nv.volumes[nv.volumes.length - 1]
      return {
        n: nv.volumes.length,
        colormap: v.colormap,
        label: v.img[0],
        frame: nv.getFrame4D(nv.volumes[0].id),
      }
    })
  let g = await segState()
  if (
    g.n !== C + 1 ||
    !/ labels \(.+\)$/.test(g.colormap) ||
    g.label !== (g.frame % 2) + 1
  )
    fail(`segmentation added: ${JSON.stringify(g)}`)
  await page.evaluate(
    async (f) => {
      const nv = window.nv1
      await nv.setFrame4D(nv.volumes[0].id, f)
    },
    (g.frame + 1) % (T - 1),
  )
  g = await segState()
  if (g.label !== (g.frame % 2) + 1)
    fail(`segmentation did not switch with the channels: ${JSON.stringify(g)}`)

  // A failed timepoint keeps the frame shown and says so.
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
  // CI's Ubuntu runners lose the SwiftShader WebGPU device mid-run
  // (niivue-e2e.yml header), so the job there asks for WebGL2 only.
  for (const backend of (
    process.env.DEMO_E2E_BACKENDS ?? 'webgl2,webgpu'
  ).split(','))
    await check(backend)
} finally {
  await browser.close()
  server.close()
}
console.log(
  `${process.exitCode ? 'FAILED' : 'ok'} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
)
