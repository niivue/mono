/**
 * Plain HTML pages, no bundler: core's standalone build and nv-ext-tile's,
 * joined by one import map, served under a nested base (/a/b/). Checks that
 *   - a NIfTI page loads no extension code,
 *   - a Zarr page loads /zarr (whole level and streamed) and nothing of /tiff
 *     or /dicom; a Zarr slide reads tiles on the chunk workers, or on the
 *     page when CSP blocks workers,
 *   - a DICOM page decodes JPEG 2000 and JPEG-LS tiles through the mapped
 *     @niivue/dcm2niix and applies an ICC profile, with the decoder registered
 *     through '@niivue/niivue' visible from the WebGPU entry (one core),
 *   - a TIFF page streams a JPEG tile through geotiff-rs's WASM by Range, and
 *     a JPEG 2000 tile fails clearly until registerDcm2niixTiffDecoders, then
 *     decodes through the mapped @niivue/dcm2niix.
 * Synthetic fixtures (fixtures/standalone, about 4 KB); a few seconds; not in CI.
 *   bunx nx e2e nv-ext-tile      # builds core and this package first
 */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const require = createRequire(join(PKG, 'package.json'))
const { chromium } = require('@playwright/test')
const BASE = '/a/b/'
const ROUTES = [
  ['niivue/', join(PKG, '..', 'niivue', 'dist', 'standalone')],
  ['ext/', join(PKG, 'dist', 'standalone')],
  [
    'dcm2niix/',
    `${dirname(require.resolve('@niivue/dcm2niix/package.json'))}/dist`,
  ],
  ['fixtures/', join(PKG, 'fixtures', 'standalone')],
  ['wsi/', join(PKG, 'fixtures', 'dicom-wsi')],
]
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
}

// A 2 x 2 x 2 uint8 NIfTI-1, voxels 1..8.
function tinyNifti() {
  const b = Buffer.alloc(352 + 8)
  b.writeInt32LE(348, 0)
  for (const [i, v] of [3, 2, 2, 2, 1, 1, 1, 1].entries())
    b.writeInt16LE(v, 40 + 2 * i)
  b.writeInt16LE(2, 70) // DT_UINT8
  b.writeInt16LE(8, 72)
  for (let i = 0; i < 4; i++) b.writeFloatLE(1, 76 + 4 * i)
  b.writeFloatLE(352, 108)
  b.writeFloatLE(1, 112) // scl_slope
  b.write('n+1\0', 344)
  for (let i = 0; i < 8; i++) b[352 + i] = i + 1
  return b
}

// One-tile, one-IFD little-endian TIFF: 8-bit RGB, tile side x side.
function tinyTiff(tile, side, compression, photometric) {
  const count = 11
  const bps = 8 + 2 + count * 12 + 4 // BitsPerSample values, then the tile
  const entries = [
    [256, 3, 1, side],
    [257, 3, 1, side],
    [258, 3, 3, bps],
    [259, 3, 1, compression],
    [262, 3, 1, photometric],
    [277, 3, 1, 3],
    [284, 3, 1, 1],
    [322, 3, 1, side],
    [323, 3, 1, side],
    [324, 4, 1, bps + 6],
    [325, 4, 1, tile.length],
  ]
  const b = Buffer.alloc(bps + 6 + tile.length)
  b.write('II*\0', 0, 'latin1')
  b.writeUInt32LE(8, 4)
  b.writeUInt16LE(count, 8)
  entries.forEach(([tag, type, n, value], i) => {
    const p = 10 + i * 12
    b.writeUInt16LE(tag, p)
    b.writeUInt16LE(type, p + 2)
    b.writeUInt32LE(n, p + 4)
    if (type === 3 && n === 1) b.writeUInt16LE(value, p + 8)
    else b.writeUInt32LE(value, p + 8)
  })
  for (let i = 0; i < 3; i++) b.writeUInt16LE(8, bps + 2 * i)
  tile.copy(b, bps + 6)
  return b
}
const b64 = (s) => Buffer.from(s, 'base64')
const TIFFS = {
  // 64x64 baseline JPEG, YCbCr: left half (200,30,30), right half (30,30,200).
  'jpeg.tif': tinyTiff(
    b64(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAkHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEzJ3GAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAAqyZ6hAAACUqYJ7gAAKsmeoQAAAlKmCe4AACrJnqEAAAJSpgnuAAA/9k=',
    ),
    64,
    7,
    6,
  ),
  // 16x16 lossless JPEG 2000 of RGB (16x, 16y, 128).
  'j2k.tif': tinyTiff(
    b64(
      '/0//UQAvAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBAQQEAAH/XAAHQEBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAACoAAH/k8+0vBEdtk9h32cNPQ8B9ZqouL5H/LLzUHWs3o203Lf0KBnUUnqc3N0r1y2McJOIDUd/34CoFT4y0PYK28DY3s7q1XX+bmcCFlwZ34EwJ3Vmip8cpb26jzqvWzP8l0KQdPeib1EuYd72SMu4UcNYduwH/3/AfCJA+QIANqGZvz2mNF+g+cKAPmKisD/B84SD5wo2oZnPPmKisD//2Q==',
    ),
    16,
    34712,
    2,
  ),
}

