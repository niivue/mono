import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// M14-01: label channels in the fuse pass. Every drawn pixel of a synthetic
// label slide must equal the CPU reference (slideFuse.ts fuseSamples): IDs
// through labelColors (alpha folded in, a table past one 4096-wide row) or
// the default hash, window ignored, before and after a selected label dims
// the channel's other IDs. Tolerance 0 on both backends, so WebGL2 and WebGPU
// draw identically. u16: IDs with overrides; f32: 70000, 2^24, NaN and
// negatives (0); i16: negatives; mixed: an intensity channel beside a label
// channel, additive (mixmax: by max), the labels fused into their own texture.
//
// WebGPU is skipped when the runner has no adapter.

test.use(webgpuUse)

const CASES = ['u16', 'f32', 'i16', 'mixed', 'mixmax'] as const

for (const backend of ['webgl2', 'webgpu'] as const)
  for (const type of CASES)
    test(`fused label tiles match the CPU composite: ${type} (${backend})`, async ({
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
        const type = '${type}', W = 21, H = 11, TW = 16, TH = 8
        const Samples = { u16: Uint16Array, f32: Float32Array, i16: Int16Array, mixed: Uint16Array, mixmax: Uint16Array }[type]
        const ids = {
          u16: [0, 1, 2, 3, 7, 5000, 65535],
          f32: [0, 1, 2, 70000, 2 ** 24, NaN, -3, 1.5],
          i16: [0, 1, 2, -1, -32768, 32767],
          mixed: [0, 1, 2, 3],
          mixmax: [0, 1, 2, 3],
        }[type]
        const labelColors = [
          { id: 2, rgba: [255, 0, 0, 255] },
          { id: 3, rgba: [0, 255, 0, 128] },
          { id: 5000, rgba: [10, 20, 30, 255] },
        ]
        const mixed = type === 'mixed' || type === 'mixmax'
        const label = { name: 'label', active: true, kind: 'label', window: { calMin: 0, calMax: 1 }, ...(type === 'u16' || mixed ? { labelColors } : {}) }
        const channelInfo = mixed
          ? [{ name: 'grey', colormap: 'gray', window: { calMin: 0, calMax: 4 }, active: true }, label]
          : [label]
        const K = channelInfo.length
        let seed = 11
        const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
        const tiles = []
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++)
            tiles.push({ x, y, width: x ? W - TW : TW, height: y ? H - TH : TH })
        const bits = type === 'f32' ? 32 : 16
        const manifest = {
          id: 'labels', name: 'labels', width: W, height: H, dtype: type, channels: 'planar', channelInfo,
          levels: [{ index: 0, width: W, height: H, downsample: 1, tileWidth: TW, tileHeight: TH,
            columns: 2, rows: 2, bitsStored: bits, tiles }],
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
              if (!planes.has(key)) planes.set(key, Array.from({ length: n }, () => ids[Math.floor(rand() * ids.length)]))
              samples.set(planes.get(key), p * n)
            })
            return { samples, width: tile.width, height: tile.height, bitsStored: bits, planes: channels.length }
          },
        })
        if (type === 'mixed') slide.setChannelBlend('additive')
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        canvas.style.width = W + 'px'
        canvas.style.height = H + 'px'
        document.body.appendChild(canvas)
        const screen = { widthCss: W, heightCss: H, devicePixelRatio: 1 }
        slide.setViewport({ centerX: W / 2, centerY: H / 2, scale: 1 })
        let renderer
        if ('${backend}' === 'webgpu') {
          renderer = await SlideRendererGPU.create(canvas)
          if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        } else {
          renderer = new SlideRenderer()
          renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true }))
        }
        const draw = () => renderer.render([slide], screen)
        // One screen pixel per texel centre.
        renderer.isNearestInterpolation = true
        const level = slide.manifest.levels[0]
        const keys = tiles.map((t) => slide.tileKey(level, t))
        for (let i = 0; i < 100 && keys.some((k) => !slide.cachedTile(k)); i++) {
          slide.requestVisibleTiles(screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        const device = renderer._device
        const expected = () => {
          const out = new Uint8ClampedArray(W * H * 4)
          tiles.forEach((t, i) => {
            const entry = slide.cachedTile(keys[i])
            const s = entry.samples
            const plan = fusePlan(slide.channels, slide.channelBlend, entry, slide.manifest.channelInfo, slide.selectedLabel)
            const rgba = fuseSamples(s.samples, s.width * s.height, plan)
            for (let y = 0; y < s.height; y++)
              out.set(rgba.subarray(y * s.width * 4, (y + 1) * s.width * 4), ((t.y * TH + y) * W + t.x * TW) * 4)
          })
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
          let bad = 0, first = null, colours = new Set()
          for (let i = 0; i < want.length; i++) {
            if (i % 4 === 0) colours.add(want[i] + ',' + want[i + 1] + ',' + want[i + 2])
            if (got[i] !== want[i]) {
              bad++
              first ??= { i, got: got[i], want: want[i] }
            }
          }
          return { name, bad, first, colours: colours.size, error: error?.message ?? null }
        }
        const steps = [await compare('loaded')]
        const c = K - 1
        slide.setSelectedLabel(c, ids[2])
        steps.push(await compare('selected'))
        slide.setChannel(c, { calMin: 100, calMax: 200 })
        steps.push(await compare('window ignored'))
        slide.setSelectedLabel(c, null)
        steps.push(await compare('cleared'))
        renderer.destroy()
        canvas.remove()
        slide.dispose()
        return { steps }
      })()`)
      const r = result as {
        skip?: string
        steps: {
          name: string
          bad: number
          colours: number
          error: string | null
        }[]
      }
      test.skip(Boolean(r.skip), r.skip)
      for (const step of r.steps) {
        expect(step.error, step.name).toBeNull()
        expect(step.bad, JSON.stringify(step)).toBe(0)
        // The reference itself shows several label colours, not a blank tile.
        expect(step.colours, step.name).toBeGreaterThan(2)
      }
    })

// Owner decision (contracts, 2026-11-12): in a tile of intensity and label
// channels the labels sample nearest, the intensity linear. One 8 x 8 tile at
// 8 device px per texel under linear filtering: intensity through 'red' (R
// only), labels green or blue (G, B only), so the channels separate. Every
// pixel's G and B must be its texel's label colour, never a blend, while R
// takes interpolated levels. Max and additive blends.
for (const backend of ['webgl2', 'webgpu'] as const)
  for (const blend of ['max', 'additive'] as const)
    test(`mixed tiles: labels nearest, intensity linear, 8x (${blend}, ${backend})`, async ({
      page,
    }) => {
      const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
        const T = 8, K = 8, W = T * K
        const ids = [0, 2, 3]
        const colours = { 0: [0, 0], 2: [255, 0], 3: [0, 255] }
        let seed = 5
        const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
        const grey = Array.from({ length: T * T }, () => Math.floor(rand() * 5))
        const label = Array.from({ length: T * T }, () => ids[Math.floor(rand() * 3)])
        const slide = NVSlide.fromSource({
          manifest: { id: 'mixed8', name: 'mixed8', width: T, height: T, dtype: 'uint16', channels: 'planar',
            channelInfo: [
              { name: 'grey', colormap: 'red', window: { calMin: 0, calMax: 4 }, active: true },
              { name: 'label', active: true, kind: 'label', window: { calMin: 0, calMax: 1 },
                labelColors: [{ id: 2, rgba: [0, 255, 0, 255] }, { id: 3, rgba: [0, 0, 255, 255] }] },
            ],
            levels: [{ index: 0, width: T, height: T, downsample: 1, tileWidth: T, tileHeight: T,
              columns: 1, rows: 1, bitsStored: 16, tiles: [{ x: 0, y: 0, width: T, height: T }] }] },
          bind() {},
          fetchTileBytes: async () => { throw new Error('samples only') },
          fetchTileSamples: async (_l, _t, channels) => {
            const samples = new Uint16Array(T * T * channels.length)
            channels.forEach((c, p) => samples.set(c ? label : grey, p * T * T))
            return { samples, width: T, height: T, bitsStored: 16, planes: channels.length }
          },
        })
        slide.setChannelBlend('${blend}')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = W
        canvas.style.width = canvas.style.height = W + 'px'
        document.body.appendChild(canvas)
        const screen = { widthCss: W, heightCss: W, devicePixelRatio: 1 }
        slide.setViewport({ centerX: T / 2, centerY: T / 2, scale: K })
        let renderer
        if ('${backend}' === 'webgpu') {
          renderer = await SlideRendererGPU.create(canvas)
          if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        } else {
          renderer = new SlideRenderer()
          renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }))
        }
        const key = slide.tileKey(slide.manifest.levels[0], { x: 0, y: 0 })
        for (let i = 0; i < 100 && !slide.cachedTile(key); i++) {
          slide.requestVisibleTiles(screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        renderer.render([slide], screen)
        const c = document.createElement('canvas')
        c.width = c.height = W
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, W, W).data
        let bad = 0, first = null
        const reds = new Set()
        for (let y = 0; y < W; y++)
          for (let x = 0; x < W; x++) {
            const o = 4 * (y * W + x)
            const [g, b] = colours[label[Math.floor(y / K) * T + Math.floor(x / K)]]
            reds.add(px[o])
            if (px[o + 1] !== g || px[o + 2] !== b) {
              bad++
              first ??= { x, y, got: [px[o + 1], px[o + 2]], want: [g, b] }
            }
          }
        renderer.destroy()
        canvas.remove()
        slide.dispose()
        return { bad, first, reds: reds.size }
      })()`)
      const r = result as {
        skip?: string
        bad: number
        first: unknown
        reds: number
      }
      test.skip(Boolean(r.skip), r.skip)
      expect(r.bad, JSON.stringify(r.first)).toBe(0)
      // Linear intensity: far more red levels than the 5 stored.
      expect(r.reds).toBeGreaterThan(20)
    })
