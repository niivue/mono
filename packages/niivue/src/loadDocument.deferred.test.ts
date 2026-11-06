import { expect, spyOn, test } from 'bun:test'
import NiiVue from '@/index'
import { devImageUrl, documentFile } from '@/testing/headless'

// Issue #388: loadVolumes while a thumbnail is visible is deferred until the
// thumbnail is dismissed. loadDocument replaces all data, so a load deferred
// before it must not replace the document's volumes on dismissal.

// Any image URL will do: with no canvas attached the thumbnail is never
// decoded, only recorded in the document.
const THUMBNAIL = 'data:image/png;base64,iVBORw0KGgo='

test('loadDocument drops volumes deferred behind an earlier thumbnail', async () => {
  const hippo = devImageUrl('volumes/hippo.nii.gz')
  // A document with one volume and a thumbnail.
  const src = new NiiVue({ backend: 'webgl2' })
  await src.loadVolumes([{ url: hippo }])
  src.thumbnailUrl = THUMBNAIL
  const bytes = src.serializeDocument()

  const nv = new NiiVue({ backend: 'webgl2', thumbnail: THUMBNAIL })
  // attachToCanvas shows the `thumbnail` option; there is no canvas here.
  nv.isThumbnailVisible = true
  await nv.loadVolumes([{ url: devImageUrl('volumes/sphere.nii.gz') }])
  expect(nv.volumes).toHaveLength(0) // deferred
  await nv.loadDocument(documentFile(bytes, 'doc.nvd'))
  expect(nv.isThumbnailVisible).toBe(true)

  // Dismissing the thumbnail starts any deferred load synchronously; a stale
  // one would replace the document volume with the sphere. Await whatever it
  // started rather than sleeping.
  const loads = spyOn(nv, 'loadVolumes')
  const meshLoads = spyOn(nv, 'loadMeshes')
  nv.isThumbnailVisible = false
  await Promise.all(loads.mock.results.map((r) => r.value))
  await nv.whenUpdatesSettle()

  expect(loads).not.toHaveBeenCalled()
  expect(meshLoads).not.toHaveBeenCalled()
  expect(nv.volumes.map((v) => v.url)).toEqual([hippo])
})