const IMPORTS = {
  '@niivue/niivue': './niivue/niivue.js',
  '@niivue/niivue/webgl2': './niivue/niivue.webgl2.js',
  '@niivue/niivue/webgpu': './niivue/niivue.webgpu.js',
  '@niivue/nv-ext-tile/tiff': './ext/tiff.js',
  '@niivue/nv-ext-tile/dicom': './ext/dicom.js',
  '@niivue/nv-ext-tile/zarr': './ext/zarr.js',
  '@niivue/dcm2niix': './dcm2niix/index.jpeg.js',
}
const page = (body, imports = IMPORTS) =>
  `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports })}</script>
<script>addEventListener('unhandledrejection', (e) => { window.unhandled = String(e.reason) })</script>
<script>{ const W = Worker; window.liveWorkers = 0; window.madeWorkers = 0
  // Counts workers created while countWorkers is set (the Zarr pool's, the DICOM
  // index's), and indexes a worker answered with (not the main-thread fallback).
  window.Worker = class extends W {
    constructor(...a) { super(...a); this.counted = window.countWorkers; if (this.counted) { liveWorkers++; madeWorkers++
      this.addEventListener('message', (e) => { if (e.data?.index) window.workerIndexes = (window.workerIndexes ?? 0) + 1 }) } }
    terminate() { if (this.counted && !this.ended) { this.ended = true; liveWorkers-- } super.terminate() }
  } }</script>
<canvas id="gl" width="64" height="32" style="width:64px;height:32px"></canvas>
<script type="module">
try { window.result = await (async () => { ${body} })() }
catch (e) { window.result = { error: String(e?.stack ?? e) } }
</script>`

