import { expect } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'
import { test } from './sharedPage'

// VOLUME_RENDER_MODE.CINEMATIC on a live view. Its settings (merge, document
// round trip) are tested in src/loadDocument.roundtrip.test.ts.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

// Both backends draw CINEMATIC (not a COMPOSITE stand-in), refine to
// maxFrames and stop, and free everything when the mode is left.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`cinematic refines, stops and frees (${backend})`, async ({ page }) => {
    const r = await page.evaluate(async (backend) => {
      if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
        return null
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const next = () =>
        new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50)))
      const c = document.createElement('canvas')
      c.width = c.height = 128
      document.body.appendChild(c)
      const nv = new NiiVue({
        backend,
        sliceType: SLICE_TYPE.RENDER,
        volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
        volumeCinematic: { maxFrames: 4 },
      })
      await nv.attachToCanvas(c)
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      const cine = nv.view.cinematicRenderer
      const frames = () => [...cine.tiles.values()].map((t) => t.frame)
      for (let i = 0; i < 100 && frames()[0] !== 4; i++) await next()
      const converged = frames()
      // Converged: the self-driven loop schedules nothing more.
      const render = nv.view.render.bind(nv.view)
      let renders = 0
      nv.view.render = () => {
        renders++
        render()
      }
      for (let i = 0; i < 5; i++) await next()
      nv.view.render = render
      nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
      for (let i = 0; i < 3; i++) await next()
      return {
        backend: nv.backend,
        isReady: cine.isReady,
        converged,
        renders,
        tilesAfter: cine.tiles.size,
      }
    }, backend)
    test.skip(!r, 'no WebGPU adapter')
    expect(r).toEqual({
      backend,
      isReady: true,
      converged: [4],
      renders: 0,
      tilesAfter: 0,
    })
  })
}
