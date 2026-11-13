import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { niftiBytes } from '@/testing/headless'

// `limitFrames4D` must bound DECODING, not only retention (see
// notes/agents/formats-and-volumes.md, "Both load paths must FORWARD the limit"). The gzip stream is truncated
// after frame 0: a bounded read succeeds, a full decode cannot reach the end
// of the member, so the outcome says how much was decoded. Under Bun the load
// takes the main-thread path (loadBridge's fallback); the worker path is
// pinned by e2e/partial-decode-4d.spec.ts.

const [NX, NY, NZ, FRAMES] = [16, 16, 8, 400]
const FRAME = NX * NY * NZ

async function truncated4D(): Promise<File> {
  // Frame 0 carries a marker so we can prove which frame survived.
  const raw = niftiBytes({
    dims: [NX, NY, NZ, FRAMES],
    datatype: 'uint16',
    pixDims: [2, 2, 2],
    voxel: (i) => (i < FRAME ? 1234 : 0),
  })
  const gz = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer(),
  )
  // Keep the header and frame 0, then cut mid-member.
  return new File([gz.slice(0, Math.floor(gz.length * 0.6))], 'trunc4d.nii.gz')
}

test('a 4D request decodes only the frames it asked for', async () => {
  const file = await truncated4D()
  const nv = new NiiVue({ backend: 'webgl2' })

  // Control: without a limit these bytes cannot be decoded at all. If this
  // ever stops throwing, the truncation is not biting and the assertions
  // below would be vacuous.
  let unboundedThrew = false
  try {
    await nv.loadVolumes([{ url: file, name: 'trunc4d.nii.gz' }])
  } catch {
    unboundedThrew = true
  }
  expect(unboundedThrew).toBe(true)

  await nv.loadVolumes([
    { url: file, name: 'trunc4d.nii.gz', limitFrames4D: 1 },
  ])
  const vol = nv.volumes[0]
  expect(vol.img?.length).toBe(FRAME)
  expect(vol.img?.[0]).toBe(1234)
  // The header still describes the whole series; only the read was bounded.
  expect(vol.nTotalFrame4D).toBe(FRAMES)
  expect(vol.nFrame4D).toBe(1)
})
