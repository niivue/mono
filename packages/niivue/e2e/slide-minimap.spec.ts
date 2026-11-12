import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// The UIKit slide minimap draws NVSlide.thumbnailBitmap: the coarsest level
// composited on the CPU, scalar tiles through their channels (#159 dropped the
// per-tile bitmaps it used to copy). A two-channel slide (red 200, green 100,
// max) must show (200, 100, 0) in the minimap, and (200, 0, 0) once green is
// hidden. The main view looks away from the slide, so only the minimap draws
// it. Requires `nx build uikit` (see uikit-overlay-hook.spec.ts). WebGPU is
// skipped without an adapter.

const uikitDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../uikit/dist/uikit.js',
)

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`the minimap shows fused scalar tiles (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const { UIKitSlideMinimapOverlay } = await import('/@fs${uikitDist}')
      const tiles = (n) => Array.from({ length: n }, (_, x) => ({ x, y: 0, width: 16, height: 16 }))
      const manifest = {
        id: 'mini', name: 'mini', width: 32, height: 16, dtype: 'uint8', channels: 'planar',
        channelInfo: [
          { name: 'r', colormap: 'red', window: { calMin: 0, calMax: 255 }, active: true },
          { name: 'g', colormap: 'green', window: { calMin: 0, calMax: 255 }, active: true },
        ],
        levels: [
          { index: 0, width: 32, height: 16, downsample: 1, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1, bitsStored: 8, tiles: tiles(2) },
          { index: 1, width: 16, height: 8, downsample: 2, tileWidth: 16, tileHeight: 16, columns: 1, rows: 1, bitsStored: 8,
            tiles: [{ x: 0, y: 0, width: 16, height: 8 }] },
        ],
      }
      const values = [200, 100]
      const slide = NVSlide.fromSource({
        manifest,
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async (_level, tile, channels) => {
          const n = tile.width * tile.height
          const samples = new Uint8Array(n * channels.length)
          channels.forEach((c, p) => samples.fill(values[c], p * n, (p + 1) * n))
          return { samples, width: tile.width, height: tile.height, bitsStored: 8, planes: channels.length }
        },
      })
      const W = 200, H = 120
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      document.body.appendChild(canvas)
      const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
      // Far from the slide: the main view draws only its background.
      slide.setViewport({ centerX: -1000, centerY: -1000, scale: 1 })
      const minimap = new UIKitSlideMinimapOverlay(slide, { corner: 'top-left', sizeCss: 64, marginCss: 4 })
      let renderer, draw
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        draw = () => renderer.render([slide], screen)
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
        renderer = new SlideRenderer()
        renderer.init(gl)
        draw = () => renderer.render([slide], screen)
      }
      renderer.overlayDraw = (frame) => minimap.drawOverlay(frame)
      const { image } = minimap.layoutFor(W, H, 1)
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const centre = () => {
        draw()
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const x = Math.round(image.x + image.width / 2), y = Math.round(image.y + image.height / 2)
        return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]
      }
      // The minimap requests the coarsest tile itself.
      for (let i = 0; i < 100 && !slide.cachedTile(slide.tileKey(slide.manifest.levels[1], { x: 0, y: 0 })); i++) {
        draw()
        await new Promise((res) => setTimeout(res, 20))
      }
      const both = centre()
      slide.setChannel(1, { visible: false })
      // A channel change recomposes at most every 100 ms (window/level drags):
      // the next frame after that interval shows it.
      await new Promise((res) => setTimeout(res, 150))
      const red = centre()
      minimap.destroy()
      renderer.destroy()
      canvas.remove()
      slide.dispose()
      return { both, red }
    })()`)
    const r = result as { skip?: string; both: number[]; red: number[] }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.both).toEqual([200, 100, 0])
    expect(r.red).toEqual([200, 0, 0])
  })
