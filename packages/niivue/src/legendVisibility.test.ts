import { expect, test } from 'bun:test'
import { encodeDocumentJSON } from '@/documentJson'
import NiiVue from '@/index'
import { deserialize } from '@/NVDocument'
import { devImageUrl, documentFile, niftiBytes } from '@/testing/headless'

// Regression for #350: the legend read a `showLegend` nothing set, so the
// per-volume and per-mesh `isLegendVisible` never hid anything. A small
// background stands in for mni152 and a small synthetic atlas for the aal
// volume (whose 16 MB embedded document made these tests slow): only the atlas
// volume and mesh list labels.

const BACKGROUND = devImageUrl('volumes/hippo.nii.gz')
const MESH_ATLAS = devImageUrl('meshes/atl-Anatom_space-MNI.mz3')

/** NIFTI_INTENT_LABEL holding IDs 0 (Air), 1, 2 and 3. */
const ATLAS = () =>
  new File(
    [
      niftiBytes({
        dims: [8, 8, 4],
        datatype: 'uint8',
        intentCode: 1002,
        voxel: (i) => i % 4,
      }),
    ],
    'atlas.nii',
  )

// The aal table, fetched by URL so addColormapFromUrl's fetch path runs; it
// names IDs 1-3 (Precentral_L, Precentral_R, Frontal_Sup_L).
const ATLAS_TABLE = devImageUrl('volumes/aal.json')

test('per-item isLegendVisible picks the voxel atlas, the mesh atlas, both or neither', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: BACKGROUND }, { url: ATLAS() }])
  await nv.addColormapFromUrl(ATLAS_TABLE)
  await nv.setVolume(1, { colormap: 'aal' })
  await nv.loadMeshes([{ url: MESH_ATLAS }])
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
  await nv.loadDocument(documentFile(nv.serializeDocument(), 'l.nvd'))

  expect(voxel).toBeGreaterThan(0)
  expect(mesh).toBeGreaterThan(0)
  expect(both).toBe(voxel + mesh)
  expect(byDefault).toBe(both)
  expect(none).toBe(0)
  expect(viewerOff).toBe(0)
  expect(nv.volumes[1].isLegendVisible).toBe(false)
})

test('load options hide an item, and a v10 document drops its stale false', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.addColormapFromUrl(ATLAS_TABLE)
  await nv.loadVolumes([
    { url: BACKGROUND },
    { url: ATLAS(), colormap: 'aal', isLegendVisible: false },
  ])
  await nv.loadMeshes([{ url: MESH_ATLAS, isLegendVisible: false }])
  const fromOptions = nv.model.collectLegendEntries().length
  // Before v11 both items saved the old default false, which never hid
  // anything; loading must not start hiding them now.
  const doc = { ...deserialize(nv.serializeDocument()), version: 10 }
  await nv.loadDocument(documentFile(encodeDocumentJSON(doc), 'v10.nvd'))

  expect(fromOptions).toBe(0)
  expect(nv.volumes[1].isLegendVisible).toBe(true)
  expect(nv.meshes[0].isLegendVisible).toBe(true)
  expect(nv.model.collectLegendEntries().length).toBeGreaterThan(0)
})
