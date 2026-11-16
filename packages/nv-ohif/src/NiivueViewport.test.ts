import { expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  centerCrosshair,
  cornerstoneWindowingStep,
  dicomWindow,
} from './commands'
import { DEFAULT_OPTIONS } from './NiivueViewport'
import { buildSliceFrames, frameAt } from './sliceFrames'
import { acquisitionSliceType } from './standardCommands'

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

test("the series' DICOM window is the fallback initial window", () => {
  const ds = (inst: Record<string, unknown>) =>
    ({ instances: [inst] }) as unknown as Parameters<typeof dicomWindow>[0]
  const multi = dicomWindow(
    ds({ WindowWidth: [400, 1500], WindowCenter: [40, -600] }),
  )
  expect(multi && (multi.calMin + multi.calMax) / 2).toBeCloseTo(40, 0)
  expect(multi && multi.calMax - multi.calMin).toBeCloseTo(400, -1)
  // A per-slice auto window (Siemens MR) is not a series window.
  const perSlice = {
    instances: [
      { WindowWidth: 95, WindowCenter: 35 },
      { WindowWidth: 386, WindowCenter: 172 },
      { WindowWidth: 300, WindowCenter: 150 },
    ],
  } as unknown as Parameters<typeof dicomWindow>[0]
  expect(dicomWindow(perSlice)).toBeUndefined()
})

test("the windowing drag matches cornerstone's gain and direction", () => {
  // CT: 4096 HU dynamic range -> 4 HU per pixel; robust range 2000 HU.
  const step = cornerstoneWindowingStep({
    globalMin: -1024,
    globalMax: 3072,
    robustMin: -1000,
    robustMax: 1000,
  })
  expect(step?.[0]).toBeCloseTo(4 / 2000)
  expect(step?.[1]).toBeCloseTo(-4 / 2000)
})

test('the window comes from the instances the shown output was made of', () => {
  // Orthogonal localizers in one series: different windows, one per output.
  const ds = {
    instances: [
      { SOPInstanceUID: 'cor', WindowWidth: 230, WindowCenter: 100 },
      { SOPInstanceUID: 'sag', WindowWidth: 320, WindowCenter: 110 },
    ],
  } as unknown as Parameters<typeof dicomWindow>[0]
  expect(dicomWindow(ds)).toBeUndefined()
  const shown = {
    origin: [0, 0, 0],
    normal: [0, 1, 0],
    frames: [{ SOPInstanceUID: 'cor', frameNumber: 1 }],
  } as Parameters<typeof dicomWindow>[1]
  const win = dicomWindow(ds, shown)
  expect(win && (win.calMin + win.calMax) / 2).toBeCloseTo(100, 0)
})

test('a single image opens in its acquisition plane', () => {
  // permRAS: voxel dimension 3 runs along RAS axis 2 (anterior) -> coronal.
  expect(acquisitionSliceType({ volumes: [{ permRAS: [1, 3, -2] }] })).toBe(
    SLICE_TYPE.CORONAL,
  )
})
