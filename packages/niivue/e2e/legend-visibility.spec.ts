import { expect, test } from '@playwright/test'

// Regression for #350: the legend read a `showLegend` nothing set, so the
// per-volume and per-mesh `isLegendVisible` never hid anything.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('per-item isLegendVisible picks the voxel atlas, the mesh atlas, both or neither', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    await nv.loadVolumes([
      { url: '/volumes/mni152.nii.gz' },
      { url: '/volumes/aal.nii.gz' },
    ])
    await nv.addColormapFromUrl('/volumes/aal.json')
    await nv.setVolume(1, { colormap: 'aal' })
    await nv.loadMeshes([{ url: '/meshes/atl-Anatom_space-MNI.mz3' }])
    const count = () => nv.model.collectLegendEntries().length
    const show = async (voxel: boolean, mesh: boolean) => {
      await nv.setVolume(1, { isLegendVisible: voxel })
      await nv.setMesh(0, { isLegendVisible: mesh })
      return count()
    }
    const byDefault = count()
    const voxel = await show(true, false)
    const mesh = await show(false, true)
    const both = await show(true, true)
    const none = await show(false, false)
    await show(true, true)
    nv.isLegendVisible = false
    const viewerOff = count()
    // A v11 document keeps an explicit false.
    nv.isLegendVisible = true
    await nv.setVolume(1, { isLegendVisible: false })
    await nv.loadDocument(new File([nv.serializeDocument()], 'l.nvd'))
    const afterReload = nv.volumes[1].isLegendVisible
    return { byDefault, voxel, mesh, both, none, viewerOff, afterReload }
  })
  expect(r.voxel).toBeGreaterThan(0)
  expect(r.mesh).toBeGreaterThan(0)
  expect(r.both).toBe(r.voxel + r.mesh)
  expect(r.byDefault).toBe(r.both)
  expect(r.none).toBe(0)
  expect(r.viewerOff).toBe(0)
  expect(r.afterReload).toBe(false)
})

test('load options hide an item, and a v10 document drops its stale false', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const { deserialize } = await import('/src/NVDocument.ts')
    const { encodeDocumentJSON } = await import('/src/documentJson.ts')
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    await nv.addColormapFromUrl('/volumes/aal.json')
    await nv.loadVolumes([
      { url: '/volumes/mni152.nii.gz' },
      { url: '/volumes/aal.nii.gz', colormap: 'aal', isLegendVisible: false },
    ])
    await nv.loadMeshes([
      { url: '/meshes/atl-Anatom_space-MNI.mz3', isLegendVisible: false },
    ])
    const fromOptions = nv.model.collectLegendEntries().length
    // Before v11 both items saved the old default false, which never hid
    // anything; loading must not start hiding them now.
    const doc = deserialize(nv.serializeDocument()) as {
      version: number
      volumes: { isLegendVisible?: boolean }[]
      meshes: { isLegendVisible?: boolean }[]
    }
    doc.version = 10
    await nv.loadDocument(new File([encodeDocumentJSON(doc)], 'v10.nvd'))
    return {
      fromOptions,
      volume: nv.volumes[1].isLegendVisible,
      mesh: nv.meshes[0].isLegendVisible,
      entries: nv.model.collectLegendEntries().length,
    }
  })
  expect(r.fromOptions).toBe(0)
  expect(r.volume).toBe(true)
  expect(r.mesh).toBe(true)
  expect(r.entries).toBeGreaterThan(0)
})
