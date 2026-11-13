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
 *   - a DICOMweb page opens a series from /metadata through a custom (auth)
 *     fetch, sniffing its transfer syntax, and reads a signed MONOCHROME2
 *     JPEG frame as negative data values; a DICOM folder's label and overview
 *     decode to bitmaps and its index reports progress from the worker,
 *   - a TIFF page's JPEG 2000 tile fails clearly until
 *     registerDcm2niixTiffDecoders, then decodes through the mapped
 *     @niivue/dcm2niix,
 *   - int16 and float32 raw-gray TIFF and signed MONOCHROME2 DICOM read back
 *     through the slide fusers on WebGL2 and WebGPU (a WebGPU-capable browser:
 *     full Chromium on a Mac unless PLAYWRIGHT_CHROMIUM_CHANNEL says otherwise),
 *   - the native fetch passed as a source option reads tiles and ICC
 *     (ManifestRangeSource, openSlide), with no "Illegal invocation",
 *   - an /open page loads no format until it opens a TIFF URL (a JPEG tile
 *     through geotiff-rs's WASM by Range) and a DICOM folder (every slide
 *     listed), and never loads Zarr code for them.
 * Synthetic fixtures (fixtures/standalone, dicom-wsi); a few seconds; CI runs it
 * on SwiftShader (niivue-e2e.yml, demo-ext-tile job).
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
// One-tile 16x16 little-endian grey TIFF, BlackIsZero, uncompressed: `bits`
// per sample of SampleFormat `format` (2 int, 3 float); columns 0-4 hold
// lo, 5-10 mid, 11-15 hi.
function greyTiff(bits, format, [lo, mid, hi]) {
  const side = 16
  const bytes = bits / 8
  const tile = Buffer.alloc(side * side * bytes)
  for (let i = 0; i < side * side; i++) {
    const x = i % side
    const v = x < 5 ? lo : x < 11 ? mid : hi
    if (format === 3) tile.writeFloatLE(v, i * 4)
    else tile.writeInt16LE(v, i * 2)
  }
  const entries = [
    [256, 3, 1, side],
    [257, 3, 1, side],
    [258, 3, 1, bits],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [277, 3, 1, 1],
    [322, 3, 1, side],
    [323, 3, 1, side],
    [324, 4, 1, 0],
    [325, 4, 1, tile.length],
    [339, 3, 1, format],
  ]
  const data = 10 + entries.length * 12 + 4
  const b = Buffer.alloc(data + tile.length)
  b.write('II*\0', 0, 'latin1')
  b.writeUInt32LE(8, 4)
  b.writeUInt16LE(entries.length, 8)
  entries.forEach(([tag, type, n, value], i) => {
    const p = 10 + i * 12
    b.writeUInt16LE(tag, p)
    b.writeUInt16LE(type, p + 2)
    b.writeUInt32LE(n, p + 4)
    const v = tag === 324 ? data : value
    if (type === 3) b.writeUInt16LE(v, p + 8)
    else b.writeUInt32LE(v, p + 8)
  })
  tile.copy(b, data)
  return b
}
const b64 = (s) => Buffer.from(s, 'base64')
const TIFFS = {
  'i16.tif': greyTiff(16, 2, [-1000, 0, 1000]),
  'f32.tif': greyTiff(32, 3, [-1, 0, 1]),
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
  '@niivue/nv-ext-tile/open': './ext/open.js',
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
  // streamOmeZarr owns its manager and workers: replacing the volume or
  // destroying the viewer releases both (managers, live workers per step).
  'stream.html': page(`
    const { default: NiiVue } = await import('@niivue/niivue')
    const { streamOmeZarr } = await import('@niivue/nv-ext-tile/zarr')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachTo('gl')
    const url = new URL('./fixtures/tiny.ome.zarr', location.href).href
    // Up to 300 ms for the live workers to reach the count a correct release leaves.
    const settle = async (live) => {
      for (let i = 0; i < 30 && window.liveWorkers !== live; i++) await new Promise((r) => setTimeout(r, 10))
    }
    const stream = async () => {
      window.countWorkers = true
      await streamOmeZarr(nv, url)
      await settle(1)
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
    await settle(0)
    steps.push(step())
    await stream()
    steps.push(step())
    // Removed while it initializes (every read held 100 ms).
    const slow = new URL('./slow/fixtures/tiny.ome.zarr', location.href).href
    await nv.removeAllVolumes()
    window.countWorkers = true
    const pending = streamOmeZarr(nv, slow, { replace: true })
    while (!nv.volumes.length) await new Promise((r) => setTimeout(r, 20))
    await nv.removeAllVolumes()
    await pending
    await settle(0)
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
    const opening = streamOmeZarr(nv2, url)
    nv2.destroy()
    const rejected = await opening.then(() => false, () => true)
    await settle(0)
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
    const progress = []
    const index = await indexDicomWsi(files, { onProgress: (d, t) => progress.push([d, t]) })
    window.countWorkers = false
    const indexWorkers = [window.madeWorkers, window.liveWorkers, window.workerIndexes]
    // Aborted while the worker module loads: rejects, starts no worker.
    const made = window.madeWorkers
    window.countWorkers = true
    const early = new AbortController()
    const aborting = indexDicomWsi(files, { signal: early.signal })
    early.abort()
    const earlyAbort = [await aborting.then(() => 'resolved', (e) => e?.name), window.madeWorkers - made, window.liveWorkers]
    window.countWorkers = false
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
    const { associatedImages, associatedImageBitmap } = await import('@niivue/nv-ext-tile/dicom')
    const wsi = await Promise.all(['bot.dcm', 'label.dcm', 'overview.dcm'].map(async (n) =>
      new File([await (await fetch('./wsi/' + n)).arrayBuffer()], n)))
    const wsiIndex = await indexDicomWsi(wsi)
    const associated = await Promise.all(associatedImages(wsiIndex, wsiIndex.slides[0]).map(async (a) => {
      const bitmap = await associatedImageBitmap(a, wsi)
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return [a.kind, bitmap.width, bitmap.height, [...ctx.getImageData(3, 2, 1, 1).data.slice(0, 3)]]
    }))
    return {
      shared,
      indexWorkers,
      earlyAbort,
      progress,
      slides: wsiIndex.slides.length,
      associated,
      skipped: index.skipped,
      jls: await show(by('jls'), true),
      jp2kRaw: await show(by('jp2k'), false),
      jp2kIcc: await show(by('jp2k'), true),
    }`),
}

