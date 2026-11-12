import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// P0 contracts (plan-tile-final-contracts section 10) that need pixels.
// S1: a raw-gray bytes slide with a one-entry channelInfo draws exactly as the
// same slide without one (grey, windowed the same) on both backends.
// RN4 (render matches the removed draw) is slide-frame-plan.spec.ts.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`one-entry channelInfo draws as no channelInfo (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const W = 24, H = 12
      const samples = new Uint16Array(W * H)
      for (let i = 0; i < samples.length; i++) samples[i] = (i * 2731) % 4096
      const manifest = (channelInfo) => ({
        id: 'g', name: 'g', width: W, height: H, dtype: 'uint16', channels: 'gray',
        levels: [{ index: 0, width: W, height: H, downsample: 1, tileWidth: W, tileHeight: H,
          columns: 1, rows: 1, codec: 'raw-gray', bitsStored: 12, tiles: [{ x: 0, y: 0, width: W, height: H }] }],
        ...(channelInfo ? { channelInfo } : {}),
      })
      const slides = [undefined, [{ name: 'c', active: true }]].map((info) => {
        const slide = NVSlide.fromSource({
          manifest: manifest(info), bind() {},
          fetchTileBytes: async () => new Uint8Array(samples.slice().buffer),
        })
        slide.setViewport({ centerX: W / 2, centerY: H / 2, scale: 1 })
        return slide
      })
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      document.body.appendChild(canvas)
      const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
      let renderer
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        renderer = new SlideRenderer()
        renderer.init(gl)
      }
      renderer.isNearestInterpolation = true
      for (let i = 0; i < 100 && slides.some((s) => !s.cachedTile(s.tileKey(s.manifest.levels[0], { x: 0, y: 0 }))); i++) {
        for (const s of slides) s.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const frame = (draw) => {
        draw()
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        return [...ctx.getImageData(0, 0, W, H).data]
      }
      const [plain, one] = slides.map((s) => frame(() => renderer.render([s], screen)))
      const colormaps = slides.map((s) => s.channels[0].colormap)
      renderer.destroy()
      canvas.remove()
      for (const s of slides) s.dispose()
      const grey = plain.every((v, i) => i % 4 === 3 || v === plain[i - (i % 4)])
      const levels = new Set(plain.filter((_, i) => i % 4 === 0)).size
      return { plain, one, colormaps, grey, levels }
    })()`)
    const r = result as {
      skip?: string
      plain: number[]
      one: number[]
      colormaps: string[]
      grey: boolean
      levels: number
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.colormaps).toEqual(['gray', 'gray'])
    expect(r.grey).toBe(true)
    expect(r.levels).toBeGreaterThan(10)
    expect(r.one).toEqual(r.plain)
  })
}
