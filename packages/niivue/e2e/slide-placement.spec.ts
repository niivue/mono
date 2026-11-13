import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// SRC-20: placed tiles (vendor joints) draw each piece cropped at its placed
// origin. 3 frames of 16 px whose seam 1|2 overlaps by `o` px, split at its
// midpoint (contracts section 7): PL2 with o = 4 (placed x 0-13 frame 1, x 14
// frame 2 col 2) and PL3 with o = 3 (a 1.5 px crop through a fractional UV).
// Sample (tile t, col c) holds 20 t + c, shown grey; at 2 device px per placed
// px under nearest sampling every column must read its piece's texel, the same
// on both backends.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  for (const o of [4, 3])
    test(`placed pieces draw cropped at their origin, overlap ${o} (${backend})`, async ({
      page,
    }) => {
      const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
        const o = ${o}, half = o / 2, K = 2
        const pieces = [
          { tile: 0, sx: 0, sy: 0, sw: 16 - half, sh: 16, dx: 0, dy: 0 },
          { tile: 1, sx: half, sy: 0, sw: 16 - half, sh: 16, dx: 16 - half, dy: 0 },
          { tile: 2, sx: 0, sy: 0, sw: 16, sh: 16, dx: 32 - o, dy: 0 },
        ]
        const PW = 48 - o
        const level = {
          index: 0, width: 48, height: 16, downsample: 1, columns: 3, rows: 1,
          tileWidth: 16, tileHeight: 16, bitsStored: 8,
          tiles: [0, 1, 2].map((x) => ({ x, y: 0, width: 16, height: 16 })),
          placement: { width: PW, height: 16, pieces },
        }
        const manifest = {
          id: 'placed', name: 'placed', width: PW, height: 16, dtype: 'uint8',
          channels: 'gray', levels: [level], channelInfo: [{ name: 'g', active: true }],
        }
        const slide = NVSlide.fromSource({
          manifest,
          bind() {},
          fetchTileBytes: async () => { throw new Error('samples only') },
          fetchTileSamples: async (_l, tile) => {
            const samples = new Uint8Array(256)
            for (let i = 0; i < 256; i++) samples[i] = 20 * tile.x + (i % 16)
            return { samples, width: 16, height: 16, bitsStored: 8, planes: 1 }
          },
        })
        const W = Math.ceil(PW * K), H = 16 * K
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        document.body.appendChild(canvas)
        const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
        slide.setViewport({ centerX: W / K / 2, centerY: 8, scale: K })
        let renderer
        if ('${backend}' === 'webgpu') {
          renderer = await SlideRendererGPU.create(canvas)
          if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        } else {
          renderer = new SlideRenderer()
          renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true }))
        }
        renderer.isNearestInterpolation = true
        const keys = level.tiles.map((t) => slide.tileKey(slide.manifest.levels[0], t))
        for (let i = 0; i < 100 && keys.some((k) => !slide.cachedTile(k)); i++) {
          slide.requestVisibleTiles(screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        renderer.render([slide], screen)
        const c = document.createElement('canvas')
        c.width = W
        c.height = H
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const row = ctx.getImageData(0, H / 2, W, 1).data
        const got = [], want = []
        for (let x = 0; x < W; x++) {
          const p = (x + 0.5) / K
          if (p >= PW) break
          const piece = pieces.findLast((q) => p >= q.dx)
          want.push(20 * piece.tile + Math.floor(piece.sx + p - piece.dx))
          got.push(row[x * 4])
        }
        renderer.destroy()
        canvas.remove()
        slide.dispose()
        return { got, want }
      })()`)
      const r = result as { skip?: string; got: number[]; want: number[] }
      test.skip(Boolean(r.skip), r.skip)
      expect(r.got).toEqual(r.want)
    })
