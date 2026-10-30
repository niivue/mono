import { expect, test } from '@playwright/test'

// Issue #377: the font size is applied in the view's resize relayout, so
// setting fontScale or fontMinSize must relayout, not only redraw.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

for (const backend of ['webgl2', 'webgpu']) {
  test(`${backend}: fontScale and fontMinSize resize text without resize()`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const r = await page.evaluate(`(async () => {
      const { default: NiiVue } = await import('/src/index.ts')
      const canvas = document.createElement('canvas')
      // fontScale only acts on canvases larger than 800x600 points.
      canvas.style.cssText = 'width:1600px;height:1200px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({ backend: '${backend}' })
      await nv.attachToCanvas(canvas)
      const px = () => nv.view.fontRenderer.fontPx
      const before = px()
      nv.fontScale = nv.fontScale * 3
      const scaled = px()
      nv.fontMinSize = nv.fontMinSize * 2
      const minSized = px()
      const actual = nv.backend
      nv.destroy()
      return { backend: actual, before, scaled, minSized }
    })()`)
    // Headless Chromium may lack a WebGPU adapter and fall back to WebGL2.
    test.skip(r.backend !== backend, `${backend} unavailable`)
    expect(r.scaled).toBeGreaterThan(r.before)
    expect(r.minSized).toBeGreaterThan(r.scaled)
  })
}

test('loadDocument applies the document fontScale without resize()', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const r = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:1600px;height:1200px'
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    const before = nv.view.fontRenderer.fontPx
    const bytes = new NiiVue({ fontScale: nv.fontScale * 3 }).serializeDocument()
    await nv.loadDocument(new File([bytes], 'doc.nvd'))
    const after = nv.view.fontRenderer.fontPx
    nv.destroy()
    return { before, after }
  })()`)
  expect(r.after).toBeGreaterThan(r.before)
})
