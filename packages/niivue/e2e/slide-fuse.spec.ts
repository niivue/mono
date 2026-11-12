import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// #159: scalar slide tiles are windowed, colormapped and channel-composited on
// the GPU (the fuse pass, gl/ and wgpu/tileFuse.ts) into each tile's RGBA
// texture. Every drawn pixel must equal the CPU reference (slideFuse.ts
// fuseSamples, the composite NVSlide used to bake into bitmaps) for 1, 2 and 6
// channels and each sample type, after a W/L change, a blend change and a
// hidden channel, with and without the raw-layer pool, MONOCHROME1, full-range
// 16-bit windows, exact rounding ties (127.5 rounds up, as Math.round) and NaN
// float samples (level 0). A 21 x 11 slide of 16 x 8 tiles has ragged 5 x 3
// edge tiles (rows not 4-byte aligned).
//
// WebGPU is skipped when the runner has no adapter.

test.use(webgpuUse)

// u16w: 16 bits, windows up to 65535; tie: values on window 100..300 that
// land on and beside 127.5. f32big: float32 near 1e8 (ulp 8) on window
// 1e8..1e8+9, a width float32 calMax would round to 8. f32huge: window
// 0..2e38, where (v - calMin) * 255 overflows float32. f32span: window
// -3e38..3.2e38, whose width overflows float32. f32wide: window -1e40..1e40,
// whose ends overflow float32 too.
const CASES = [
  { K: 1, type: 'u16', pool: undefined },
  { K: 2, type: 'u8', pool: undefined },
  { K: 6, type: 'u16', pool: undefined },
  { K: 6, type: 'u16', pool: 0 },
  { K: 2, type: 'i16', pool: undefined },
  { K: 2, type: 'f32', pool: undefined },
  { K: 2, type: 'u16w', pool: undefined },
  { K: 1, type: 'tie', pool: undefined },
  { K: 1, type: 'f32big', pool: undefined },
  { K: 1, type: 'f32huge', pool: undefined },
  { K: 1, type: 'f32span', pool: undefined },
  { K: 1, type: 'f32wide', pool: undefined },
  { K: 1, type: 'mono1', pool: undefined },
] as const

