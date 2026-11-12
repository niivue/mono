import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// The 2D slide renderers' frame (slideTiles.ts frame plan), both backends on
// one scene: slide A (2 levels, grid on) at level 0 with tile (1, 1) held, so
// the cached level-1 tile shows under it as fallback; slide B (y axis up,
// opacity 0.6, one level) over A's left edge with tile (1, 0) held and no
// fallback, so it draws its placeholder. Linear, then nearest.
// RN4: the WebGL2 frames match references taken from the renderer before the
// frame plan (SlideRenderer.draw). RN1: WebGL2 and WebGPU agree.

test.use(webgpuUse)

const W = 96
const H = 64

test('slide frame: references and WebGL2/WebGPU parity', async ({ page }) => {
  const result = await page.evaluate(`(async () => {
    const lib = await import('/src/index.ts')
    const { NVSlide, SlideRenderer, SlideRendererGPU } = lib
    const never = new Promise(() => {})
    const level = (index, n, t, downsample) => {
      const tiles = []
      for (let y = 0; y < Math.ceil(n[1] / t[1]); y++)
        for (let x = 0; x < Math.ceil(n[0] / t[0]); x++)
          tiles.push({ x, y, width: t[0], height: t[1] })
      return { index, width: n[0], height: n[1], downsample, tileWidth: t[0], tileHeight: t[1],
        columns: Math.ceil(n[0] / t[0]), rows: Math.ceil(n[1] / t[1]), codec: 'raw-rgba', tiles }
    }
    const make = (id, levels, extra, held, rgb) => NVSlide.fromSource({
      manifest: { id, name: id, width: levels[0].width, height: levels[0].height, dtype: 'uint8',
        channels: 'rgba', levels, ...extra },
      bind() {},
      fetchTileBytes: async (lv, tile) => {
        if (held(lv, tile)) await never
        const { tileWidth: tw, tileHeight: th } = lv
        const rgba = new Uint8Array(tw * th * 4)
        for (let j = 0; j < th; j++)
          for (let i = 0; i < tw; i++)
            rgba.set([...rgb(lv, tile.x * tw + i, tile.y * th + j), 255], 4 * (j * tw + i))
        return rgba
      },
    })
    const a = make('a', [level(0, [32, 32], [16, 16], 1), level(1, [16, 16], [16, 16], 2)], {},
      (lv, t) => lv.index === 0 && t.x === 1 && t.y === 1,
      (lv, x, y) => [x * 8 * (lv.index + 1), y * 8 * (lv.index + 1), lv.index ? 64 : 255])
    const b = make('b', [level(0, [16, 16], [8, 16], 1)], { displayYAxis: 'up' },
      (_, t) => t.x === 1,
      (_, x, y) => (((x >> 1) ^ (y >> 2)) & 1 ? [255, 200, 0] : [0, 80, 255]))
    a.showTileGrid = true
    b.opacity = 0.6
    b.setViewport({ centerX: 30.67, centerY: 8, scale: 1.5 })
    const slides = [a, b]
    const screen = { widthCss: ${W}, heightCss: ${H}, devicePixelRatio: 1 }
    const canvasFor = () => {
      const c = document.createElement('canvas')
      c.width = ${W}
      c.height = ${H}
      c.style.width = '${W}px'
      c.style.height = '${H}px'
      document.body.appendChild(c)
      return c
    }
    const glCanvas = canvasFor()
    const gl = glCanvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false })
    const glRenderer = new SlideRenderer()
    glRenderer.init(gl)
    const renderers = [[glCanvas, glRenderer]]
    let skip = null
    if (!navigator.gpu || !(await navigator.gpu.requestAdapter().catch(() => null))) skip = 'no WebGPU adapter'
    else {
      const gpuCanvas = canvasFor()
      const gpuRenderer = await SlideRendererGPU.create(gpuCanvas)
      if (gpuRenderer) renderers.push([gpuCanvas, gpuRenderer])
      else skip = 'SlideRendererGPU unavailable'
    }
    const drawAll = () => { for (const [, r] of renderers) r.render(slides, screen) }
    const cached = (s, l, x, y) => s.cachedTile(s.tileKey(s.manifest.levels[l], { x, y }))
    const until = async (done) => {
      for (let i = 0; i < 200 && !done(); i++) {
        drawAll()
        await new Promise((res) => setTimeout(res, 20))
      }
    }
    a.setViewport({ centerX: 16, centerY: 16, scale: 0.4 })
    await until(() => cached(a, 1, 0, 0) && cached(b, 0, 0, 0))
    a.setViewport({ centerX: 16, centerY: 16, scale: 1.6 })
    await until(() => cached(a, 0, 0, 0) && cached(a, 0, 1, 0) && cached(a, 0, 0, 1))
    // Read in the same task as the draw: a WebGPU canvas drops its texture once
    // presented. As shown: both canvases must stay opaque.
    const frame = (canvas, r) => {
      r.render(slides, screen)
      const c = document.createElement('canvas')
      c.width = ${W}
      c.height = ${H}
      const ctx = c.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      return { png: c.toDataURL('image/png'), px: [...ctx.getImageData(0, 0, ${W}, ${H}).data] }
    }
    const out = {}
    for (const nearest of [false, true])
      renderers.forEach(([canvas, r], i) => {
        r.isNearestInterpolation = nearest
        out[(i ? 'webgpu' : 'webgl2') + (nearest ? '-nearest' : '-linear')] = frame(canvas, r)
      })
    const fallback = !cached(a, 0, 1, 1) && a.lastVisibleTiles.fallback.length
    for (const [canvas, r] of renderers) { r.destroy(); canvas.remove() }
    for (const s of slides) s.dispose()
    return { out, skip, fallback }
  })()`)
  type Frame = { png: string; px: number[] }
  const r = result as {
    out: Record<string, Frame>
    skip: string | null
    fallback: number
  }
  expect(r.fallback).toBeGreaterThan(0)
  const png = (f: Frame) =>
    Buffer.from(f.png.slice('data:image/png;base64,'.length), 'base64')
  for (const mode of ['linear', 'nearest']) {
    const gl = r.out[`webgl2-${mode}`] as Frame
    expect(png(gl)).toMatchSnapshot(`slide-frame-${mode}.png`)
    if (r.skip) continue
    const gpu = r.out[`webgpu-${mode}`] as Frame
    // RN1: the same pixels (0 differ on Metal and SwiftShader; 1 level of
    // filtering rounding allowed).
    let off = 0
    for (let i = 0; i < gl.px.length; i++)
      if (Math.abs((gl.px[i] as number) - (gpu.px[i] as number)) > 1) off++
    expect(off).toBe(0)
  }
  test.skip(Boolean(r.skip), r.skip ?? '')
})

