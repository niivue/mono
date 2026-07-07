import { expect, test } from '@playwright/test'

// End-to-end coverage for the two NVDocument save/reload behaviors that can only
// be exercised in a real browser (NiiVue's Vite module graph + a GPU context):
//   - linkData: reference volumes by URL instead of embedding their bytes.
//   - sparse settings: omit defaults; leave omitted settings at the current value.
// The page just provides the dev-server origin so `import('/src/index.ts')` and
// `/volumes/...` resolve; the work happens inside page.evaluate.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('linkData: a linked document omits volume bytes and refetches from the URL', async ({
  page,
}) => {
  test.setTimeout(90_000) // fetch + embed of a full volume

  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const mkCanvas = () => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 64
      c.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(c)
      return c
    }

    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

    const embedded = nv.serializeDocument().byteLength
    const linkedBytes = nv.serializeDocument({ linkData: true })

    // Reload the linked document into a fresh instance: the volume must refetch.
    const nv2 = new NiiVue({ backend: 'webgl2' })
    await nv2.attachToCanvas(mkCanvas())
    await nv2.loadDocument(new File([linkedBytes], 'linked.nvd'))

    return {
      embedded,
      linked: linkedBytes.byteLength,
      reloadedUrl: nv2.volumes[0]?.url,
      reloadedVoxels: nv2.volumes[0]?.img?.length ?? 0,
    }
  })

  // The linked document is a tiny reference, not the ~11 MB embedded volume.
  expect(r.linked).toBeLessThan(r.embedded / 100)
  // It reloaded by refetching the referenced URL.
  expect(r.reloadedUrl).toBe('/volumes/mni152.nii.gz')
  expect(r.reloadedVoxels).toBeGreaterThan(1_000_000)
})

test('sparse settings: neverSave keeps the loading instance value; specified settings win', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')

    // Source: azimuth changed (saved); crosshair left at default (omitted). Also
    // never-save the crosshair explicitly (it is default here, but this asserts
    // the policy path too).
    const src = new NiiVue({ azimuth: 200 })
    src.settingsSavePolicy = { neverSave: ['scene.crosshairPos'] }
    const sparseBytes = src.serializeDocument()

    // Target has its own crosshair; loading adopts the doc's azimuth but keeps
    // the crosshair the document did not specify.
    const target = new NiiVue({ azimuth: 50 })
    target.crosshairPos = [0.7, 0.8, 0.9]
    await target.loadDocument(new File([sparseBytes], 'sparse.nvd'))

    // A document that DOES specify a setting overrides the current value.
    const full = new NiiVue({})
    full.crosshairPos = [0.1, 0.2, 0.3]
    const fullBytes = full.serializeDocument()
    const target2 = new NiiVue({})
    target2.crosshairPos = [0.9, 0.9, 0.9]
    await target2.loadDocument(new File([fullBytes], 'full.nvd'))

    return {
      adoptedAzimuth: target.azimuth,
      keptCrosshair: [...target.crosshairPos],
      overriddenCrosshair: [...target2.crosshairPos],
    }
  })

  expect(r.adoptedAzimuth).toBe(200)
  expect(r.keptCrosshair).toEqual([0.7, 0.8, 0.9])
  expect(r.overriddenCrosshair).toEqual([0.1, 0.2, 0.3])
})
