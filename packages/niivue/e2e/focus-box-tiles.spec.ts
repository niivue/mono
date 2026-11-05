import { expect } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'
import { test } from './sharedPage'

// Issue #347: world-space boxes (focusBox, lodBoxes) are projected on the GPU
// per 3D render tile. Each tile must show its boxes, and a box zoomed past its
// tile must not bleed into the neighbouring 2D tiles.
//
// WebGPU is skipped when the runner has no adapter.

test.use({ launchOptions: webgpuLaunchOptions })

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`boxes stay on their render tiles (${backend})`, async ({ page }) => {
    test.setTimeout(180_000)
    const result = await page.evaluate(`(async () => {
     try {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        let adapter = null
        try {
          adapter = await navigator.gpu.requestAdapter()
        } catch (e) {
          return { skip: 'requestAdapter threw: ' + e }
        }
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE, SHOW_RENDER } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))
      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 200
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
        sliceType: SLICE_TYPE.RENDER,
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
      })
      await nv.attachToCanvas(canvas)
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz', name: 'v' }])
      // Keep the crosshair out of the red count.
      nv.crosshairColor = [0, 1, 0, 1]
      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      // Red pixels inside and outside each render tile.
      const red = async () => {
        await nextFrame()
        nv.view.render()
        const rects = nv.getScreenTiles()
          .filter((t) => t.axCorSag === SLICE_TYPE.RENDER)
          .map((t) => t.leftTopWidthHeight)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        const inside = rects.map(() => 0)
        let outside = 0
        for (let y = 0; y < readback.height; y++) {
          for (let x = 0; x < readback.width; x++) {
            const i = (y * readback.width + x) * 4
            if (px[i] < 200 || px[i + 1] > 60 || px[i + 2] > 60) continue
            // 1 px slack: the scissor rounds fractional tile edges.
            const k = rects.findIndex(([l, t, w, h]) =>
              x >= l - 1 && x < l + w + 1 && y >= t - 1 && y < t + h + 1)
            if (k < 0) outside++
            else inside[k]++
          }
        }
        return { inside, outside, renderTiles: rects.length }
      }
      const box = (s) => ({ min: [-s, -s, -s], max: [s, s, s], color: [1, 0, 0, 1], thickness: 3 })

      // Multiplanar: a box zoomed well past the render tile stays inside it.
      nv.sliceType = SLICE_TYPE.MULTIPLANAR
      nv.showRender = SHOW_RENDER.ALWAYS
      nv.scaleMultiplier = 4
      nv.focusBox = box(60)
      const zoomed = await red()
      nv.focusBox = null
      nv.scaleMultiplier = 1
      nv.sliceType = SLICE_TYPE.RENDER

      // Two render tiles side by side, a focus box and an LOD box on each.
      await nv.setInstances([
        { id: 'a', volumeId: 'v', bounds: [[0, 0], [0.5, 1]] },
        { id: 'b', volumeId: 'v', bounds: [[0.5, 0], [1, 1]] },
      ])
      nv.focusBox = box(40)
      nv.lodBoxes = [box(20)]
      const twoTiles = await red()
      nv.focusBox = null
      nv.lodBoxes = null
      const cleared = await red()

      return { twoTiles, cleared, zoomed }
     } catch (e) {
      const m = String(e && e.message ? e.message : e)
      if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
        return { skip: 'GPU unavailable: ' + m }
      }
      throw e
     }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }
    const [a, b] = r.twoTiles.inside
    expect(a).toBeGreaterThan(100)
    // Same view on both tiles: the same outline, give or take rounding.
    expect(Math.abs(a - b)).toBeLessThan(a * 0.1)
    expect(r.twoTiles.outside).toBe(0)
    expect(r.cleared.inside).toEqual([0, 0])
    expect(r.zoomed.renderTiles).toBe(1)
    expect(r.zoomed.inside[0]).toBeGreaterThan(100)
    expect(r.zoomed.outside).toBe(0)
  })
}
