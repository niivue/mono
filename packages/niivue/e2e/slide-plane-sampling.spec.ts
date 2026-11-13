import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// The slide plane in the 3D render tile (slidePlaneRender.ts), seen from
// above: an 8 x 8 slide of 4 px tiles, a red/blue checkerboard of source
// pixels, tile (1, 1) a hole. Nearest shows only source colours; linear
// blends them. A slide whose manifest states its absent colour (DICOM
// (0048,0015)) fills the hole with it; without one the hole stays transparent.
// The checkerboard as fused label samples stays nearest under linear, also
// beside an intensity channel (all 0, so only label colours show). Drawn
// through NiiVue (setSlidePlane, setSlidePlaneInterpolation, getCanvasImage),
// so the views' own draw call is what passes pixelToWorld. A half-alpha green
// annotation over the left half keeps the canvas opaque and magnifies nearest
// on both backends.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`slide plane: nearest, linear and the absent colour (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const lib = await import('/src/index.ts')
      const n = 8, t = 4
      const slideWith = (backgroundColor, alpha = 255) => {
        const tiles = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]
          .map((p) => ({ ...p, width: t, height: t }))
        return lib.NVSlide.fromSource({
          manifest: { id: 'p', name: 'p', width: n, height: n, dtype: 'uint8', channels: 'rgba',
            ...(backgroundColor ? { backgroundColor } : {}),
            levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: t, tileHeight: t,
              columns: 2, rows: 2, codec: 'raw-rgba', tiles }] },
          bind() {},
          fetchTileBytes: async (_l, tile) => {
            const rgba = new Uint8Array(t * t * 4)
            for (let j = 0; j < t; j++)
              for (let i = 0; i < t; i++)
                rgba.set((tile.x * t + i + tile.y * t + j) & 1 ? [0, 0, 255, alpha] : [255, 0, 0, alpha],
                  4 * (j * t + i))
            return rgba
          },
        })
      }
      // The same checkerboard as label samples (fused, drawn nearest per tile),
      // alone or after an intensity channel of zeros.
      const labelSlide = (mixed) => lib.NVSlide.fromSource({
        manifest: { id: 'l', name: 'l', width: n, height: n, dtype: 'uint16', channels: 'planar',
          channelInfo: [
            ...(mixed ? [{ name: 'i', active: true, colormap: 'gray', window: { calMin: 0, calMax: 1 } }] : []),
            { name: 'l', active: true, kind: 'label', window: { calMin: 0, calMax: 1 },
              labelColors: [{ id: 2, rgba: [255, 0, 0, 255] }, { id: 3, rgba: [0, 0, 255, 255] }] }],
          levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: t, tileHeight: t,
            columns: 2, rows: 2, bitsStored: 16,
            tiles: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }].map((p) => ({ ...p, width: t, height: t })) }] },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async (_l, tile, channels) => {
          const samples = new Uint16Array(t * t * channels.length)
          const p = (channels.length - 1) * t * t
          for (let j = 0; j < t; j++)
            for (let i = 0; i < t; i++) samples[p + j * t + i] = (tile.x * t + i + tile.y * t + j) & 1 ? 3 : 2
          return { samples, width: t, height: t, bitsStored: 16, planes: channels.length }
        },
      })
      const size = 128
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
      // The "No image loaded" header's backing: HEADER_BACK_COLOR at 0.8 over
      // black, compared premultiplied (a WebGL2 canvas may hold alpha < 1).
      const empty = nv.getCanvasImage().data
      let headerPx = 0
      for (let i = 0; i < empty.length; i += 4) {
        const k = empty[i + 3] / 255
        if (Math.abs(empty[i] * k - 102) + Math.abs(empty[i + 1] * k - 41) + Math.abs(empty[i + 2] * k - 122) < 8) headerPx++
      }
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadVolumes([{ url: (${syntheticVolume})({ n: 16 }), opacity: 0 }])
      const pixelToWorld = lib.axialPlaneTransform(n, n, {
        xmin: -20, xmax: 20, ymin: -20, ymax: 20, z: 0, flipY: false,
      })
      // Counts of plane pixels: pure source colours, blends, green (absent), black.
      const census = (nearest) => {
        nv.setSlidePlaneInterpolation(nearest)
        const img = nv.getCanvasImage()
        const c = { pure: 0, blend: 0, green: 0, black: 0 }
        for (let i = 0; i < img.data.length; i += 4) {
          const [r, g, b] = img.data.slice(i, i + 3)
          if (g > 250 && r < 5 && b < 5) c.green++
          else if (r + g + b < 5) c.black++
          else if ((r > 250 && b < 5) || (b > 250 && r < 5)) c.pure++
          else c.blend++
        }
        return c
      }
      const out = { headerPx }
      for (const [name, color] of [['absent', [0, 1, 0, 1]], ['none', null], ['label', null], ['mixed', null]]) {
        const slide = name === 'label' || name === 'mixed' ? labelSlide(name === 'mixed') : slideWith(color)
        const keys = [[0, 0], [1, 0], [0, 1]].map(([x, y]) => slide.tileKey(slide.manifest.levels[0], { x, y }))
        nv.setSlidePlane(slide, { pixelToWorld, levelIndex: 0 })
        for (let i = 0; i < 100 && !keys.every((k) => slide.cachedTile(k)); i++) {
          nv.getCanvasImage()
          await new Promise((res) => setTimeout(res, 20))
        }
        out[name] = { nearest: census(true), linear: census(false) }
      }
      // Annotation over the last slide's left half (the hole stays transparent).
      nv.createSlideDrawing({ maxRaster: n })
      const ann = nv._slidePlane.annotation
      for (let y = 0; y < ann.height; y++)
        for (let x = 0; x < ann.width / 2; x++) ann.rgba.set([0, 255, 0, 128], 4 * (y * ann.width + x))
      ann.version++
      nv.setSlidePlaneInterpolation(true)
      const img = nv.getCanvasImage()
      out.annotation = { half: 0, other: 0, translucent: 0 }
      for (let i = 0; i < img.data.length; i += 4) {
        const [r, g, b, a] = img.data.slice(i, i + 4)
        if (a < 255) out.annotation.translucent++
        if (g > 118 && g < 138) out.annotation.half++
        else if (g > 5 || (r > 5 && r < 250) || (b > 5 && b < 250)) out.annotation.other++
      }
      // Half-alpha tiles over black: brightest red is 255 x 0.5, not x 0.25.
      const half = slideWith(null, 128)
      const halfKeys = [[0, 0], [1, 0], [0, 1]].map(([x, y]) => half.tileKey(half.manifest.levels[0], { x, y }))
      nv.setSlidePlane(half, { pixelToWorld, levelIndex: 0 })
      for (let i = 0; i < 100 && !halfKeys.every((k) => half.cachedTile(k)); i++) {
        nv.getCanvasImage()
        await new Promise((res) => setTimeout(res, 20))
      }
      const halfImg = nv.getCanvasImage().data
      out.halfRed = 0
      for (let i = 0; i < halfImg.length; i += 4) out.halfRed = Math.max(out.halfRed, halfImg[i])
      nv.destroy()
      canvas.remove()
      return out
    })()`)
    type Census = { pure: number; blend: number; green: number; black: number }
    const r = result as {
      skip?: string
      absent: { nearest: Census; linear: Census }
      none: { nearest: Census; linear: Census }
      label: { nearest: Census; linear: Census }
      mixed: { nearest: Census; linear: Census }
      headerPx: number
      annotation: { half: number; other: number; translucent: number }
      halfRed: number
    }
    test.skip(Boolean(r.skip), r.skip)
    const { absent, none } = r
    // The plane spans about 3/4 of the 128 px tile; a quarter of it is the hole.
    expect(absent.nearest.pure).toBeGreaterThan(4000)
    // Nearest: no blends inside a tile; partly covered edge pixels only.
    expect(absent.nearest.blend).toBeLessThan(absent.nearest.pure / 50)
    expect(absent.linear.blend).toBeGreaterThan(absent.linear.pure)
    // The hole: the absent colour, or the canvas behind a transparent plane.
    expect(absent.nearest.green).toBeGreaterThan(absent.nearest.pure / 4)
    expect(absent.linear.green).toBe(absent.nearest.green)
    expect(none.nearest.green).toBe(0)
    expect(none.nearest.black - absent.nearest.black).toBe(absent.nearest.green)
    // The header backing is one colour on both backends (WebGL2 drew bluer).
    expect(r.headerPx).toBeGreaterThan(100)
    // Label-only fused tiles stay nearest under linear filtering.
    expect(r.label.linear.pure).toBeGreaterThan(4000)
    expect(r.label.linear.blend).toBeLessThan(r.label.linear.pure / 50)
    // So do labels beside an intensity channel (their own nearest texture).
    expect(r.mixed.linear.pure).toBeGreaterThan(4000)
    expect(r.mixed.linear.blend).toBeLessThan(r.mixed.linear.pure / 50)
    // Annotation: WebGL2 once left canvas alpha 0.75 under it and WebGPU
    // magnified it linearly, blending a band at its edge.
    expect(r.annotation.translucent).toBe(0)
    expect(r.annotation.half).toBeGreaterThan(2500)
    expect(r.annotation.other).toBeLessThan(r.annotation.half / 50)
    // WebGL2 once uploaded tile bitmaps premultiplied: 64, not 128.
    expect(Math.abs(r.halfRed - 128)).toBeLessThan(4)
  })

// PL9 pixels: a placed slide (vendor joints, SRC-20: 3 frames of 16 px, seam
// 1|2 overlapping by o px, split at its midpoint) drawn as the 3D slide
// plane under nearest sampling shows the same columns as the 2D renderer:
// along the centre row, the same run of sample values (tile t, col c holds
// 20 t + c), each as wide as its placed span. o = 3 crops 1.5 px: two
// half-width columns at the seam.
const o = 3
for (const backend of ['webgl2', 'webgpu'] as const)
  test(`PL9: placed slide plane columns match the 2D renderer, overlap ${o} (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
        if ('${backend}' === 'webgpu') {
          if (!navigator.gpu) return { skip: 'no navigator.gpu' }
          const adapter = await navigator.gpu.requestAdapter().catch(() => null)
          if (!adapter) return { skip: 'no WebGPU adapter' }
        }
        const lib = await import('/src/index.ts')
        const o = ${o}, half = o / 2, PW = 48 - o
        const pieces = [
          { tile: 0, sx: 0, sy: 0, sw: 16 - half, sh: 16, dx: 0, dy: 0 },
          { tile: 1, sx: half, sy: 0, sw: 16 - half, sh: 16, dx: 16 - half, dy: 0 },
          { tile: 2, sx: 0, sy: 0, sw: 16, sh: 16, dx: 32 - o, dy: 0 },
        ]
        const placed = () => lib.NVSlide.fromSource({
          manifest: { id: 'placed', name: 'placed', width: PW, height: 16, dtype: 'uint8', channels: 'gray',
            channelInfo: [{ name: 'g', active: true }],
            levels: [{ index: 0, width: 48, height: 16, downsample: 1, columns: 3, rows: 1,
              tileWidth: 16, tileHeight: 16, bitsStored: 8,
              tiles: [0, 1, 2].map((x) => ({ x, y: 0, width: 16, height: 16 })),
              placement: { width: PW, height: 16, pieces } }] },
          bind() {},
          fetchTileBytes: async () => { throw new Error('samples only') },
          fetchTileSamples: async (_l, tile) => {
            const samples = new Uint8Array(256)
            for (let i = 0; i < 256; i++) samples[i] = 20 * tile.x + (i % 16)
            return { samples, width: 16, height: 16, bitsStored: 8, planes: 1 }
          },
        })
        const keysOf = (slide) => [0, 1, 2].map((x) => slide.tileKey(slide.manifest.levels[0], { x, y: 0 }))
        // Runs of grey values along a row: [value, length in px].
        const runs = (row, width) => {
          const out = []
          for (let x = 0; x < width; x++) {
            const [r, g, b] = [row[4 * x], row[4 * x + 1], row[4 * x + 2]]
            if (r !== g || g !== b) continue
            const last = out[out.length - 1]
            if (last && last[0] === r && last[2] === x - 1) { last[1]++; last[2] = x }
            else out.push([r, 1, x])
          }
          return out.map(([v, n]) => [v, n])
        }
        // 2D: K device px per placed px.
        const K = 6, W2 = PW * K
        const flat = placed()
        const c2 = document.createElement('canvas')
        c2.width = W2
        c2.height = 16 * K
        document.body.appendChild(c2)
        const screen = { widthCss: W2, heightCss: 16 * K, devicePixelRatio: 1 }
        flat.setViewport({ centerX: PW / 2, centerY: 8, scale: K })
        let r2
        if ('${backend}' === 'webgpu') {
          r2 = await lib.SlideRendererGPU.create(c2)
          if (!r2) return { skip: 'SlideRendererGPU unavailable' }
        } else {
          r2 = new lib.SlideRenderer()
          r2.init(c2.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false }))
        }
        r2.isNearestInterpolation = true
        for (let i = 0; i < 100 && keysOf(flat).some((k) => !flat.cachedTile(k)); i++) {
          flat.requestVisibleTiles(screen)
          await new Promise((res) => setTimeout(res, 20))
        }
        r2.render([flat], screen)
        const c = document.createElement('canvas')
        c.width = W2
        c.height = 16 * K
        const ctx = c.getContext('2d')
        ctx.drawImage(c2, 0, 0)
        const flatRuns = runs(ctx.getImageData(0, 8 * K, W2, 1).data, W2)
        r2.destroy()
        c2.remove()
        flat.dispose()
        // 3D: the plane seen from above, on a blue background (sample 0 is black).
        const size = 384
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        canvas.style.cssText = 'width:' + size + 'px;height:' + size + 'px'
        document.body.appendChild(canvas)
        const nv = new lib.default({
          backend: '${backend}', devicePixelRatio: 1, isAntiAlias: false,
          backgroundColor: [0, 0, 1, 1], azimuth: 0, elevation: 90,
          isOrientCubeVisible: false, isOrientationTextVisible: false,
          isColorbarVisible: false, is3DCrosshairVisible: false, crosshairWidth: 0,
        })
        await nv.attachToCanvas(canvas)
        if (nv.backend !== '${backend}') return { skip: 'fell back to ' + nv.backend }
        nv.sliceType = lib.SLICE_TYPE.RENDER
        await nv.loadVolumes([{ url: (${syntheticVolume})({ n: 16 }), opacity: 0 }])
        const mm = 40 / PW
        const pixelToWorld = lib.axialPlaneTransform(PW, 16, {
          xmin: -20, xmax: 20, ymin: -8 * mm, ymax: 8 * mm, z: 0, flipY: false,
        })
        const slide = placed()
        nv.setSlidePlane(slide, { pixelToWorld, levelIndex: 0 })
        nv.setSlidePlaneInterpolation(true)
        for (let i = 0; i < 100 && keysOf(slide).some((k) => !slide.cachedTile(k)); i++) {
          nv.getCanvasImage()
          await new Promise((res) => setTimeout(res, 20))
        }
        nv.setSlidePlaneInterpolation(true)
        const img = nv.getCanvasImage()
        const y = Math.floor(img.height / 2)
        let planeRuns = runs(img.data.subarray(4 * y * img.width, 4 * (y + 1) * img.width), img.width)
        nv.destroy()
        canvas.remove()
        if (planeRuns.length && planeRuns[0][0] > planeRuns[planeRuns.length - 1][0]) planeRuns = planeRuns.reverse()
        return { flatRuns, planeRuns }
      })()`)
    const r = result as {
      skip?: string
      flatRuns: [number, number][]
      planeRuns: [number, number][]
    }
    test.skip(Boolean(r.skip), r.skip)
    const PW = 48 - o
    const values = (rs: [number, number][]) => rs.map(([v]) => v)
    // SRC-20: each piece cropped at its placed origin (tile 0 up to the
    // seam's midpoint, tile 1 from it, tile 2 whole), and the plane shows the
    // same columns, in order.
    const cols = (n: number, from: number) =>
      Array.from({ length: n }, (_, c) => from + c)
    expect(values(r.flatRuns)).toEqual([
      ...cols(15, 0),
      ...cols(15, 21),
      ...cols(16, 40),
    ])
    expect(values(r.planeRuns)).toEqual(values(r.flatRuns))
    // Each run spans its placed width (in placed px): 1, or 1/2 beside the
    // seam. Device px are rounded, so within half a placed px.
    const widths = (rs: [number, number][]) => {
      const total = rs.reduce((n, [, w]) => n + w, 0)
      return rs.map(([, w]) => (w * PW) / total)
    }
    const flat = widths(r.flatRuns)
    const plane = widths(r.planeRuns)
    expect(flat.filter((w) => w < 0.75)).toHaveLength(2)
    for (const [i, w] of plane.entries())
      expect(Math.abs(w - (flat[i] as number))).toBeLessThan(0.3)
  })
