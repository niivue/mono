import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// Tiles are separate textures, so bilinear filtering cannot see across a tile
// border unless each tile carries a 1-texel gutter copied from its neighbours
// (slide/tileGutter.ts). A 2x2-tile slide holds one linear ramp (red along x,
// green along y) whose tiles meet mid-ramp: magnified, linear filtering must
// stay a straight ramp across both seams and through the 4-tile junction
// (clamp-to-edge leaves a half-texel plateau and a one-texel jump at each), and
// nearest must still show only source texel values. The bottom-right tile,
// drawn last, arrives after the others have been drawn: the first frame after
// it lands must already show its neighbours' refreshed borders (nothing else
// asks for a repaint when tiles stream). Tiles uploaded under nearest skip
// the gutter copies; the first linear frame after must refill them. The
// scalar variant serves the ramp as red, green and blue sample channels, fused
// on the GPU (tileFuse.ts) and re-fused by a channel change between the two
// reads, so a fused tile's gutter is filled after its fuse and refreshed after
// a re-fuse (deferred under nearest).
//
// WebGPU is skipped when the runner has no adapter.

test.use(webgpuUse)

const STEP = 8 // ramp increment per source texel
const SIZE = 32 // slide pixels per axis (2 tiles of 16)
const CANVAS = 128

// Page source: the ramp slide; `release()` delivers the held bottom-right tile.
const rampSlide = `(NVSlide, scalar = false) => {
  const n = ${SIZE}, t = n / 2, step = ${STEP}
  const tiles = []
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) tiles.push({ x, y, width: t, height: t })
  const manifest = {
    id: 'seams', name: 'seams', width: n, height: n, dtype: 'uint8', channels: 'rgba',
    levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: t, tileHeight: t,
      columns: 2, rows: 2, codec: 'raw-rgba', tiles }],
  }
  let release
  const held = new Promise((res) => { release = res })
  const slide = NVSlide.fromSource({
    manifest,
    bind() {},
    fetchTileBytes: async (_level, tile) => {
      if (tile.x === 1 && tile.y === 1) await held
      const rgba = new Uint8Array(t * t * 4)
      for (let j = 0; j < t; j++)
        for (let i = 0; i < t; i++)
          rgba.set([(tile.x * t + i) * step, (tile.y * t + j) * step, 255, 255], 4 * (j * t + i))
      return rgba
    },
    ...(scalar ? {
      fetchTileSamples: async (_level, tile, channels) => {
        if (tile.x === 1 && tile.y === 1) await held
        const samples = new Uint8Array(t * t * channels.length)
        for (let j = 0; j < t; j++)
          for (let i = 0; i < t; i++) {
            const v = [(tile.x * t + i) * step, (tile.y * t + j) * step, 255]
            channels.forEach((c, p) => { samples[(p * t + j) * t + i] = v[c] })
          }
        return { samples, width: t, height: t, bitsStored: 8, planes: channels.length }
      },
    } : {}),
  })
  // Tiles as [x, y] of level 0.
  const cached = (tiles) => tiles.every(([x, y]) => slide.cachedTile(slide.tileKey(slide.manifest.levels[0], { x, y })))
  return { slide, release, cached }
}`

type Ramps = { red: number[]; green: number[]; diagonal: number[] }

/**
 * Linear: every step between screen pixels whose centres are a texel inside
 * the slide is the per-pixel ramp increment. Nearest: source values only.
 */
