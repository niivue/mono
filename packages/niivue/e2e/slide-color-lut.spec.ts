import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// P5: a slide's ICC lookup table is applied once, in the slide shader, on both
// backends. A pure-red tile with a table that swaps red and blue must draw blue;
// turning colour management off must draw red again, without re-decoding.
//
// WebGPU is skipped when the runner has no adapter. webgpu-aa also checks that
// the 4x multisample target validates and resolves to the same colour.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu', 'webgpu-aa'] as const) {
  test(`slide colour table swaps red and blue (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}'.startsWith('webgpu')) {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const n = 4
      const manifest = {
        id: 'lut', name: 'lut', width: n, height: n, dtype: 'uint8', channels: 'rgba',
        levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
          columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
      }
      const red = new Uint8Array(n * n * 4)
      for (let i = 0; i < n * n; i++) red.set([255, 0, 0, 255], 4 * i)
      // 2^3 table, red fastest: entry (r, g, b) holds (b, g, r).
      const swap = new Uint8Array(32)
      for (let e = 0; e < 8; e++)
        swap.set([e & 4 ? 255 : 0, e & 2 ? 255 : 0, e & 1 ? 255 : 0, 255], 4 * e)
      NVSlide.registerIccTransform(async () => ({ size: 2, data: swap }))
      const slide = NVSlide.fromSource({
        manifest,
        bind() {},
        fetchTileBytes: async () => red,
        fetchIccProfile: async () => new Uint8Array(4),
      })
      NVSlide.registerIccTransform(null)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      canvas.style.width = canvas.style.height = '64px'
      document.body.appendChild(canvas)
      const screen = { widthCss: 64, heightCss: 64, devicePixelRatio: 1 }
      slide.fitToScreen(screen, 1)
      let draw
      if ('${backend}'.startsWith('webgpu')) {
        const r = await SlideRendererGPU.create(canvas, { antialias: '${backend}' === 'webgpu-aa' })
        if (!r) return { skip: 'SlideRendererGPU unavailable' }
        draw = () => r.render([slide], screen)
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        const r = new SlideRenderer()
        r.init(gl)
        draw = () => r.draw(gl, [slide], screen)
      }
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const centre = async () => {
        draw()
        const c = document.createElement('canvas')
        c.width = c.height = 64
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        return [...ctx.getImageData(32, 32, 1, 1).data.slice(0, 3)]
      }
      // Wait for the tile and the table.
      for (let i = 0; i < 100 && (!slide.cachedTileBitmap('L0/0/0') || !slide.colorLut); i++) {
        slide.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const managed = await centre()
      slide.colorManagement = false
      const unmanaged = await centre()
      return { managed, unmanaged }
    })()`)
    const r = result as {
      skip?: string
      managed?: number[]
      unmanaged?: number[]
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.managed).toEqual([0, 0, 255])
    expect(r.unmanaged).toEqual([255, 0, 0])
  })
}

