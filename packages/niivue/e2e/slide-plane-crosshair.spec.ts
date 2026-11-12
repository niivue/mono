import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// With no volume, the depth pick has nothing to hit: a double-click on a slide
// plane in the 3D render must still move the crosshair to the plane, and a
// double-click off the plane must leave it alone.
//
// WebGPU is skipped when the runner has no adapter.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`double-click on a slide plane moves the crosshair (${backend})`, async ({
    page,
  }) => {
    const r = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, NVSlide, SLICE_TYPE, axialPlaneTransform } =
        await import('/src/index.ts')
      const n = 16
      const slide = NVSlide.fromSource({
        manifest: {
          id: 'p', name: 'p', width: n, height: n, dtype: 'uint8', channels: 'rgba',
          levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
            columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
        },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(n * n * 4).fill(255),
      })
      const c = document.createElement('canvas')
      c.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px'
      document.body.appendChild(c)
      const nv = new NiiVue({
        backend: '${backend}',
        devicePixelRatio: 1,
        sliceType: SLICE_TYPE.RENDER,
      })
      await nv.attachToCanvas(c)
      // Look straight down so the axial plane faces the camera.
      nv.azimuth = 0
      nv.elevation = 90
      const pixelToWorld = axialPlaneTransform(n, n, {
        xmin: -50, xmax: 50, ymin: -50, ymax: 50, z: 0,
      })
      nv.setSlidePlane(slide, { pixelToWorld })
      // The pick frame is captured when the plane is drawn.
      for (let i = 0; i < 100 && !nv.slidePlanePick(150, 150); i++)
        await new Promise((res) => requestAnimationFrame(res))
      const depthPick = nv.view.depthPick.bind(nv.view)
      let lastPick = null
      nv.view.depthPick = (...a) => (lastPick = depthPick(...a))
      const events = []
      nv.addEventListener('locationChange', (e) =>
        events.push({ axCorSag: e.detail.axCorSag, pos: [...nv.crosshairPos] }))
      const rect = c.getBoundingClientRect()
      const dbl = async (x, y) => {
        lastPick = null
        c.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y,
        }))
        // The handler awaited the pick first, so its continuation has run.
        if (lastPick) await lastPick.catch(() => null)
      }
      const before = [...nv.crosshairPos]
      await dbl(2, 2) // canvas corner: off the plane
      const offPlane = { events: events.length, pos: [...nv.crosshairPos] }
      // Off-centre, so the result differs from the default centre crosshair.
      const [x, y] = [180, 120]
      const hit = nv.slidePlanePick(x, y)
      const m = pixelToWorld
      const expected = hit && [
        m[0] * hit.x + m[4] * hit.y + m[12],
        m[1] * hit.x + m[5] * hit.y + m[13],
        m[2] * hit.x + m[6] * hit.y + m[14],
      ]
      await dbl(x, y)
      return {
        before, offPlane, expected, events,
        mm: [...nv.model.scene2mm(nv.crosshairPos)],
        pos: [...nv.crosshairPos],
        render: SLICE_TYPE.RENDER,
      }
    })()`)
    if ('skip' in r) {
      test.skip(true, r.skip)
      return
    }
    expect(r.offPlane).toEqual({ events: 0, pos: r.before })
    expect(r.expected).not.toBeNull()
    expect(r.pos).not.toEqual(r.before)
    for (let i = 0; i < 3; i++) expect(r.mm[i]).toBeCloseTo(r.expected[i], 3)
    // One locationChange, after the crosshair moved.
    expect(r.events).toEqual([{ axCorSag: r.render, pos: r.pos }])
  })

  // Each render tile has its own camera: the same tile-relative point in two
  // identical render tiles must pick the same slide pixel. A mosaic needs a
  // volume for its tiles; the pick is the one the double-click fallback uses.
  test(`slide pick uses the render tile under the point (${backend})`, async ({
    page,
  }) => {
    const r = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, NVSlide, SLICE_TYPE, axialPlaneTransform } =
        await import('/src/index.ts')
      const n = 16
      const slide = NVSlide.fromSource({
        manifest: {
          id: 'p', name: 'p', width: n, height: n, dtype: 'uint8', channels: 'rgba',
          levels: [{ index: 0, width: n, height: n, downsample: 1, tileWidth: n, tileHeight: n,
            columns: 1, rows: 1, codec: 'raw-rgba', tiles: [{ x: 0, y: 0, width: n, height: n }] }],
        },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(n * n * 4).fill(255),
      })
      const c = document.createElement('canvas')
      c.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px'
      document.body.appendChild(c)
      const nv = new NiiVue({
        backend: '${backend}',
        devicePixelRatio: 1,
        sliceType: SLICE_TYPE.RENDER,
      })
      await nv.attachToCanvas(c)
      await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz' }])
      nv.mosaicString = 'R 0 R 0'
      nv.azimuth = 0
      nv.elevation = 90
      nv.setSlidePlane(slide, {
        pixelToWorld: axialPlaneTransform(n, n, {
          xmin: -50, xmax: 50, ymin: -50, ymax: 50, z: 0,
        }),
      })
      let frames = []
      for (let i = 0; i < 100 && frames.length < 2; i++) {
        await new Promise((res) => requestAnimationFrame(res))
        frames = nv.view.slidePlane?.pickFrames ?? []
      }
      if (frames.length !== 2) return { frames: frames.length }
      const hits = frames.map(({ ltwh }) =>
        nv.slidePlanePick(ltwh[0] + 0.6 * ltwh[2], ltwh[1] + 0.4 * ltwh[3]))
      return { frames: frames.length, hits }
    })()`)
    if ('skip' in r) {
      test.skip(true, r.skip)
      return
    }
    expect(r.frames).toBe(2)
    expect(r.hits[0]).not.toBeNull()
    expect(r.hits[1]?.x).toBeCloseTo(r.hits[0].x, 3)
    expect(r.hits[1]?.y).toBeCloseTo(r.hits[0].y, 3)
  })
}
