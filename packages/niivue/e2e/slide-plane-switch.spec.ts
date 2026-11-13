import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// ENG-13: a plane switch holds the old plane on screen until the new plane's
// tiles are resident, then switches whole; texture keys differ per plane (P5).
// A 2-plane source (samples 10 and 20, grey) whose z1 reads wait for a gate.
// `pressure`: the cache holds 6 of the 4 + 4 tiles both planes need, so only
// the block that fits beside the shown view is held (and must survive its
// per-frame LRU touches); the rest loads after the commit, never mixed in.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  for (const pressure of [false, true])
    test(`a plane switch holds, then shows the new plane whole${pressure ? ', cache under pressure' : ''} (${backend})`, async ({
      page,
    }) => {
      const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
        const W = 32, T = 16
        const manifestOf = (z) => ({
          id: 'planes', name: 'planes', width: W, height: W, dtype: 'uint8', channels: 'gray',
          channelInfo: [{ name: 'g', active: true }],
          levels: [{ index: 0, width: W, height: W, downsample: 1, columns: 2, rows: 2,
            tileWidth: T, tileHeight: T, bitsStored: 8, plane: { z, t: 0 },
            tiles: [0, 1, 2, 3].map((i) => ({ x: i % 2, y: i >> 1, width: T, height: T })) }],
        })
        let open
        const gate = new Promise((res) => { open = res })
        const slide = NVSlide.fromSource({
          manifest: manifestOf(0),
          planes: { z: 2, t: 1 },
          preparePlane: async (p) => manifestOf(p.z),
          bind() {},
          fetchTileBytes: async () => { throw new Error('samples only') },
          fetchTileSamples: async (level) => {
            if (level.plane.z === 1) await gate
            return { samples: new Uint8Array(T * T).fill(level.plane.z ? 20 : 10), width: T, height: T, bitsStored: 8, planes: 1 }
          },
        }, ${pressure ? '{ maxCacheBytes: 6 * 256 }' : '{}'})
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = W
        document.body.appendChild(canvas)
        const screen = { widthCss: W, heightCss: W, devicePixelRatio: 1 }
        slide.setViewport({ centerX: W / 2, centerY: W / 2, scale: 1 })
        let renderer
        if ('${backend}' === 'webgpu') {
          renderer = await SlideRendererGPU.create(canvas)
          if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        } else {
          renderer = new SlideRenderer()
          renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true }))
        }
        renderer.isNearestInterpolation = true
        // Grey of the four tile centres, read in the drawing task.
        const frame = () => {
          renderer.render([slide], screen)
          const c = document.createElement('canvas')
          c.width = W
          c.height = W
          const ctx = c.getContext('2d')
          ctx.drawImage(canvas, 0, 0)
          return [[8, 8], [24, 8], [8, 24], [24, 24]].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[0])
        }
        const tick = () => new Promise((res) => setTimeout(res, 20))
        for (let i = 0; i < 100 && slide.pendingCount + (slide.cachedTile(slide.tileKey(slide.manifest.levels[0], { x: 1, y: 1 })) ? 0 : 1); i++) {
          frame()
          await tick()
        }
        const before = frame()
        let committed = null
        const switching = slide.setPlaneIndex({ z: 1, t: 0 }).then((r) => { committed = r })
        const during = []
        for (let i = 0; i < 5; i++) {
          during.push(frame())
          await tick()
        }
        open()
        for (let i = 0; i < 100 && committed === null; i++) {
          frame()
          await tick()
        }
        await switching
        const after = [frame()]
        for (let i = 0; i < 100 && after.at(-1).some((v) => v !== 20); i++) {
          await tick()
          after.push(frame())
        }
        const keys = [...renderer._textures._entries.keys()]
        const planesSeen = ['z0t0/', 'z1t0/'].map((p) => keys.some((k) => k.includes(p)))
        renderer.destroy()
        canvas.remove()
        slide.dispose()
        return { before, during, after, committed, planesSeen, plane: slide.planeIndex }
      })()`)
      const r = result as {
        skip?: string
        before: number[]
        during: number[][]
        after: number[][]
        committed: boolean
        planesSeen: boolean[]
        plane: { z: number }
      }
      test.skip(Boolean(r.skip), r.skip)
      expect(r.before).toEqual([10, 10, 10, 10])
      for (const f of r.during) expect(f).toEqual([10, 10, 10, 10])
      expect(r.committed).toBe(true)
      expect(r.plane.z).toBe(1)
      // Whole: no frame after the commit shows the old plane, and the new
      // plane fills in (at once when both planes fit the cache).
      for (const f of r.after) expect(f).not.toContain(10)
      expect(r.after.at(-1)).toEqual([20, 20, 20, 20])
      if (!pressure) expect(r.after[0]).toEqual([20, 20, 20, 20])
      // P5: the new plane's textures are keyed apart from the old plane's.
      expect(r.planesSeen[1]).toBe(true)
    })
