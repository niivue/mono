import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// Two slides sharing a tile key (both L0/0/0) in one frame: each must draw its
// own tile. Tile textures were cached by tile key alone, so the second slide's
// upload replaced the first's: WebGPU destroyed a texture the open pass bound
// and dropped the whole frame (black, no console error); GL drew correctly but
// re-uploaded both tiles every frame. Two frames, so the second reads the cache.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`slides sharing a tile key draw their own tiles (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const n = 4, cell = 16, width = 2 * cell
      const manifest = {
        id: 'same', name: 'same', width: n, height: n, dtype: 'uint8', channels: 'rgba',
        levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
          columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
      }
      const colours = [[255, 0, 0], [0, 0, 255]]
      const screen = { widthCss: width, heightCss: cell, devicePixelRatio: 1 }
      const slides = colours.map((rgb, k) => {
        const bytes = new Uint8Array(n * n * 4)
        for (let i = 0; i < n * n; i++) bytes.set([...rgb, 255], 4 * i)
        const slide = NVSlide.fromSource({ manifest, bind() {}, fetchTileBytes: async () => bytes })
        // Slide k fills cell k.
        slide.setViewport({
          centerX: n / 2 - (cell * (k + 0.5) - width / 2) / (cell / n),
          centerY: n / 2,
          scale: cell / n,
        })
        return slide
      })
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = cell
      canvas.style.width = width + 'px'
      canvas.style.height = cell + 'px'
      document.body.appendChild(canvas)
      let renderer, draw
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        draw = () => renderer.render(slides, screen)
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        renderer = new SlideRenderer()
        renderer.init(gl)
        draw = () => renderer.draw(gl, slides, screen)
      }
      for (let i = 0; i < 100 && slides.some((s) => !s.cachedTile('L0/0/0')); i++) {
        for (const s of slides) s.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const device = renderer._device
      const errors = []
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const centres = async () => {
        device?.pushErrorScope('validation')
        draw()
        const c = document.createElement('canvas')
        c.width = width
        c.height = cell
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, width, cell).data
        const error = await device?.popErrorScope()
        if (error) errors.push(error.message)
        return slides.map((_, k) => {
          const i = 4 * ((cell >> 1) * width + cell * k + (cell >> 1))
          return [...px.slice(i, i + 3)]
        })
      }
      const frames = [await centres(), await centres()]
      const textures = renderer._textures.size
      renderer.destroy()
      canvas.remove()
      return { frames, errors, textures, expected: colours }
    })()`)
    const r = result as {
      skip?: string
      frames: number[][][]
      errors: string[]
      textures: number
      expected: number[][]
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.errors).toEqual([])
    expect(r.frames).toEqual([r.expected, r.expected])
    expect(r.textures).toBe(2)
  })
}
