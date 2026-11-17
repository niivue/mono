import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// An RGB slide's bitmap tiles draw through its red, green and blue windows
// (NVSlide.rgbWindow), before the ICC table. A (200, 128, 40) tile windowed
// red 100..200, green 64..192 and blue ..80 draws (255, 128, 128); with a
// table that swaps red and blue, (128, 128, 255), so the window ran first.
// The minimap matches; default windows draw the tile as decoded again.

test.use(webgpuUse)

const SETUP = `
  const n = 4
  const manifest = {
    id: 'win', name: 'win', width: n, height: n, dtype: 'uint8', channels: 'rgba',
    levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
      columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
  }
  const rgba = new Uint8Array(n * n * 4)
  for (let i = 0; i < n * n; i++) rgba.set([200, 128, 40, 255], 4 * i)
  const windowed = (on) => {
    const d = { calMin: NaN, calMax: NaN }
    slide.setChannel(0, on ? { calMin: 100, calMax: 200 } : d)
    slide.setChannel(1, on ? { calMin: 64, calMax: 192 } : d)
    slide.setChannel(2, on ? { calMax: 80 } : d)
  }
  const tile = () => slide.cachedTile(slide.tileKey(slide.manifest.levels[0], { x: 0, y: 0 }))
`
const GPU_CHECK = `
  if (!navigator.gpu) return { skip: 'no navigator.gpu' }
  const adapter = await navigator.gpu.requestAdapter().catch(() => null)
  if (!adapter) return { skip: 'no WebGPU adapter' }
`
const diff = (a: number[], b: number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))))

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`RGB slide windows apply before the colour table (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      ${backend === 'webgpu' ? GPU_CHECK : ''}
      const { NVSlide, SlideRenderer, SlideRendererGPU } = await import('/src/index.ts')
      ${SETUP}
      // 2^3 table, red fastest: entry (r, g, b) holds (b, g, r).
      const swap = new Uint8Array(32)
      for (let e = 0; e < 8; e++)
        swap.set([e & 4 ? 255 : 0, e & 2 ? 255 : 0, e & 1 ? 255 : 0, 255], 4 * e)
      NVSlide.registerIccTransform(async () => ({ size: 2, data: swap }))
      const slide = NVSlide.fromSource({
        manifest,
        bind() {},
        fetchTileBytes: async () => rgba,
        fetchIccProfile: async () => new Uint8Array(4),
      })
      NVSlide.registerIccTransform(null)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      canvas.style.width = canvas.style.height = '64px'
      document.body.appendChild(canvas)
      const screen = { widthCss: 64, heightCss: 64, devicePixelRatio: 1 }
      slide.fitToScreen(screen, 1)
      let renderer
      if ('${backend}' === 'webgpu') {
        renderer = await SlideRendererGPU.create(canvas)
        if (!renderer) return { skip: 'SlideRendererGPU unavailable' }
      } else {
        renderer = new SlideRenderer()
        renderer.init(canvas.getContext('webgl2', { preserveDrawingBuffer: true }))
      }
      // Read in the same task as the draw: a WebGPU canvas drops its texture once presented.
      const centre = () => {
        renderer.render([slide], screen)
        const ctx = new OffscreenCanvas(64, 64).getContext('2d')
        ctx.drawImage(canvas, 0, 0)
        return [...ctx.getImageData(32, 32, 1, 1).data.slice(0, 3)]
      }
      const thumb = () => {
        const bmp = slide.thumbnailBitmap()
        const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
        ctx.drawImage(bmp, 0, 0)
        return [...ctx.getImageData(1, 1, 1, 1).data.slice(0, 3)]
      }
      for (let i = 0; i < 100 && (!tile() || !slide.colorLut); i++) {
        slide.requestVisibleTiles(screen)
        await new Promise((res) => setTimeout(res, 20))
      }
      const managed = centre()
      windowed(true)
      const managedWindowed = centre()
      slide.colorManagement = false
      const windowedPx = centre()
      const windowedThumb = thumb()
      windowed(false)
      const plain = centre()
      renderer.destroy()
      canvas.remove()
      return { managed, managedWindowed, windowed: windowedPx, windowedThumb, plain }
    })()`)
    const r = result as Record<string, number[]> & { skip?: string }
    test.skip(Boolean(r.skip), r.skip)
    expect(diff(r.managed as number[], [40, 128, 200])).toBeLessThanOrEqual(1)
    expect(
      diff(r.managedWindowed as number[], [128, 128, 255]),
    ).toBeLessThanOrEqual(1)
    expect(diff(r.windowed as number[], [255, 128, 128])).toBeLessThanOrEqual(1)
    expect(
      diff(r.windowedThumb as number[], r.windowed as number[]),
    ).toBeLessThanOrEqual(1)
    expect(r.plain).toEqual([200, 128, 40])
  })
}

// The slide plane in the 3D render tile (slidePlaneRender.ts), seen from above.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`RGB slide plane windows its bitmap tiles (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      ${backend === 'webgpu' ? GPU_CHECK : ''}
      const lib = await import('/src/index.ts')
      ${SETUP}
      const slide = lib.NVSlide.fromSource({ manifest, bind() {}, fetchTileBytes: async () => rgba })
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      canvas.style.cssText = 'width:64px;height:64px'
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
      const transform = lib.axialPlaneTransform(n, n, {
        xmin: -20, xmax: 20, ymin: -20, ymax: 20, z: 0, flipY: false,
      })
      nv.setSlidePlane(slide, { pixelToWorld: transform, levelIndex: 0 })
      for (let i = 0; i < 100 && !tile(); i++) {
        nv.getCanvasImage()
        await new Promise((res) => setTimeout(res, 20))
      }
      const centre = () => {
        const img = nv.getCanvasImage()
        const i = 4 * ((img.height >> 1) * img.width + (img.width >> 1))
        return [...img.data.slice(i, i + 3)]
      }
      windowed(true)
      const windowedPx = centre()
      windowed(false)
      const plain = centre()
      nv.destroy()
      canvas.remove()
      return { windowed: windowedPx, plain }
    })()`)
    const r = result as Record<string, number[]> & { skip?: string }
    test.skip(Boolean(r.skip), r.skip)
    expect(diff(r.windowed as number[], [255, 128, 128])).toBeLessThanOrEqual(1)
    expect(r.plain).toEqual([200, 128, 40])
  })
}