// The same table on a slide plane in the 3D render tile (slidePlaneRender.ts),
// seen from above with the volume hidden.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`slide plane colour table swaps red and blue (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const lib = await import('/src/index.ts')
      const n = 4
      const manifest = {
        id: 'lut', name: 'lut', width: n, height: n, dtype: 'uint8', channels: 'rgba',
        levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
          columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
      }
      const red = new Uint8Array(n * n * 4)
      for (let i = 0; i < n * n; i++) red.set([255, 0, 0, 255], 4 * i)
      const swap = new Uint8Array(32)
      for (let e = 0; e < 8; e++)
        swap.set([e & 4 ? 255 : 0, e & 2 ? 255 : 0, e & 1 ? 255 : 0, 255], 4 * e)
      lib.NVSlide.registerIccTransform(async () => ({ size: 2, data: swap }))
      const slide = lib.NVSlide.fromSource({
        manifest,
        bind() {},
        fetchTileBytes: async () => red,
        fetchIccProfile: async () => new Uint8Array(4),
      })
      lib.NVSlide.registerIccTransform(null)
      const size = 64
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.style.cssText = 'width:' + size + 'px;height:' + size + 'px'
      document.body.appendChild(canvas)
      const nv = new lib.default({
        backend: '${backend}', devicePixelRatio: 1, isAntiAlias: false,
        backgroundColor: [0, 0, 0, 1], azimuth: 0, elevation: 90,
        isOrientCubeVisible: false, isOrientationTextVisible: false,
        isColorbarVisible: false, is3DCrosshairVisible: false, crosshairWidth: 0,
      })
      await nv.attachToCanvas(canvas)
      if (nv.backend !== '${backend}') return { skip: 'fell back to ' + nv.backend }
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadVolumes([{ url: (${syntheticVolume})({ n: 16 }), opacity: 0 }])
      const transform = lib.axialPlaneTransform(n, n, {
        xmin: -20, xmax: 20, ymin: -20, ymax: 20, z: 0, flipY: false,
      })
      nv.setSlidePlane(slide, { pixelToWorld: transform, levelIndex: 0 })
      for (let i = 0; i < 100 && (!slide.cachedTileBitmap('L0/0/0') || !slide.colorLut); i++) {
        nv.getCanvasImage()
        await new Promise((res) => setTimeout(res, 20))
      }
      const centre = () => {
        const img = nv.getCanvasImage()
        const i = 4 * ((img.height >> 1) * img.width + (img.width >> 1))
        return [...img.data.slice(i, i + 3)]
      }
      const managed = centre()
      slide.colorManagement = false
      const unmanaged = centre()
      nv.destroy()
      canvas.remove()
      return { managed, unmanaged }
    })()`)
    const r = result as {
      skip?: string
      managed?: number[]
      unmanaged?: number[]
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.managed).toEqual([0, 0, 255])
    expect(r.unmanaged).toEqual([255, 0, 0])
  })
}

// Renderers keep at most 8 table textures (gl/wgpu colorLut.ts, LRU). Ten
// slides with ten tables in one frame evict mid-frame; every slide must still
// draw its own table, in that frame (WebGPU must not destroy a table a pass
// still binds) and the next (GL must not reuse a deleted texture).
const TABLES = 10
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`more than 8 slide colour tables draw after eviction (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const n = 4, count = ${TABLES}, cell = 16, width = cell * count
      // Level index k: tile textures are cached by tile key, shared across a
      // renderer's slides, so each slide needs its own key (L{k}/0/0).
      const manifest = (k) => ({
        id: 'lut' + k, name: 'lut', width: n, height: n, dtype: 'uint8', channels: 'rgba',
        levels: [{ index: k, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
          columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
      })
      const red = new Uint8Array(n * n * 4)
      for (let i = 0; i < n * n; i++) red.set([255, 0, 0, 255], 4 * i)
      const colour = (k) => [25 * k, 255 - 25 * k, (80 * k) % 256]
      // Profile k bakes to a 2^3 table holding colour k everywhere.
      NVSlide.registerIccTransform(async (profile) => {
        const data = new Uint8Array(32)
        for (let e = 0; e < 8; e++) data.set([...colour(profile[0]), 255], 4 * e)
        return { size: 2, data }
      })
      const screen = { widthCss: width, heightCss: cell, devicePixelRatio: 1 }
      const slides = []
      for (let k = 0; k < count; k++) {
        const slide = NVSlide.fromSource({
          manifest: manifest(k),
          bind() {},
          fetchTileBytes: async () => red,
          fetchIccProfile: async () => new Uint8Array([k]),
        })
        // Slide k fills cell k: its centre (n / 2) at screen x = cell * (k + 0.5).
        slide.setViewport({
          centerX: n / 2 - (cell * (k + 0.5) - width / 2) / (cell / n),
          centerY: n / 2,
          scale: cell / n,
        })
        slides.push(slide)
      }
      NVSlide.registerIccTransform(null)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = cell
      canvas.style.width = width + 'px'
      canvas.style.height = cell + 'px'
      document.body.appendChild(canvas)
      let renderer, draw, glError = () => 0
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        draw = () => renderer.render(slides, screen)
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        renderer = new SlideRenderer()
        renderer.init(gl)
        draw = () => renderer.draw(gl, slides, screen)
        glError = () => gl.getError()
      }
      for (let i = 0; i < 100 && slides.some((s, k) => !s.cachedTileBitmap('L' + k + '/0/0') || !s.colorLut); i++) {
        for (const s of slides) s.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const tables = new Set(slides.map((s) => s.colorLut)).size
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const centres = () => {
        draw()
        const c = document.createElement('canvas')
        c.width = width
        c.height = cell
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, width, cell).data
        return slides.map((_, k) => {
          const i = 4 * ((cell >> 1) * width + cell * k + (cell >> 1))
          return [...px.slice(i, i + 3)]
        })
      }
      const frames = [centres(), centres()]
      const error = glError()
      renderer.destroy()
      canvas.remove()
      return { tables, frames, error, expected: slides.map((_, k) => colour(k)) }
    })()`)
    const r = result as {
      skip?: string
      tables: number
      frames: number[][][]
      error: number
      expected: number[][]
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.tables).toBe(TABLES)
    expect(r.frames).toEqual([r.expected, r.expected])
    expect(r.error).toBe(0)
  })
}
