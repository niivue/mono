import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// VOLUME_RENDER_MODE.CINEMATIC settings: the setter merges, documents keep
// them, and an older document's partial object is filled from the defaults.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('volumeCinematic merges and survives a document round trip', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue, VOLUME_RENDER_MODE } = await import(
      '/src/index.ts'
    )
    const nv = new NiiVue({
      backend: 'webgl2',
      volumeCinematic: { exposure: 1.5 },
    })
    const fromOptions = nv.volumeCinematic.exposure
    nv.volumeCinematic = { shadow: 0.25, labelMode: 'none' }
    nv.volumeRenderMode = VOLUME_RENDER_MODE.CINEMATIC
    const doc = nv.serializeDocument()
    nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
    nv.volumeCinematic = { exposure: 1, shadow: 1, labelMode: 'only' }
    await nv.loadDocument(new File([doc], 'c.nvd'))
    const loaded = { mode: nv.volumeRenderMode, ...nv.volumeCinematic }
    // A document holding only some keys gets the rest from the defaults.
    nv.model.volume.cinematic = { ao: 0.1 } as typeof nv.volumeCinematic
    const partial = nv.serializeDocument()
    await nv.loadDocument(new File([partial], 'p.nvd'))
    return { fromOptions, loaded, partial: nv.volumeCinematic }
  })
  expect(r.fromOptions).toBe(1.5)
  expect(r.loaded).toMatchObject({
    mode: 3,
    exposure: 1.5,
    shadow: 0.25,
    labelMode: 'none',
    maxFrames: 256,
  })
  expect(r.partial).toMatchObject({ ao: 0.1, maxFrames: 256, exposure: 1 })
})

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
