import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// Replacing a label slide releases its label tables: the fuser's CPU table and
// GPU lookup texture of the old slide go, on the 2D renderer and on the 3D
// slide plane (audit P2).

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`a replaced label slide frees its label tables, 2D and 3D (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const lib = await import('/src/index.ts')
      const n = 8
      const labelSlide = (rgba) => lib.NVSlide.fromSource({
        manifest: { id: 'l', name: 'l', width: n, height: n, dtype: 'uint16', channels: 'planar',
          channelInfo: [{ name: 'l', active: true, kind: 'label', labelColors: [{ id: 2, rgba }] }],
          levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
            columns: 1, rows: 1, bitsStored: 16, tiles: [{ x: 0, y: 0, width: n, height: n }] }] },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async () => ({ samples: new Uint16Array(n * n).fill(2), width: n, height: n, bitsStored: 16, planes: 1 }),
      })
      const key = (s) => s.tileKey(s.manifest.levels[0], { x: 0, y: 0 })
      const tick = () => new Promise((res) => setTimeout(res, 20))
      // The fuser's one table entry: [texture, a check that it was freed].
      const watch = (fuser, gl) => {
        const [entry] = fuser._tables.values()
        if (gl) return () => !gl.isTexture(entry)
        let freed = false
        const destroy = entry.texture.destroy.bind(entry.texture)
        entry.texture.destroy = () => { freed = true; destroy() }
        return () => freed
      }
      const out = {}
      // 2D renderer: the next render after the swap prunes.
      {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = n
        document.body.appendChild(canvas)
        const screen = { widthCss: n, heightCss: n, devicePixelRatio: 1 }
        let renderer, gl = null
        if ('${backend}' === 'webgpu') renderer = await lib.SlideRendererGPU.create(canvas)
        else {
          gl = canvas.getContext('webgl2')
          renderer = new lib.SlideRenderer()
          renderer.init(gl)
        }
        const show = async (s) => {
          s.setViewport({ centerX: n / 2, centerY: n / 2, scale: 1 })
          for (let i = 0; i < 100 && !s.cachedTile(key(s)); i++) {
            renderer.render([s], screen)
            await tick()
          }
          renderer.render([s], screen)
        }
        const a = labelSlide([255, 0, 0, 255])
        await show(a)
        const before = renderer._fuser._tables.size
        const freed = watch(renderer._fuser, gl)
        const b = labelSlide([0, 0, 255, 255])
        await show(b)
        out.r2d = { before, after: renderer._fuser._tables.size, freed: freed() }
        renderer.destroy()
        canvas.remove()
        a.dispose()
        b.dispose()
      }
      // 3D slide plane through NiiVue: setSlidePlane replaces the slide.
      {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 64
        document.body.appendChild(canvas)
        const nv = new lib.default({ backend: '${backend}', devicePixelRatio: 1, isAntiAlias: false })
        await nv.attachToCanvas(canvas)
        if (nv.backend !== '${backend}') return { skip: 'fell back to ' + nv.backend }
        nv.sliceType = lib.SLICE_TYPE.RENDER
        await nv.loadVolumes([{ url: (${syntheticVolume})({ n: 16 }), opacity: 0 }])
        const pixelToWorld = lib.axialPlaneTransform(n, n, { xmin: -20, xmax: 20, ymin: -20, ymax: 20, z: 0 })
        const fuser = nv.view.slidePlaneRenderer._fuser
        const show = async (s) => {
          nv.setSlidePlane(s, { pixelToWorld, levelIndex: 0 })
          for (let i = 0; i < 100 && !(s.cachedTile(key(s)) && fuser._tables.size); i++) {
            nv.getCanvasImage()
            await tick()
          }
          nv.getCanvasImage()
        }
        const a = labelSlide([255, 0, 0, 255])
        await show(a)
        const before = fuser._tables.size
        const freed = watch(fuser, '${backend}' === 'webgl2' ? nv.view.gl : null)
        nv.setSlidePlane(labelSlide([0, 0, 255, 255]), { pixelToWorld, levelIndex: 0 })
        out.r3d = { before, after: fuser._tables.size, freed: freed() }
        nv.destroy()
        canvas.remove()
      }
      return out
    })()`)
    const r = result as {
      skip?: string
      r2d: { before: number; after: number; freed: boolean }
      r3d: { before: number; after: number; freed: boolean }
    }
    test.skip(Boolean(r.skip), r.skip)
    // 2D: the old table is gone, the new slide's is the only one.
    expect(r.r2d).toEqual({ before: 1, after: 1, freed: true })
    // 3D: replacing the plane's slide frees its table at once.
    expect(r.r3d).toEqual({ before: 1, after: 0, freed: true })
  })
