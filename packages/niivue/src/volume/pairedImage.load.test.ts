import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { serveDevImages } from '@/testing/headless'

// A `.HEAD` URL given without `urlImageData` is paired with the `.BRIK` or
// `.BRIK.gz` beside it in `NVModel.prepareVolume`. The URL derivation and the
// probe order are unit-tested in pairedImage.test.ts against a fake fetch;
// this holds the wiring through the real controller and AFNI reader, over
// HTTP so a missing `.BRIK` is a real 404. The dev images ship only
// `DT_*+orig.BRIK.gz`, so every inferred load here takes the `.gz` fallback.

const server = serveDevImages()

/** The paths requested while `run` runs. */
async function requestsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const start = server.requests.length
  await run()
  return server.requests.slice(start)
}

test('a .HEAD URL alone loads with the .BRIK.gz beside it', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const requested = await requestsDuring(() =>
    nv.loadVolumes([{ url: server.url('/volumes/afni/DT_FA+orig.HEAD') }]),
  )
  const v = nv.volumes[0]
  expect(v._urlImageData).toBe(server.url('/volumes/afni/DT_FA+orig.BRIK.gz'))
  expect(Array.from(v.hdr.dims.slice(1, 4)).every((d) => d > 1)).toBe(true)
  // The uncompressed .BRIK was probed first and found missing.
  expect(requested).toContain('/volumes/afni/DT_FA+orig.BRIK')
})

test('an explicit urlImageData is used as given, without a probe', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const data = server.url('/volumes/afni/DT_FA+orig.BRIK.gz')
  const requested = await requestsDuring(() =>
    nv.loadVolumes([
      { url: server.url('/volumes/afni/DT_FA+orig.HEAD'), urlImageData: data },
    ]),
  )
  expect(nv.volumes[0]._urlImageData).toBe(data)
  expect(requested).not.toContain('/volumes/afni/DT_FA+orig.BRIK')
})

test('a deferred 4D reload reuses the inferred data URL', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([
    { url: server.url('/volumes/afni/DT_V1+orig.HEAD'), limitFrames4D: 1 },
  ])
  const before = nv.volumes[0].nFrame4D
  await nv.loadDeferred4DVolumes(nv.volumes[0].id ?? '')
  expect({ before, after: nv.volumes[0].nFrame4D }).toEqual({
    before: 1,
    after: 3,
  })
})

test('a non-AFNI load makes no pairing requests', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const requested = await requestsDuring(() =>
    nv.loadVolumes([{ url: server.url('/volumes/hippo.nii.gz') }]),
  )
  expect(requested).toEqual(['/volumes/hippo.nii.gz'])
})