// RN2: every upload, gutter copy and fuse of a frame (an RGB slide and a fused
// scalar slide, all tiles cached, a fresh renderer) is issued before the
// frame's first tile draw. RN5 (WebGPU): the renderer's bind groups made per
// frame are at most the distinct textures drawn, and none once all are seen.
for (const backend of ['webgl2', 'webgpu'] as const)
  test(`uploads and fuses precede the first draw (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const n = 32, t = 16
      const tiles = []
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) tiles.push({ x, y, width: t, height: t })
      const level = { index: 0, width: n, height: n, downsample: 1, tileWidth: t, tileHeight: t,
        columns: 2, rows: 2, tiles }
      const rgb = NVSlide.fromSource({
        manifest: { id: 'rgb', name: 'rgb', width: n, height: n, dtype: 'uint8', channels: 'rgba',
          levels: [{ ...level, codec: 'raw-rgba' }] },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(t * t * 4).fill(200),
      })
      const scalar = NVSlide.fromSource({
        manifest: { id: 'scalar', name: 'scalar', width: n, height: n, dtype: 'uint16',
          channels: 'planar', levels: [{ ...level, bitsStored: 12 }],
          channelInfo: ['red', 'green'].map((colormap) => ({ name: colormap, colormap,
            window: { calMin: 0, calMax: 4095 }, active: true })) },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async (_l, _t, channels) => ({
          samples: new Uint16Array(t * t * channels.length).fill(2000),
          width: t, height: t, bitsStored: 12, planes: channels.length,
        }),
      })
      const W = 64
      const screen = { widthCss: W, heightCss: W, devicePixelRatio: 1 }
      const slides = [rgb, scalar]
      for (const s of [rgb, scalar]) s.setViewport({ centerX: n / 2, centerY: n / 2, scale: 1.5 })
      const all = (s) => tiles.every((p) => s.cachedTile(s.tileKey(s.manifest.levels[0], p)))
      for (let i = 0; i < 100 && !(all(rgb) && all(scalar)); i++) {
        for (const s of [rgb, scalar]) s.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = W
      document.body.appendChild(canvas)
      const events = []
      const wrap = (o, name, kind) => {
        const f = o[name].bind(o)
        o[name] = (...a) => { events.push(typeof kind === 'function' ? kind(...a) : kind); return f(...a) }
      }
      let renderer
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
        const device = renderer._device
        for (const name of ['writeTexture', 'copyExternalImageToTexture', 'submit'])
          wrap(device.queue, name, name === 'submit' ? 'submit' : 'upload')
        // The slide renderer's own groups (not the fuser's or the LUT's).
        wrap(device, 'createBindGroup', (d) =>
          d.layout === renderer._textureLayout || d.layout === renderer._uniformLayout ? 'group' : 'other')
        // Draws of the frame pass: those after one of the slide pipelines is set.
        const encoder = device.createCommandEncoder.bind(device)
        device.createCommandEncoder = (...a) => {
          const e = encoder(...a)
          const begin = e.beginRenderPass.bind(e)
          e.beginRenderPass = (...b) => {
            const pass = begin(...b)
            let frame = false
            const setPipeline = pass.setPipeline.bind(pass)
            pass.setPipeline = (p) => {
              frame ||= p === renderer._pipeline || p === renderer._lutPipeline
              return setPipeline(p)
            }
            wrap(pass, 'draw', () => (frame ? 'draw' : 'other'))
            return pass
          }
          return e
        }
      } else {
        const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false })
        renderer = new SlideRenderer()
        renderer.init(gl)
        for (const name of ['texImage2D', 'texSubImage2D', 'copyTexSubImage2D', 'texStorage2D'])
          wrap(gl, name, 'upload')
        // A draw into a framebuffer is a fuse; into the canvas, a tile.
        wrap(gl, 'drawArrays', () =>
          gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) ? 'upload' : 'draw')
      }
      const frame = () => {
        events.length = 0
        renderer.render(slides, screen)
        return events.slice()
      }
      const first = frame()
      const second = frame()
      renderer.destroy()
      canvas.remove()
      for (const s of [rgb, scalar]) s.dispose()
      return { first, second }
    })()`)
    const r = result as { skip?: string; first: string[]; second: string[] }
    test.skip(Boolean(r.skip), r.skip)
    const { first, second } = r
    const firstDraw = first.indexOf('draw')
    expect(firstDraw).toBeGreaterThan(0)
    expect(first.slice(0, firstDraw)).toContain('upload')
    expect(first.slice(firstDraw)).not.toContain('upload')
    if (backend === 'webgpu') {
      // The frame's own submit is its last; none between its draws.
      expect(first.slice(firstDraw, -1)).not.toContain('submit')
      // 8 tile textures and the placeholder (the backgrounds).
      expect(first.filter((e) => e === 'group').length).toBeLessThanOrEqual(9)
      expect(second.filter((e) => e === 'group')).toHaveLength(0)
    }
  })

