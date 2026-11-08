import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// P5: a slide's ICC lookup table is applied once, in the slide shader, on both
// backends. A pure-red tile with a table that swaps red and blue must draw blue;
// turning colour management off must draw red again, without re-decoding.
//
// WebGPU is skipped when the runner has no adapter.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`slide colour table swaps red and blue (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
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
      if ('${backend}' === 'webgpu') {
        const r = await SlideRendererGPU.create(canvas)
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
