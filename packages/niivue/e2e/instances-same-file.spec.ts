import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// Issue #346: two volumes loaded from one file drew the same texture in the
// instance layout.
//
// The renderers cached each volume's texture under its url (its name when it
// had none), so the grey and the hot copy of one file shared a cache entry:
// each upload replaced the other's, and both instances drew whichever came
// last. The cache now keys on the volume itself (volumeCacheKey).
//
// The assertion is that the hot copy draws redder than the grey one. Revert
// either backend's key to the url and both halves draw the same colours.
//
// WebGPU is skipped when the runner has no adapter.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const VOLUME = '/volumes/mni152.nii.gz'

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`two volumes from one file keep their own textures (${backend})`, async ({
    page,
  }) => {
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
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 128
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
      await nv.loadVolumes([
        { url: '${VOLUME}', name: 'mni' },
        { url: '${VOLUME}', name: 'mni hot', colormap: 'hot' },
      ])
      // The default camera sits at z = 32 looking down -z; a scale of 10
      // puts both copies well inside the view, the grey one on the left.
      await nv.setInstances([
        { id: 'grey', space: 'global3d', volumeId: 'mni', position: [-7, 0, 0], scale: 10 },
        { id: 'hot', space: 'global3d', volumeId: 'mni hot', position: [7, 0, 0], scale: 10 },
      ])

      // Render, then copy in the same task (no preserveDrawingBuffer needed).
      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      await nextFrame()
      if (nv.view) nv.view.render()
      ctx.drawImage(canvas, 0, 0)
      const px = ctx.getImageData(0, 0, readback.width, readback.height).data
      // Per half: how many pixels are lit, and how much redder than green
      // they are on average.
      const half = (x0, x1) => {
        let lit = 0
        let red = 0
        for (let y = 0; y < readback.height; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * readback.width + x) * 4
            if (px[i] + px[i + 1] + px[i + 2] < 30) continue
            lit++
            red += px[i] - px[i + 1]
          }
        }
        return { lit, redness: lit ? red / lit : 0 }
      }
      return {
        left: half(0, readback.width / 2),
        right: half(readback.width / 2, readback.width),
      }
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

    // Guard the guard: both copies must be on screen, or the colour check
    // below compares background.
    expect(r.left.lit).toBeGreaterThan(500)
    expect(r.right.lit).toBeGreaterThan(500)
    expect(r.right.redness - r.left.redness).toBeGreaterThan(30)
  })
}