// RN1 past the WebGPU uniform buffer's first size (64 quads): 144 tiles.
test('slide frame: 144 tiles draw the same on WebGL2 and WebGPU', async ({
  page,
}) => {
  const result = await page.evaluate(`(async () => {
    if (!navigator.gpu || !(await navigator.gpu.requestAdapter().catch(() => null)))
      return { skip: 'no WebGPU adapter' }
    const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
    const n = 48, t = 4, cols = n / t, size = 96
    const tiles = []
    for (let y = 0; y < cols; y++) for (let x = 0; x < cols; x++) tiles.push({ x, y, width: t, height: t })
    const slide = NVSlide.fromSource({
      manifest: { id: 'g', name: 'g', width: n, height: n, dtype: 'uint8', channels: 'rgba',
        levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: t, tileHeight: t,
          columns: cols, rows: cols, codec: 'raw-rgba', tiles }] },
      bind() {},
      fetchTileBytes: async (_l, tile) => {
        const rgba = new Uint8Array(t * t * 4)
        for (let j = 0; j < t; j++)
          for (let i = 0; i < t; i++)
            rgba.set([(tile.x * t + i) * 5, (tile.y * t + j) * 5, (tile.x + tile.y) * 10, 255], 4 * (j * t + i))
        return rgba
      },
    })
    slide.showTileGrid = true
    const screen = { widthCss: size, heightCss: size, devicePixelRatio: 1 }
    slide.setViewport({ centerX: n / 2, centerY: n / 2, scale: 2 })
    const canvases = [0, 1].map(() => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      document.body.appendChild(c)
      return c
    })
    const gl = new SlideRenderer()
    gl.init(canvases[0].getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }))
    const gpu = await SlideRendererGPU.create(canvases[1])
    if (!gpu) return { skip: 'SlideRendererGPU unavailable' }
    const renderers = [gl, gpu]
    const all = () => tiles.every((p) => slide.cachedTile(slide.tileKey(slide.manifest.levels[0], p)))
    for (let i = 0; i < 200 && !all(); i++) {
      for (const r of renderers) r.render([slide], screen)
      await new Promise((res) => setTimeout(res, 20))
    }
    const px = renderers.map((r, i) => {
      r.render([slide], screen)
      const c = document.createElement('canvas')
      c.width = c.height = size
      const ctx = c.getContext('2d')
      ctx.drawImage(canvases[i], 0, 0)
      return [...ctx.getImageData(0, 0, size, size).data]
    })
    const quads = slide.lastVisibleTiles.tiles.length
    for (const r of renderers) r.destroy()
    for (const c of canvases) c.remove()
    slide.dispose()
    return { quads, off: px[0].filter((v, i) => Math.abs(v - px[1][i]) > 1).length }
  })()`)
  const r = result as { skip?: string; quads: number; off: number }
  test.skip(Boolean(r.skip), r.skip)
  expect(r.quads).toBe(144)
  expect(r.off).toBe(0)
})