const PAGES = {
  'nifti.html': page(`
    const { default: NiiVue } = await import('@niivue/niivue')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachTo('gl')
    await nv.loadVolumes([{ url: './tiny.nii' }])
    return { dims: [...nv.volumes[0].dims] }`),
  'zarr.html': page(`
    const { default: NiiVue } = await import('@niivue/niivue')
    const { loadOmeZarrVolumes, fetchOmeZarrChunkedSource } = await import('@niivue/nv-ext-tile/zarr')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachTo('gl')
    const url = new URL('./fixtures/tiny.ome.zarr', location.href).href
    await nv.loadVolumes(await loadOmeZarrVolumes(url, { level: 0 }))
    const whole = { dims: [...nv.volumes[0].dims], max: nv.volumes[0].globalMax }
    const source = await fetchOmeZarrChunkedSource(url)
    const level = source.levels[0]
    const bytes = await source.fetchChunk({ levelIndex: 0, texOrigin: [0, 0, 0], texDims: level.shape, bytesPerVoxel: 1 })
    source.dispose?.()
    return { whole, streamed: [...bytes] }`),
  // A Zarr slide reads its tiles on the chunk workers; switching to z 1
  // reads that plane; dispose ends the workers.
  'zarr-slide.html': page(`
    const { ZarrSlideSource } = await import('@niivue/nv-ext-tile/zarr')
    const url = new URL('./fixtures/tiny.ome.zarr', location.href).href
    window.countWorkers = true
    const source = await ZarrSlideSource.fromUrl(url)
    const read = async (m) => [...(await source.fetchTileBytes(m.levels[0], m.levels[0].tiles[0], 'x'))]
    const z0 = await read(source.manifest)
    const z1 = await read(await source.preparePlane({ z: 1, t: 0 }))
    const made = window.madeWorkers
    source.dispose()
    return { planes: source.planes, z0, z1, made, live: window.liveWorkers }`),
  // Workers blocked by CSP: the same tiles, read on this thread.
  'zarr-slide-csp.html': page(`
    const { ZarrSlideSource } = await import('@niivue/nv-ext-tile/zarr')
    const url = new URL('./fixtures/tiny.ome.zarr', location.href).href
    window.countWorkers = true
    const source = await ZarrSlideSource.fromUrl(url)
    const read = async (m) => [...(await source.fetchTileBytes(m.levels[0], m.levels[0].tiles[0], 'x'))]
    const z0 = await read(source.manifest)
    const z1 = await read(await source.preparePlane({ z: 1, t: 0 }))
    const made = window.madeWorkers
    source.dispose()
    return { planes: source.planes, z0, z1, made, live: window.liveWorkers }`).replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="worker-src 'none'">`,
  ),
  // streamOmeZarr owns its manager and workers: replacing the volume or
  // destroying the viewer releases both (managers, live workers per step).
  'stream.html': page(`
    const { default: NiiVue } = await import('@niivue/niivue')
    const { streamOmeZarr } = await import('@niivue/nv-ext-tile/zarr')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachTo('gl')
    const url = new URL('./fixtures/tiny.ome.zarr', location.href).href
    const settle = () => new Promise((r) => setTimeout(r, 300))
    const stream = async () => {
      window.countWorkers = true
      await streamOmeZarr(nv, url)
      await settle()
      window.countWorkers = false
    }
    const step = () => [nv._chunkedVolumes.size, window.liveWorkers]
    const steps = []
    for (let i = 0; i < 3; i++) {
      await nv.removeAllVolumes()
      await stream()
      steps.push(step())
    }
    await nv.loadVolumes([{ url: './tiny.nii' }])
    await settle()
    steps.push(step())
    await stream()
    steps.push(step())
    // Removed while it initializes (every read held 500 ms).
    const slow = new URL('./slow/fixtures/tiny.ome.zarr', location.href).href
    await nv.removeAllVolumes()
    window.countWorkers = true
    const pending = streamOmeZarr(nv, slow, { replace: true })
    while (!nv.volumes.length) await new Promise((r) => setTimeout(r, 20))
    await nv.removeAllVolumes()
    await pending
    await settle()
    window.countWorkers = false
    steps.push(step())
    await stream()
    nv.destroy()
    steps.push(step())
    // Destroyed while the store opens: the load rejects and frees its pool.
    const canvas2 = document.createElement('canvas')
    canvas2.id = 'gl2'
    document.body.append(canvas2)
    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.attachTo('gl2')
    window.countWorkers = true
    const opening = streamOmeZarr(nv2, slow)
    nv2.destroy()
    const rejected = await opening.then(() => false, () => true)
    await settle()
    window.countWorkers = false
    return { steps, made: window.madeWorkers, opening: { rejected, managers: nv2._chunkedVolumes.size, workers: window.liveWorkers } }`),
  'dicom.html': page(`
    const { NVSlide } = await import('@niivue/niivue/webgpu')
    const { SlideRenderer } = await import('@niivue/niivue/webgl2')
    const { DicomWsiSource, indexDicomWsi, registerDcm2niixDecoders } = await import('@niivue/nv-ext-tile/dicom')
    registerDcm2niixDecoders()
    const shared = !!NVSlide.tileDecoder('image/jp2') && !!NVSlide.tileDecoder('image/jls') && !!NVSlide.iccTransform()
    const files = await Promise.all(['jp2k.dcm', 'jls.dcm'].map(async (n) =>
      new File([await (await fetch('./fixtures/' + n)).arrayBuffer()], n)))
    window.countWorkers = true
    const index = await indexDicomWsi(files)
    window.countWorkers = false
    const indexWorkers = [window.madeWorkers, window.liveWorkers, window.workerIndexes]
    const canvas = document.getElementById('gl')
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true })
    const renderer = new SlideRenderer()
    renderer.init(gl)
    const screen = { widthCss: 64, heightCss: 32, devicePixelRatio: 1 }
    const centres = () => [16, 48].map((x) => {
      const p = new Uint8Array(4)
      gl.readPixels(x, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p)
      return [...p.slice(0, 3)]
    })
    const show = async (s, colorManagement) => {
      const slide = NVSlide.fromSource(new DicomWsiSource(s, files), { colorManagement })
      slide.fitToScreen(screen)
      for (let i = 0; i < 100 && (slide.stats.completed < 2 || (s.iccProfile && colorManagement && !slide.colorLut)); i++) {
        renderer.render([slide], screen)
        await new Promise((r) => setTimeout(r, 50))
      }
      renderer.render([slide], screen)
      const out = { tiles: slide.stats.completed, failed: slide.stats.failures, rgb: centres() }
      slide.dispose()
      return out
    }
    const by = (name) => index.slides.find((s) => s.container === name)
    return {
      shared,
      indexWorkers,
      skipped: index.skipped,
      jls: await show(by('jls'), true),
      jp2kRaw: await show(by('jp2k'), false),
      jp2kIcc: await show(by('jp2k'), true),
    }`),
}

PAGES['tiff.html'] = page(`
    const { TiffSlideSource, registerDcm2niixTiffDecoders } = await import('@niivue/nv-ext-tile/tiff')
    const tile = async (name) => {
      const source = await TiffSlideSource.fromUrl('./tiff/' + name)
      const level = source.manifest.levels[0]
      try {
        return [...(await source.fetchTileBytes(level, level.tiles[0], name)).slice(0, 4)]
      } catch (e) {
        return String(e?.message ?? e)
      } finally {
        source.dispose()
      }
    }
    const jpeg = await tile('jpeg.tif')
    const j2kUnregistered = await tile('j2k.tif')
    registerDcm2niixTiffDecoders()
    const j2k = await tile('j2k.tif')
    return { jpeg, j2kUnregistered, j2k, unhandled: window.unhandled ?? null }`)

// Without a mapping for @niivue/dcm2niix: its tiles fail, JPEG still decodes.
const { '@niivue/dcm2niix': _, ...noDcm2niix } = IMPORTS
PAGES['nomap.html'] = page(
  `
    const { NVSlide, SlideRenderer } = await import('@niivue/niivue/webgl2')
    const { DicomWsiSource, indexDicomWsi, registerDcm2niixDecoders } = await import('@niivue/nv-ext-tile/dicom')
    registerDcm2niixDecoders()
    const files = await Promise.all(['fixtures/jp2k.dcm', 'wsi/colors.dcm'].map(async (n) =>
      new File([await (await fetch('./' + n)).arrayBuffer()], n.split('/')[1])))
    const index = await indexDicomWsi(files)
    const gl = document.getElementById('gl').getContext('webgl2')
    const renderer = new SlideRenderer()
    renderer.init(gl)
    const screen = { widthCss: 64, heightCss: 32, devicePixelRatio: 1 }
    const open = async (name) => {
      const slide = NVSlide.fromSource(new DicomWsiSource(index.slides.find((s) => s.container === name), files))
      slide.fitToScreen(screen)
      for (let i = 0; i < 60 && slide.stats.completed + slide.stats.failures < slide.manifest.levels[0].tiles.length; i++) {
        renderer.render([slide], screen)
        await new Promise((r) => setTimeout(r, 50))
      }
      const { completed, failures } = slide.stats
      slide.dispose()
      return { completed, failures }
    }
    const jp2k = await open('jp2k')
    const jpeg = await open('colors')
    await new Promise((r) => setTimeout(r, 200))
    return { jp2k, jpeg, unhandled: window.unhandled ?? null }`,
  noDcm2niix,
)

const server = createServer(async (req, res) => {
  let path
  try {
    path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  } catch {
    return res.writeHead(400).end()
  }
  if (!path.startsWith(BASE)) return res.writeHead(404).end()
  let rest = path.slice(BASE.length)
  // slow/<path>: the same file, 500 ms later (a store still loading).
  if (rest.startsWith('slow/')) {
    await new Promise((r) => setTimeout(r, 500))
    rest = rest.slice('slow/'.length)
  }
  if (PAGES[rest])
    return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[rest])
  if (rest === 'tiny.nii') return res.writeHead(200).end(tinyNifti())
  const tiff = TIFFS[rest.slice('tiff/'.length)]
  if (rest.startsWith('tiff/') && tiff) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (!range) return res.writeHead(200).end(tiff)
    const start = Number(range[1])
    const end = Math.min(Number(range[2] || tiff.length - 1), tiff.length - 1)
    return res
      .writeHead(206, {
        'content-range': `bytes ${start}-${end}/${tiff.length}`,
      })
      .end(tiff.subarray(start, end + 1))
  }
  for (const [prefix, dir] of ROUTES) {
    if (!rest.startsWith(prefix)) continue
    const file = join(dir, rest.slice(prefix.length))
    if (!file.startsWith(dir + sep)) break
    try {
      const body = await readFile(file)
      return res
        .writeHead(200, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        })
        .end(body)
    } catch {
      break
    }
  }
  res.writeHead(404).end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}${BASE}`

