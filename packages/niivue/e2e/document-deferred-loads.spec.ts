import { expect, test } from '@playwright/test'

// Issue #388: loadVolumes while a thumbnail is visible is deferred until the
// thumbnail is dismissed. loadDocument replaces all data, so a load deferred
// before it must not replace the document's volumes on dismissal.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('loadDocument drops volumes deferred behind an earlier thumbnail', async ({
  page,
}) => {
  test.setTimeout(90_000)

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
    const thumb = mkCanvas().toDataURL('image/png')

    // A document with one volume and a thumbnail.
    const src = new NiiVue({ backend: 'webgl2' })
    await src.attachToCanvas(mkCanvas())
    await src.loadVolumes([{ url: '/volumes/hippo.nii.gz' }])
    src.thumbnailUrl = thumb
    const bytes = src.serializeDocument()

    const nv = new NiiVue({ backend: 'webgl2', thumbnail: thumb })
    await nv.attachToCanvas(mkCanvas())
    await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }]) // deferred
    await nv.loadDocument(new File([bytes], 'doc.nvd'))
    const visibleAfterLoad = nv.isThumbnailVisible

    nv.isThumbnailVisible = false
    // A stale deferred load would replace the document volume with mni152 here.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    return {
      visibleAfterLoad,
      urls: nv.volumes.map((v) => v.url),
    }
  })

  expect(r.visibleAfterLoad).toBe(true)
  expect(r.urls).toEqual(['/volumes/hippo.nii.gz'])
})