// A fused tile of label channels only draws nearest under linear filtering
// (TileTexture.nearest): magnified, a label checkerboard blends no colours,
// while the same samples as an intensity channel do.
for (const backend of ['webgl2', 'webgpu'] as const)
  test(`label-only fused tiles sample nearest per tile (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const n = 8, size = 64
      const slideAs = (channel) => NVSlide.fromSource({
        manifest: { id: 'l', name: 'l', width: n, height: n, dtype: 'uint16', channels: 'planar',
          channelInfo: [channel],
          levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
            columns: 1, rows: 1, bitsStored: 16, tiles: [{ x: 0, y: 0, width: n, height: n }] }] },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async () => {
          const samples = new Uint16Array(n * n)
          for (let i = 0; i < n * n; i++) samples[i] = ((i % n) + (i >> 3)) & 1 ? 3 : 2
          return { samples, width: n, height: n, bitsStored: 16, planes: 1 }
        },
      })
      const label = slideAs({ name: 'l', active: true, kind: 'label', window: { calMin: 0, calMax: 1 },
        labelColors: [{ id: 2, rgba: [255, 0, 0, 255] }, { id: 3, rgba: [0, 255, 0, 255] }] })
      const intensity = slideAs({ name: 'i', active: true, colormap: 'gray', window: { calMin: 2, calMax: 3 } })
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      document.body.appendChild(canvas)
      const screen = { widthCss: size, heightCss: size, devicePixelRatio: 1 }
      let renderer
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
      } else {
        renderer = new SlideRenderer()
        renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }))
      }
      const out = {}
      for (const [name, slide] of [['label', label], ['intensity', intensity]]) {
        slide.setViewport({ centerX: n / 2, centerY: n / 2, scale: size / n })
        const key = slide.tileKey(slide.manifest.levels[0], { x: 0, y: 0 })
        for (let i = 0; i < 100 && !slide.cachedTile(key); i++) {
          renderer.render([slide], screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        renderer.render([slide], screen)
        const c = document.createElement('canvas')
        c.width = c.height = size
        const ctx = c.getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, size, size).data
        const colours = new Set()
        for (let i = 0; i < px.length; i += 4) colours.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2])
        out[name] = colours.size
        slide.dispose()
      }
      renderer.destroy()
      canvas.remove()
      return out
    })()`)
    const r = result as { skip?: string; label: number; intensity: number }
    test.skip(Boolean(r.skip), r.skip)
    // Red and green only (the slide fills the canvas).
    expect(r.label).toBe(2)
    expect(r.intensity).toBeGreaterThan(8)
  })