let failed = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failed++
}
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
try {
  const results = {}
  for (const name of Object.keys(PAGES)) {
    const tab = await browser.newPage()
    const requests = []
    const logs = []
    tab.on('request', (r) => requests.push(r.url().slice(origin.length)))
    tab.on('console', (m) => logs.push(m.text()))
    tab.on('pageerror', (e) => check(false, `${name}: ${e.message}`))
    await tab.goto(origin + name)
    await tab.waitForFunction(() => window.result, null, { timeout: 30000 })
    results[name] = {
      result: await tab.evaluate(() => window.result),
      requests,
      logs,
    }
    if (results[name].result.error)
      check(false, `${name}: ${results[name].result.error}`)
    await tab.close()
  }

  const nifti = results['nifti.html']
  check(
    nifti.result.dims?.[1] === 2,
    `nifti: loaded ${JSON.stringify(nifti.result.dims)}`,
  )
  check(
    !nifti.requests.some((u) => /^(ext|dcm2niix)\//.test(u)),
    'nifti: no extension or dcm2niix request',
  )

  const zarr = results['zarr.html']
  check(
    JSON.stringify(zarr.result.whole?.dims?.slice(1, 4)) === '[4,3,2]' &&
      zarr.result.whole.max === 23,
    `zarr: whole level ${JSON.stringify(zarr.result.whole)}`,
  )
  check(
    zarr.result.streamed?.length === 24 &&
      zarr.result.streamed.every((v, i) => v === i),
    'zarr: streamed brick holds 0..23',
  )
  const zarrExt = zarr.requests.filter((u) => u.startsWith('ext/'))
  check(
    zarrExt.includes('ext/zarr.js') &&
      !zarrExt.some((u) =>
        /^ext\/(tiff|dicom)\.js|chunks\/(tiff|lzw|jpeg|lerc)-/.test(u),
      ) &&
      !zarr.requests.some((u) => u.startsWith('dcm2niix/')),
    `zarr: only /zarr code (${zarrExt.join(', ')})`,
  )

  const nomap = results['nomap.html'].result
  check(
    nomap.jp2k?.failures > 0 &&
      nomap.jp2k.completed === 0 &&
      nomap.jpeg?.completed === 4 &&
      !nomap.unhandled,
    `no dcm2niix mapping: JPEG 2000 tiles fail visibly, JPEG decodes, nothing unhandled ${JSON.stringify(nomap)}`,
  )

  const tiff = results['tiff.html']
  check(
    near(tiff.result.jpeg ?? [], [200, 30, 30, 255]),
    `tiff: JPEG tile through geotiff-rs ${JSON.stringify(tiff.result.jpeg)}`,
  )
  check(
    /has no built-in decoder/.test(tiff.result.j2kUnregistered) &&
      JSON.stringify(tiff.result.j2k) === '[0,0,128,255]' &&
      !tiff.result.unhandled,
    `tiff: JPEG 2000 tile fails clearly, then decodes through dcm2niix ${JSON.stringify(tiff.result)}`,
  )
  check(
    !tiff.requests.some((u) => /^ext\/(dicom|zarr)\.js|chunks\/blosc-/.test(u)),
    'tiff: no /dicom or /zarr code',
  )
  const z0 = Array.from({ length: 12 }, (_, i) => i)
  const z1 = z0.map((v) => v + 12)
  for (const [name, workers] of [
    ['zarr-slide.html', true],
    ['zarr-slide-csp.html', false],
  ]) {
    const r = results[name].result
    const fellBack = results[name].logs.some((t) =>
      t.includes('chunk worker failed, reading on the main thread'),
    )
    check(
      r.planes?.z === 2 &&
        r.planes.t === 1 &&
        r.z0?.join() === z0.join() &&
        r.z1?.join() === z1.join() &&
        (workers ? r.made > 0 && !fellBack : fellBack) &&
        r.live === 0,
      `${name}: z 0 and z 1 tiles ${workers ? 'on the chunk workers' : 'on this thread (CSP blocks workers)'}, none left after dispose ${JSON.stringify(r)}`,
    )
  }
  const stream = results['stream.html'].result
  check(
    JSON.stringify(stream.steps?.map((s) => s[0])) === '[1,1,1,0,1,0,0]' &&
      stream.steps.every((s) => s[1] <= 1) &&
      stream.steps.at(-1)[1] === 0 &&
      stream.steps[3][1] === 0 &&
      stream.steps[5][1] === 0 &&
      stream.opening?.rejected &&
      stream.opening.managers === 0 &&
      stream.opening.workers === 0 &&
      stream.made > 0,
    `streamOmeZarr releases its manager and workers on replace, removal while initializing, destroy, and destroy while opening ${JSON.stringify(stream)}`,
  )

  const dicom = results['dicom.html'].result
  check(
    dicom.shared,
    'dicom: decoders registered via @niivue/niivue are visible from the WebGPU entry',
  )
  check(dicom.skipped?.length === 0, 'dicom: both fixtures indexed')
  check(
    dicom.indexWorkers?.join() === '1,0,1',
    `dicom: indexed in one inlined worker, ended after [made, live, answered] ${JSON.stringify(dicom.indexWorkers)}`,
  )
  const [red, yellow, green, blue] = [
    [255, 0, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]
  check(
    dicom.jls?.failed === 0 &&
      near(dicom.jls.rgb[0], green) &&
      near(dicom.jls.rgb[1], blue),
    `dicom: JPEG-LS tiles ${JSON.stringify(dicom.jls)}`,
  )
  check(
    dicom.jp2kRaw?.failed === 0 &&
      near(dicom.jp2kRaw.rgb[0], red) &&
      near(dicom.jp2kRaw.rgb[1], yellow),
    `dicom: JPEG 2000 tiles, colour management off ${JSON.stringify(dicom.jp2kRaw)}`,
  )
  // The profile shows device R as sRGB blue and G as red: red -> blue, yellow -> magenta.
  check(
    near(dicom.jp2kIcc?.rgb[0] ?? [], blue) &&
      near(dicom.jp2kIcc.rgb[1], [255, 0, 255]),
    `dicom: ICC profile applied ${JSON.stringify(dicom.jp2kIcc)}`,
  )
  check(
    results['dicom.html'].requests.some(
      (u) => u.startsWith('dcm2niix/') && u.endsWith('.wasm'),
    ),
    'dicom: dcm2niix WASM loaded from the mapped folder under the nested base',
  )
} finally {
  await browser.close()
  server.close()
}
process.exitCode = failed ? 1 : 0