// Workers blocked by CSP: the same tiles, read on this thread.
PAGES['zarr-slide-csp.html'] = PAGES['zarr-slide.html'].replace(
  '<meta charset="utf-8">',
  `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="worker-src 'none'">`,
)

// DICOMweb: a series served from /metadata and /frames (dicomweb/ route).
PAGES['dicomweb.html'] = page(`
    const { NVSlide } = await import('@niivue/niivue/webgl2')
    const { DicomWebWsiSource, indexDicomWsiMetadata } = await import('@niivue/nv-ext-tile/dicom')
    const seriesUrl = new URL('./dicomweb/studies/1.2.3.1/series/S', location.href).href
    let fetched = 0
    const fetch2 = (url, init) => {
      fetched++
      return fetch(url, { ...init, headers: { ...init?.headers, Authorization: 'Bearer t' } })
    }
    const metadata = await (await fetch2(seriesUrl + '/metadata')).json()
    const index = indexDicomWsiMetadata(metadata)
    const source = await DicomWebWsiSource.open(index.slides[0], { seriesUrl, fetch: fetch2 })
    const syntax = source.manifest.levels[0].transferSyntaxUid
    const slide = NVSlide.fromSource(source)
    const [s] = await slide.loadSampleAt(5, 5)
    slide.dispose()
    return { syntax, sampleType: source.manifest.levels[0].sampleType, fetched, stored: s.stored, value: s.value, exact: s.exact }`)

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
    const j2kUnregistered = await tile('j2k.tif')
    registerDcm2niixTiffDecoders()
    const j2k = await tile('j2k.tif')
    return { j2kUnregistered, j2k, unhandled: window.unhandled ?? null }`)

// The opener loads a format's code only when a slide of it opens.
PAGES['open.html'] = page(`
    const { openSlide } = await import('@niivue/nv-ext-tile/open')
    const loaded = () => performance.getEntriesByType('resource').map((e) => e.name.split('/ext/')[1]).filter(Boolean)
    const atImport = loaded()
    const tiff = await openSlide('./tiff/jpeg.tif')
    const source = await tiff.candidates[0].open()
    const level = source.manifest.levels[0]
    const jpeg = [...(await source.fetchTileBytes(level, level.tiles[0], 'open')).slice(0, 4)]
    source.dispose()
    const files = await Promise.all(['colors.dcm', 'paths.dcm'].map(async (n) =>
      new File([await (await fetch('./wsi/' + n)).arrayBuffer()], n)))
    const dicom = await openSlide(files)
    return { atImport, jpeg, kinds: [tiff.kind, dicom.kind], dicomCandidates: dicom.candidates.length,
      slides: dicom.index.slides.length, after: loaded() }`)

// Raw-gray i16/f32 TIFF and signed MONOCHROME2 DICOM through the real fusers,
// read back on both backends. Run in a WebGPU-capable browser (below).
const GPU_PAGE = page(`
    const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('@niivue/niivue')
    const { TiffSlideSource } = await import('@niivue/nv-ext-tile/tiff')
    const { DicomWsiSource, indexDicomWsi } = await import('@niivue/nv-ext-tile/dicom')
    const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)))
    // The level-0 RGBA of a slide drawn 1:1, nearest, on one backend.
    const readback = async (open, window, backend) => {
      const source = await open()
      const slide = NVSlide.fromSource(source)
      const { width: W, height: H, levels } = slide.manifest
      for (const t of levels[0].tiles) if (t) await slide.loadSampleAt(t.x * levels[0].tileWidth, t.y * levels[0].tileHeight)
      slide.setChannel(0, window)
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      document.body.appendChild(canvas)
      const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
      slide.setViewport({ centerX: W / 2, centerY: H / 2, scale: 1 })
      let renderer
      if (backend === 'webgpu') renderer = await SlideRendererGPU.create(canvas, {})
      else {
        renderer = new SlideRenderer()
        renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true }))
      }
      renderer.isNearestInterpolation = true
      renderer.render([slide], screen)
      // Read in the draw's task: a WebGPU canvas drops its texture once presented.
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      const px = (x, y) => ctx.getImageData(x, y, 1, 1).data[0]
      const [s] = await slide.loadSampleAt(2, 2)
      const out = { W, H, px, stored: s.stored, sampleType: slide.manifest.levels[0].sampleType }
      renderer.destroy()
      canvas.remove()
      slide.dispose()
      return out
    }
    const files = [new File([await (await fetch('./wsi/monosigned.dcm')).arrayBuffer()], 'monosigned.dcm')]
    const index = await indexDicomWsi(files)
    const cases = {
      i16: [() => TiffSlideSource.fromUrl('./tiff/i16.tif'), { calMin: -1000, calMax: 1000 }],
      f32: [() => TiffSlideSource.fromUrl('./tiff/f32.tif'), { calMin: -1, calMax: 1 }],
      signed: [async () => new DicomWsiSource(index.slides[0], files), { calMin: -128, calMax: 127 }],
    }
    const out = { gpu }
    for (const backend of gpu ? ['webgl2', 'webgpu'] : ['webgl2'])
      for (const [name, [open, window]] of Object.entries(cases)) {
        const r = await readback(open, window, backend)
        out[name + ' ' + backend] = name === 'signed'
          ? { gray: r.px(Math.floor(r.W / 2), Math.floor(r.H / 2)), stored: r.stored, sampleType: r.sampleType }
          : { gray: [r.px(2, 8), r.px(7, 8), r.px(13, 8)], stored: r.stored, sampleType: r.sampleType }
      }
    return out`)

// The native fetch passed as an option: a source that stores it and calls it
// as a method gives it the wrong receiver ("Illegal invocation" in Chromium).
PAGES['nativefetch.html'] = page(`
    const { ManifestRangeSource } = await import('@niivue/niivue')
    const { openSlide } = await import('@niivue/nv-ext-tile/open')
    const host = { resolveUrl: (u) => u, addWireBytes() {}, rangeHit() {}, rangeFallback() {},
      pushRangeEvent() {}, updateRangeEvent() {}, channelInfoChanged() {} }
    const read = async (source) => {
      source.bind(host)
      const level = source.manifest.levels[0]
      return [[...(await source.fetchTileBytes(level, level.tiles[0], 't'))], [...(await source.fetchIccProfile())]]
    }
    const url = new URL('./manifest.json', location.href).href
    const manifest = await (await fetch(url)).json()
    const direct = await read(new ManifestRangeSource(manifest, { fetch, baseUrl: url }))
    const opened = await openSlide(url, { fetch })
    const viaOpen = await read(await opened.candidates[0].open())
    const tiff = await (await openSlide('./tiff/jpeg.tif', { fetch })).candidates[0].open()
    const tl = tiff.manifest.levels[0]
    const tile = [...(await tiff.fetchTileBytes(tl, tl.tiles[0], 't')).slice(0, 4)]
    tiff.dispose()
    return { direct, viaOpen, tile }`)

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
      for (let i = 0; i < 60 && slide.stats.completed + slide.stats.failures < slide.manifest.levels[0].tiles.filter(Boolean).length; i++) {
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

// monosigned's metadata without its TransferSyntaxUID, so open sniffs a frame.
const WSI = join(PKG, 'fixtures', 'dicom-wsi')
async function dicomwebMetadata() {
  const json = JSON.parse(await readFile(join(WSI, 'monosigned.json'), 'utf8'))
  delete json['00020010']
  return json
}
// Every monosigned frame is the same grey JPEG: serve its first codestream.
async function dicomwebFrame() {
  const dcm = await readFile(join(WSI, 'monosigned.dcm'))
  const start = dcm.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  return dcm.subarray(start, dcm.indexOf(Buffer.from([0xff, 0xd9]), start) + 2)
}

const server = createServer(async (req, res) => {
  let path
  try {
    path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  } catch {
    return res.writeHead(400).end()
  }
  if (!path.startsWith(BASE)) return res.writeHead(404).end()
  let rest = path.slice(BASE.length)
  // slow/<path>: the same file, 100 ms later (a store still loading).
  if (rest.startsWith('slow/')) {
    await new Promise((r) => setTimeout(r, 100))
    rest = rest.slice('slow/'.length)
  }
  const html = rest === 'gpu.html' ? GPU_PAGE : PAGES[rest]
  if (html) return res.writeHead(200, { 'content-type': 'text/html' }).end(html)
  if (rest === 'tiny.nii') return res.writeHead(200).end(tinyNifti())
  // A byte-range manifest over tiny.nii: one 2x1 raw-rgba tile, its 8 voxels.
  if (rest === 'manifest.json')
    return res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'm',
        width: 2,
        height: 1,
        iccProfile: { url: 'tiny.nii', offset: 352, length: 8 },
        levels: [
          {
            index: 0,
            width: 2,
            height: 1,
            tileWidth: 2,
            tileHeight: 1,
            columns: 1,
            rows: 1,
            codec: 'raw-rgba',
            fileUrl: 'tiny.nii',
            tiles: [
              { x: 0, y: 0, width: 2, height: 1, offset: 352, length: 8 },
            ],
          },
        ],
      }),
    )
  if (rest.startsWith('dicomweb/')) {
    if (req.headers.authorization !== 'Bearer t')
      return res.writeHead(401).end()
    if (rest.endsWith('/metadata'))
      return res
        .writeHead(200, { 'content-type': 'application/dicom+json' })
        .end(JSON.stringify([await dicomwebMetadata()]))
    if (/\/frames\/\d+$/.test(rest))
      return res
        .writeHead(200, {
          'content-type': 'multipart/related; type="image/jpeg"; boundary=B',
        })
        .end(
          Buffer.concat([
            Buffer.from('--B\r\nContent-Type: image/jpeg\r\n\r\n'),
            await dicomwebFrame(),
            Buffer.from('\r\n--B--\r\n'),
          ]),
        )
    return res.writeHead(404).end()
  }
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
    nifti.result.dims?.[1] === 2 &&
      !nifti.requests.some((u) => /^(ext|dcm2niix)\//.test(u)),
    `nifti: loaded ${JSON.stringify(nifti.result.dims)}, no extension or dcm2niix request`,
  )

  const zarr = results['zarr.html']
  check(
    JSON.stringify(zarr.result.whole?.dims?.slice(1, 4)) === '[4,3,2]' &&
      zarr.result.whole.max === 23 &&
      zarr.result.streamed?.length === 24 &&
      zarr.result.streamed.every((v, i) => v === i),
    `zarr: whole level and streamed brick hold 0..23 ${JSON.stringify(zarr.result.whole)}`,
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
    /has no built-in decoder/.test(tiff.result.j2kUnregistered) &&
      JSON.stringify(tiff.result.j2k) === '[0,0,128,255]' &&
      !tiff.result.unhandled &&
      !tiff.requests.some((u) =>
        /^ext\/(dicom|zarr)\.js|chunks\/blosc-/.test(u),
      ),
    `tiff: JPEG 2000 tile fails clearly, then decodes through dcm2niix, no /dicom or /zarr code ${JSON.stringify(tiff.result)}`,
  )
  const opened = results['open.html'].result
  check(
    opened.atImport?.includes('open.js') &&
      !opened.atImport.some((u) =>
        /^(tiff|dicom|zarr)\.js$|(tiff|zarr|lzw|jpeg|lerc|blosc)-/.test(u),
      ) &&
      !opened.after?.some((u) => /zarr|blosc-/.test(u)),
    `open: importing /open loads no format, TIFF and DICOM load no Zarr code (${JSON.stringify(opened.atImport)}; ${opened.after?.join(', ')})`,
  )
  check(
    near(opened.jpeg ?? [], [200, 30, 30, 255]) &&
      JSON.stringify(opened.kinds) === '["tiff","dicom"]' &&
      opened.dicomCandidates === opened.slides &&
      opened.slides > 1,
    `open: a TIFF URL (JPEG tile through geotiff-rs) and a DICOM folder, every slide listed ${JSON.stringify({ ...opened, atImport: undefined, after: undefined })}`,
  )
  const channel =
    process.env.PLAYWRIGHT_CHROMIUM_CHANNEL ??
    (process.platform === 'darwin' && !process.env.CI ? 'chromium' : undefined)
  // The headless shell's WebGPU canvas presents only on Vulkan SwiftShader
  // (niivue e2e/launchOptions.ts), so CI's Linux job needs these flags. Every
  // page above has reported; close its browser first, since two Chromiums on
  // one software GPU lost the device on CI's Ubuntu runner (niivue-e2e.yml).
  await browser.close()
  const gpuBrowser = await chromium.launch({
    channel,
    args: [
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      ...(channel
        ? []
        : [
            '--use-angle=swiftshader',
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
          ]),
    ],
  })
  try {
    const tab = await gpuBrowser.newPage()
    tab.on('pageerror', (e) => check(false, `gpu.html: ${e.message}`))
    await tab.goto(`${origin}gpu.html`)
    await tab.waitForFunction(() => window.result, null, { timeout: 30000 })
    const g = await tab.evaluate(() => window.result)
    if (g.error) check(false, `gpu.html: ${g.error}`)
    // Without a WebGPU adapter the webgpu results are missing and its check fails.
    for (const backend of ['webgl2', 'webgpu']) {
      const i16 = g[`i16 ${backend}`]
      const f32 = g[`f32 ${backend}`]
      const signed = g[`signed ${backend}`]
      check(
        i16?.sampleType === 'i16' &&
          i16.stored === -1000 &&
          near(i16.gray, [0, 128, 255], 2) &&
          f32?.sampleType === 'f32' &&
          f32.stored === -1 &&
          near(f32.gray, [0, 128, 255], 2) &&
          signed?.sampleType === 'i16' &&
          signed.stored === -56 &&
          Math.abs(signed.gray - 72) <= 3,
        `gpu ${backend}: TIFF int16 in -1000..1000 and float32 in -1..1, signed MONOCHROME2 DICOM -56 in -128..127 ${JSON.stringify({ gpu: g.gpu, i16, f32, signed })}`,
      )
    }
  } finally {
    await gpuBrowser.close()
  }
  const native = results['nativefetch.html'].result
  const voxels = '[[1,2,3,4,5,6,7,8],[1,2,3,4,5,6,7,8]]'
  check(
    JSON.stringify(native.direct) === voxels &&
      JSON.stringify(native.viaOpen) === voxels &&
      near(native.tile ?? [], [200, 30, 30, 255]),
    `native fetch as an option: ManifestRangeSource, openSlide (manifest, TIFF) read tiles and ICC ${JSON.stringify(native)}`,
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

  const dicom = results['dicom.html']
  const d = dicom.result
  check(
    d.shared &&
      d.skipped?.length === 0 &&
      dicom.requests.some(
        (u) => u.startsWith('dcm2niix/') && u.endsWith('.wasm'),
      ),
    'dicom: dcm2niix WASM from the mapped folder under the nested base; its decoders registered via @niivue/niivue are visible from the WebGPU entry',
  )
  check(
    d.indexWorkers?.join() === '1,0,1' &&
      d.progress?.join(';') === '1,2;2,2' &&
      JSON.stringify(d.earlyAbort) === '["AbortError",0,0]',
    `dicom: indexed in one inlined worker [made, live, answered] with progress, ended; an abort while it loads starts none ${JSON.stringify(d)}`,
  )
  const [red, yellow, green, blue] = [
    [255, 0, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]
  check(
    d.jls?.failed === 0 &&
      near(d.jls.rgb[0], green) &&
      near(d.jls.rgb[1], blue) &&
      d.jp2kRaw?.failed === 0 &&
      near(d.jp2kRaw.rgb[0], red) &&
      near(d.jp2kRaw.rgb[1], yellow),
    `dicom: JPEG-LS and JPEG 2000 tiles, colour management off ${JSON.stringify([d.jls, d.jp2kRaw])}`,
  )
  // The profile shows device R as sRGB blue and G as red: red -> blue, yellow -> magenta.
  check(
    near(d.jp2kIcc?.rgb[0] ?? [], blue) &&
      near(d.jp2kIcc.rgb[1], [255, 0, 255]),
    `dicom: ICC profile applied ${JSON.stringify(d.jp2kIcc)}`,
  )
  check(
    d.slides === 1 &&
      JSON.stringify(d.associated?.map((a) => a.slice(0, 3))) ===
        '[["label",16,8],["overview",16,16]]' &&
      near(d.associated[0][3], [48, 64, 7], 0) &&
      near(d.associated[1][3], [10, 120, 200]),
    `dicom: label and overview are associated, never slides, and decode ${JSON.stringify(d.associated)}`,
  )
  const web = results['dicomweb.html'].result
  check(
    web.syntax === '1.2.840.10008.1.2.4.50' &&
      web.fetched === 3 &&
      web.sampleType === 'i16' &&
      web.stored === -56 &&
      web.value === -122 &&
      web.exact,
    `dicomweb: custom fetch for metadata, sniff and frame; signed JPEG reads -56 stored, -122 value ${JSON.stringify(web)}`,
  )
} finally {
  await browser.close()
  server.close()
}
process.exitCode = failed ? 1 : 0