// A target tile whose upload the frame defers (ENG-11: no room in the texture
// budget) draws nothing, so the fallback under it shows, not the placeholder.
// Level 0 (red) with tile (1, 1) held, so level 1 (green) is fallback; the
// renderer's cache admits only the first upload of each frame (the fallback).
for (const backend of ['webgl2', 'webgpu'] as const)
  test(`a deferred upload shows its fallback, not the placeholder (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      const never = new Promise(() => {})
      const level = (index, n) => {
        const c = n / 16, tiles = []
        for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) tiles.push({ x, y, width: 16, height: 16 })
        return { index, width: n, height: n, downsample: 32 / n, tileWidth: 16, tileHeight: 16,
          columns: c, rows: c, codec: 'raw-rgba', tiles }
      }
      const slide = NVSlide.fromSource({
        manifest: { id: 'd', name: 'd', width: 32, height: 32, dtype: 'uint8', channels: 'rgba',
          levels: [level(0, 32), level(1, 16)] },
        bind() {},
        fetchTileBytes: async (lv, t) => {
          if (lv.index === 0 && t.x === 1 && t.y === 1) await never
          const rgba = new Uint8Array(16 * 16 * 4)
          for (let i = 0; i < 256; i++) rgba.set(lv.index ? [0, 255, 0, 255] : [255, 0, 0, 255], 4 * i)
          return rgba
        },
      }, { placeholderColor: [1, 0, 1, 1] })
      const W = 32
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = W
      document.body.appendChild(canvas)
      const screen = { widthCss: W, heightCss: W, devicePixelRatio: 1 }
      let renderer
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
      } else {
        renderer = new SlideRenderer()
        renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }))
      }
      const cached = (l, x, y) => slide.cachedTile(slide.tileKey(slide.manifest.levels[l], { x, y }))
      slide.setViewport({ centerX: 16, centerY: 16, scale: 0.5 })
      for (let i = 0; i < 100 && !cached(1, 0, 0); i++) {
        slide.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      slide.setViewport({ centerX: 16, centerY: 16, scale: 1 })
      for (let i = 0; i < 100 && !(cached(0, 0, 0) && cached(0, 1, 0) && cached(0, 0, 1)); i++) {
        slide.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const cache = renderer._textures
      const reserve = cache.reserve.bind(cache)
      let admitted = 0, refused = 0
      const begin = cache.beginFrame.bind(cache)
      cache.beginFrame = () => { admitted = 0; begin() }
      cache.reserve = (bytes) => {
        if (admitted++ === 0) return reserve(bytes)
        refused++
        return false
      }
      renderer.render([slide], screen)
      const c = document.createElement('canvas')
      c.width = c.height = W
      const ctx = c.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      const px = ctx.getImageData(0, 0, W, W).data
      const count = { magenta: 0, green: 0, red: 0 }
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 250 && px[i + 2] > 250) count.magenta++
        else if (px[i + 1] > 250) count.green++
        else if (px[i] > 250) count.red++
      }
      const fallback = slide.lastVisibleTiles.fallback.length
      renderer.destroy()
      canvas.remove()
      slide.dispose()
      return { ...count, refused, fallback }
    })()`)
    const r = result as {
      skip?: string
      magenta: number
      green: number
      red: number
      refused: number
      fallback: number
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.fallback).toBeGreaterThan(0)
    expect(r.refused).toBeGreaterThan(0)
    expect(r.magenta).toBe(0)
    expect(r.green).toBe(32 * 32)
  })