function expectRamps(
  linear: Ramps,
  nearest: Ramps,
  first: number,
  last: number,
  perPixel: number,
): void {
  for (const ramp of [linear.red, linear.green, linear.diagonal]) {
    const inside = ramp.slice(first, last + 1)
    const diffs = inside.slice(1).map((v, i) => v - (inside[i] as number))
    expect(Math.min(...diffs)).toBeGreaterThanOrEqual(Math.floor(perPixel) - 1)
    expect(Math.max(...diffs)).toBeLessThanOrEqual(Math.ceil(perPixel) + 1)
  }
  for (const ramp of [nearest.red, nearest.green, nearest.diagonal]) {
    const inside = ramp.slice(first, last + 1)
    expect(inside.every((v) => v % STEP === 0)).toBe(true)
    expect(inside).toEqual([...inside].sort((a, b) => a - b))
  }
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const [scale, nearestFirst, scalar] of [
    [1.5, false, false],
    [3, false, false],
    [1.5, true, false],
    [3, true, false],
    [3, false, true],
    [3, true, true],
  ] as const) {
    const loaded = `${nearestFirst ? ', loaded under nearest' : ''}${scalar ? ', fused scalar' : ''}`
    test(`slide tiles meet without seams at ${scale}x (${backend}${loaded})`, async ({
      page,
    }) => {
      const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
        const { slide, release, cached } = (${rampSlide})(NVSlide, ${scalar})
        const n = ${SIZE}, size = ${CANVAS}
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        canvas.style.width = canvas.style.height = size + 'px'
        document.body.appendChild(canvas)
        const screen = { widthCss: size, heightCss: size, devicePixelRatio: 1 }
        slide.setViewport({ centerX: n / 2, centerY: n / 2, scale: ${scale} })
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
        renderer.isNearestInterpolation = ${nearestFirst}
        const until = async (keys, drawing) => {
          for (let i = 0; i < 100 && !cached(keys); i++) {
            if (drawing) draw()
            await new Promise((res) => setTimeout(res, 20))
          }
        }
        await until([[0, 0], [1, 0], [0, 1]], true)
        draw()
        release()
        // No draw until it is cached: read() below is the first frame with it.
        await until([[1, 1]], false)
        // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
        const read = () => {
          draw()
          const c = document.createElement('canvas')
          c.width = c.height = size
          const ctx = c.getContext('2d')
          ctx.drawImage(canvas, 0, 0)
          const px = ctx.getImageData(0, 0, size, size).data
          // Off the other axis' seam, through the late tile's neighbours.
          const across = Math.floor(size / 2 + (n / 4) * ${scale})
          const red = [], green = [], diagonal = []
          for (let i = 0; i < size; i++) {
            red.push(px[4 * (across * size + i)])
            green.push(px[4 * (i * size + across) + 1])
            diagonal.push(px[4 * (i * size + i)])
          }
          return { red, green, diagonal }
        }
        const first = read()
        // The same window again: a new display generation, so every tile re-fuses.
        if (${scalar}) slide.setChannel(2, { calMin: 0, calMax: 255 })
        renderer.isNearestInterpolation = !${nearestFirst}
        const second = read()
        const [linear, nearest] = ${nearestFirst} ? [second, first] : [first, second]
        renderer.destroy()
        canvas.remove()
        return { linear, nearest }
      })()`)
      const r = result as { skip?: string; linear: Ramps; nearest: Ramps }
      test.skip(Boolean(r.skip), r.skip)
      // Screen pixels whose centres sit at least one texel inside the slide
      // (its outer border is clamped, as before).
      expectRamps(
        r.linear,
        r.nearest,
        Math.ceil(CANVAS / 2 - (SIZE / 2 - 1) * scale),
        Math.floor(CANVAS / 2 + (SIZE / 2 - 1) * scale) - 1,
        STEP / scale,
      )
    })
  }

  // Nearest skips the gutter copies, so the gutter holds nothing: off pixel
  // boundaries with MSAA, a partly covered pixel samples past the tile edge,
  // which must still read the edge texel (a gutter read lets the slide's
  // dark background through).
  test(`nearest never shows the gutter off pixel boundaries (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const { slide, release, cached } = (${rampSlide})(NVSlide)
      release()
      const size = ${CANVAS}
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      document.body.appendChild(canvas)
      const screen = { widthCss: size, heightCss: size, devicePixelRatio: 1 }
      slide.setViewport({ centerX: 16.3, centerY: 16.3, scale: 2.5 })
      let renderer, draw
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas, { antialias: true })
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        draw = () => renderer.render([slide], screen)
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: true })
        renderer = new SlideRenderer()
        renderer.init(gl)
        draw = () => renderer.render([slide], screen)
      }
      renderer.isNearestInterpolation = true
      const keys = [[0, 0], [1, 0], [0, 1], [1, 1]]
      for (let i = 0; i < 100 && !cached(keys); i++) {
        draw()
        await new Promise((res) => setTimeout(res, 20))
      }
      draw()
      const c = document.createElement('canvas')
      c.width = c.height = size
      const ctx = c.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      const px = Array.from(ctx.getImageData(0, 0, size, size).data)
      renderer.destroy()
      canvas.remove()
      return { px }
    })()`)
    const r = result as { skip?: string; px: number[] }
    test.skip(Boolean(r.skip), r.skip)
    // Screen x of slide x: 64 + (x - 16.3) * 2.5. Rows and columns through
    // both tiles of each axis, between the outer edges' partial pixels.
    const at = (x: number, y: number, ch: number): number =>
      r.px[4 * (y * CANVAS + x) + ch] as number
    const first = Math.ceil(64 - 16.3 * 2.5) + 1
    const last = Math.floor(64 + 15.7 * 2.5) - 1
    for (const line of [24, 80]) {
      const red: number[] = []
      const green: number[] = []
      for (let i = first; i <= last; i++) {
        red.push(at(i, line, 0))
        green.push(at(line, i, 1))
        expect([i, at(i, line, 2), at(line, i, 2)]).toEqual([i, 255, 255])
      }
      expect(red).toEqual([...red].sort((a, b) => a - b))
      expect(green).toEqual([...green].sort((a, b) => a - b))
    }
  })

  // The same slide as a plane in the 3D render tile (slidePlaneRender.ts),
  // seen from above with the volume hidden.
  test(`slide plane tiles meet without seams (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const lib = await import('/src/index.ts')
      const { slide, release, cached } = (${rampSlide})(lib.NVSlide)
      const size = ${CANVAS}
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
      const transform = lib.axialPlaneTransform(${SIZE}, ${SIZE}, {
        xmin: -20, xmax: 20, ymin: -20, ymax: 20, z: 0, flipY: false,
      })
      nv.setSlidePlane(slide, { pixelToWorld: transform, levelIndex: 0 })
      const until = async (keys) => {
        for (let i = 0; i < 100 && !cached(keys); i++) {
          nv.getCanvasImage()
          await new Promise((res) => setTimeout(res, 20))
        }
      }
      await until([[0, 0], [1, 0], [0, 1]])
      nv.getCanvasImage()
      release()
      await until([[1, 1]])
      const img = nv.getCanvasImage()
      nv.destroy()
      canvas.remove()
      return { width: img.width, px: Array.from(img.data) }
    })()`)
    const r = result as { skip?: string; width: number; px: number[] }
    test.skip(Boolean(r.skip), r.skip)
    // The plane: the pixels with the slide's blue; scan its middle row and column.
    const at = (x: number, y: number, ch: number): number =>
      r.px[4 * (y * r.width + x) + ch] as number
    const cols: number[] = []
    for (let x = 0; x < r.width; x++)
      if (at(x, r.width >> 1, 2) > 250) cols.push(x)
    const x0 = Math.min(...cols)
    const x1 = Math.max(...cols)
    const scale = (x1 - x0 + 1) / SIZE
    expect(scale).toBeGreaterThan(1.5)
    const across = Math.round(x0 + (3 * (x1 - x0)) / 4)
    const scan = (ch: number, row: boolean): number[] => {
      const values: number[] = []
      for (let i = 0; i < r.width; i++)
        values.push(row ? at(i, across, ch) : at(across, i, ch))
      return values
    }
    const first = Math.ceil(x0 + scale)
    const last = Math.floor(x1 - scale)
    // Orientation on screen depends on the camera: test the ramp's magnitude.
    for (const ramp of [scan(0, true), scan(1, false)]) {
      const inside = ramp.slice(first, last + 1)
      const diffs = inside
        .slice(1)
        .map((v, i) => Math.abs(v - (inside[i] as number)))
      expect(Math.min(...diffs)).toBeGreaterThanOrEqual(
        Math.floor(STEP / scale) - 1,
      )
      expect(Math.max(...diffs)).toBeLessThanOrEqual(
        Math.ceil(STEP / scale) + 1,
      )
    }
  })
}