for (const backend of ['webgl2', 'webgpu'] as const)
  for (const { K, type, pool } of CASES) {
    const label = `${K} ${type} channel${K > 1 ? 's' : ''}${pool === 0 ? ', no pool' : ''}`
    test(`fused scalar tiles match the CPU composite: ${label} (${backend})`, async ({
      page,
    }) => {
      const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
        const { fusePlan, fuseSamples } = await import('/src/slide/slideFuse.ts')
        const K = ${K}, type = '${type}', W = 21, H = 11, TW = 16, TH = 8
        const options = ${pool === undefined ? '{}' : `{ maxRawPoolBytes: ${pool} }`}
        const Samples = { u8: Uint8Array, u16: Uint16Array, u16w: Uint16Array, tie: Uint16Array, mono1: Uint16Array, i16: Int16Array, f32: Float32Array, f32big: Float32Array, f32huge: Float32Array, f32span: Float32Array, f32wide: Float32Array }[type]
        const span = { u8: [0, 255], u16: [0, 4095], u16w: [0, 65535], tie: [0, 4095], mono1: [0, 4095], i16: [-2000, 2000], f32: [0, 1], f32big: [1e8, 1e8 + 16], f32huge: [0, 2e38], f32span: [-3e38, 3e38], f32wide: [-3e38, 3e38] }[type]
        const ties = [100, 200, 300, 140, 260, 199, 201, 99, 301]
        let seed = 7
        const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
        let tie = 0
        const value = () => {
          if (type === 'tie') return ties[tie++ % ties.length]
          const v = span[0] + rand() * (span[1] - span[0])
          return type === 'f32' ? v : Math.round(v)
        }
        // NaN, common float32 background, is level 0 as in fuseSamples.
        const sample = () => (type === 'f32' && rand() < 0.25 ? NaN : value())
        const colormaps = ['gray', 'red', 'green', 'blue', 'warm', 'cool']
        // Channel 0 keeps the stored range (NaN bounds); the others get windows.
        const windowOf = (c) => {
          const a = value(), b = value()
          const lo = Math.min(a, b), hi = Math.max(a, b)
          return { calMin: lo, calMax: hi > lo ? hi : lo + 1 }
        }
        const channelInfo = Array.from({ length: K }, (_, c) => ({
          name: 'c' + c,
          colormap: colormaps[c],
          ...(c ? { window: windowOf(c) } : type === 'tie' ? { window: { calMin: 100, calMax: 300 } } : type === 'f32big' ? { window: { calMin: 1e8, calMax: 1e8 + 9 } } : type === 'f32huge' ? { window: { calMin: 0, calMax: 2e38 } } : type === 'f32span' ? { window: { calMin: -3e38, calMax: 3.2e38 } } : type === 'f32wide' ? { window: { calMin: -1e40, calMax: 1e40 } } : {}),
          active: true,
        }))
        const tiles = []
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++)
            tiles.push({ x, y, width: x ? W - TW : TW, height: y ? H - TH : TH })
        const bits = { u8: 8, u16: 12, u16w: 16, tie: 12, mono1: 12, i16: 16, f32: 32, f32big: 32, f32huge: 32, f32span: 32, f32wide: 32 }[type]
        const manifest = {
          id: 'fuse', name: 'fuse', width: W, height: H, dtype: type, channels: 'planar', channelInfo,
          levels: [{ index: 0, width: W, height: H, downsample: 1, tileWidth: TW, tileHeight: TH,
            columns: 2, rows: 2, bitsStored: bits, tiles,
            ...(type === 'mono1' ? { photometric: 'MONOCHROME1' } : {}) }],
        }
        const planes = new Map()
        const slide = NVSlide.fromSource({
          manifest,
          bind() {},
          fetchTileBytes: async () => { throw new Error('samples only') },
          fetchTileSamples: async (_level, tile, channels) => {
            const n = tile.width * tile.height
            const samples = new Samples(n * channels.length)
            channels.forEach((c, p) => {
              const key = tile.x + ',' + tile.y + ',' + c
              if (!planes.has(key)) planes.set(key, Array.from({ length: n }, sample))
              samples.set(planes.get(key), p * n)
            })
            return { samples, width: tile.width, height: tile.height, bitsStored: bits, planes: channels.length }
          },
        })
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        canvas.style.width = W + 'px'
        canvas.style.height = H + 'px'
        document.body.appendChild(canvas)
        const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
        slide.setViewport({ centerX: W / 2, centerY: H / 2, scale: 1 })
        let renderer, draw
        if ('${backend}' === 'webgpu') {
          renderer = await SlideRendererGPU.create(canvas, options)
          if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
          draw = () => renderer.render([slide], screen)
        } else {
          const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
          renderer = new SlideRenderer(options)
          renderer.init(gl)
          draw = () => renderer.draw(gl, [slide], screen)
        }
        // One screen pixel per texel centre.
        renderer.isNearestInterpolation = true
        const keys = tiles.map((t) => 'L0/' + t.x + '/' + t.y)
        for (let i = 0; i < 100 && keys.some((k) => !slide.cachedTile(k)); i++) {
          slide.requestVisibleTiles(screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        const device = renderer._device
        // The CPU reference of every pixel under the current channels.
        const expected = () => {
          const out = new Uint8ClampedArray(W * H * 4)
          for (const t of tiles) {
            const entry = slide.cachedTile('L0/' + t.x + '/' + t.y)
            const s = entry.samples
            const plan = fusePlan(slide.channels, slide.channelBlend, entry)
            const rgba = fuseSamples(s.samples, s.width * s.height, plan)
            for (let y = 0; y < s.height; y++)
              out.set(rgba.subarray(y * s.width * 4, (y + 1) * s.width * 4), ((t.y * TH + y) * W + t.x * TW) * 4)
          }
          return out
        }
        // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
        const compare = async (name) => {
          device?.pushErrorScope('validation')
          draw()
          const c = document.createElement('canvas')
          c.width = W
          c.height = H
          const ctx = c.getContext('2d')
          ctx.drawImage(canvas, 0, 0)
          const got = ctx.getImageData(0, 0, W, H).data
          const error = await device?.popErrorScope()
          const want = expected()
          let worst = 0, bad = 0, first = null
          for (let i = 0; i < want.length; i++) {
            const d = Math.abs(got[i] - want[i])
            if (d > worst) worst = d
            if (d) {
              bad++
              first ??= { i, got: got[i], want: want[i] }
            }
          }
          return { name, worst, bad, first, error: error?.message ?? null }
        }
        const steps = [await compare('loaded')]
        slide.setChannel(K - 1, { calMin: span[0] + (span[1] - span[0]) * 0.2, calMax: span[0] + (span[1] - span[0]) * 0.6 })
        steps.push(await compare('window'))
        slide.setChannel(0, { calMin: span[0] + (span[1] - span[0]) * 0.5 })
        steps.push(await compare('one-sided'))
        if (K > 1) {
          slide.setChannelBlend('additive')
          steps.push(await compare('additive'))
          slide.setChannel(0, { visible: false })
          steps.push(await compare('hidden'))
        }
        const poolBytes = renderer._fuser.poolBytes
        renderer.destroy()
        canvas.remove()
        slide.dispose()
        return { steps, poolBytes }
      })()`)
      const r = result as {
        skip?: string
        steps: { name: string; worst: number; error: string | null }[]
        poolBytes: number
      }
      test.skip(Boolean(r.skip), r.skip)
      // float32 windows in f32 on the GPU, f64 on the CPU: a level can land
      // one step apart within an ulp of a tie.
      const tolerance =
        type === 'f32' || type === 'f32span' || type === 'f32wide' ? 1 : 0
      for (const step of r.steps) {
        expect(step.error, step.name).toBeNull()
        expect(step.worst, JSON.stringify(step)).toBeLessThanOrEqual(tolerance)
      }
      if (pool === 0) expect(r.poolBytes).toBe(0)
      else expect(r.poolBytes).toBeGreaterThan(0)
    })
  }
