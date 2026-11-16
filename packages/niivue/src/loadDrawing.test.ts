import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { createNiftiArray } from '@/volume/utils'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// Same 3x2x2 grid, x reversed: voxel i sits where the background's 2 - i does.
const FLIP_X = [-1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const nii = (affine: number[], img: Uint8Array, name = 'd.nii') =>
  new File([createNiftiArray([3, 2, 2], [1, 1, 1], affine, 2, img)], name)
const firstVoxel = () => Uint8Array.from({ length: 12 }, (_, i) => +(i === 0))

async function viewer(): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: nii(IDENTITY, new Uint8Array(12), 'b.nii') }])
  return nv
}

test('equalDimsFlippedAffine_remapsByPosition', async () => {
  const nv = await viewer()
  expect(await nv.loadDrawing(nii(FLIP_X, firstVoxel()))).toBe(true)
  expect(Array.from(nv.drawingVolume?.img as Uint8Array).indexOf(1)).toBe(2)
})

test('equalDimsNoSpatialTransform_keepsIndexCopy', async () => {
  const nv = await viewer()
  // A raw label array: qform and sform codes 0, so its affine is meaningless.
  const raw = new Uint8Array(
    createNiftiArray([3, 2, 2], [1, 1, 1], FLIP_X, 2, firstVoxel()),
  )
  new DataView(raw.buffer).setInt16(254, 0, true) // sform_code
  expect(await nv.loadDrawing(new File([raw], 'raw.nii'))).toBe(true)
  expect(Array.from(nv.drawingVolume?.img as Uint8Array).indexOf(1)).toBe(0)
})

test('halfVoxelShiftOnEqualDims_refused', async () => {
  const nv = await viewer()
  const shifted = [...IDENTITY]
  shifted[3] = 0.5
  expect(await nv.loadDrawing(nii(shifted, firstVoxel()))).toBe(false)
  expect(nv.drawingVolume).toBeNull()
})

test('closeWhileFileIsRead_pendingLoadInstallsNothing', async () => {
  const nv = await viewer()
  let release = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  class SlowFile extends File {
    override async arrayBuffer() {
      await gate
      return super.arrayBuffer()
    }
  }
  const bytes = createNiftiArray(
    [3, 2, 2],
    [1, 1, 1],
    IDENTITY,
    2,
    firstVoxel(),
  )
  const pending = nv.loadDrawing(new SlowFile([bytes], 'slow.nii'))
  nv.closeDrawing() // the pane moved on
  release()
  expect(await pending).toBe(false)
  expect(nv.drawingVolume).toBeNull()
  expect(nv.drawIsEnabled).toBe(false)
})
