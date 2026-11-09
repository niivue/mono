import { expect, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { centerCrosshair } from './commands'
import { DEFAULT_OPTIONS } from './NiivueViewport'
import { buildSliceFrames, frameAt } from './sliceFrames'

test('the viewport snaps the crosshair to voxel centres', () => {
  // So a measurement drawn at a clicked depth lies on a DICOM frame (frameAt).
  expect(new NiiVue(DEFAULT_OPTIONS).isSnapToVoxelCenters).toBe(true)
})

// A 2x2x4 uint8 NIfTI-1: 1 mm pixels, 2.5 mm slices at z 30, 32.5, 35, 37.5.
function fourSlices(): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(352 + 16))
  view.setInt32(0, 348, true)
  ;[3, 2, 2, 4].forEach((d, i) => {
    view.setInt16(40 + 2 * i, d, true)
  })
  view.setInt16(70, 2, true) // uint8
  view.setInt16(72, 8, true)
  ;[1, 1, 1, 2.5].forEach((d, i) => {
    view.setFloat32(76 + 4 * i, d, true)
  })
  view.setFloat32(108, 352, true)
  view.setFloat32(112, 1, true) // scl_slope
  view.setInt16(254, 1, true) // sform_code
  const srow = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2.5, 30]
  srow.forEach((v, i) => {
    view.setFloat32(280 + 4 * i, v, true)
  })
  ;[0x6e, 0x2b, 0x31, 0].forEach((b, i) => {
    view.setUint8(344 + i, b)
  })
  return view.buffer
}

test('a loaded volume shows a slice centre, so its plane has a frame', async () => {
  // Headless: NiiVue schedules a redraw on each crosshair move.
  globalThis.requestAnimationFrame ??= () => 0
  const nifti = fourSlices()
  const nv = new NiiVue(DEFAULT_OPTIONS)
  await nv.loadVolumes([{ url: new File([nifti], 'four.nii') }])
  const instances = [0, 1, 2, 3].map((k) => ({
    SOPInstanceUID: `ax${k}`,
    ImagePositionPatient: [0, 0, 30 + 2.5 * k],
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
  }))
  const sf = buildSliceFrames(nifti, instances)
  if (!sf) throw new Error('no map')
  // The crosshair depth, as a measurement on the shown plane has it (RAS z = LPS z).
  const atCrosshair = () => frameAt(sf, [[0, 0, nv.getCrosshairPos()[2]]])
  // Loaded, the crosshair sits between slices 1 and 2.
  expect(atCrosshair()).toBeUndefined()
  centerCrosshair(nv)
  expect(atCrosshair()?.SOPInstanceUID).toMatch(/^ax[12]$/)
})
