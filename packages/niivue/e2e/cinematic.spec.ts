import { expect, test } from '@playwright/test'

// VOLUME_RENDER_MODE.CINEMATIC settings: the setter merges, documents keep
// them, and an older document's partial object is filled from the defaults.

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
