import { expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  centerCrosshair,
  cornerstoneWindowingStep,
  dicomWindow,
  initialRenderView,
  initialSliceType,
  trackNiivueWindowLevel,
} from './commands'
import { DEFAULT_OPTIONS } from './NiivueViewport'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
} from './niivueRegistry'
import { buildSliceFrames, frameAt } from './sliceFrames'
import { joinSyncGroups } from './viewportSync'

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

test("a hanging protocol picks each viewport's slice type", () => {
  expect(
    initialSliceType({ viewportType: 'volume3d', orientation: 'coronal' }),
  ).toBe(SLICE_TYPE.RENDER)
  expect(
    initialSliceType({ viewportType: 'volume', orientation: 'sagittal' }),
  ).toBe(SLICE_TYPE.SAGITTAL)
  expect(initialSliceType({ orientation: 'acquisition' })).toBe(
    SLICE_TYPE.MULTIPLANAR,
  )
  expect(initialSliceType(undefined)).toBe(SLICE_TYPE.MULTIPLANAR)
})

test("the viewport opens in cornerstone's radiological convention", () => {
  expect(new NiiVue(DEFAULT_OPTIONS).isRadiological).toBe(true)
})

test("the series' DICOM window is the fallback initial window", () => {
  const ds = (inst: Record<string, unknown>) =>
    ({ instances: [inst] }) as unknown as Parameters<typeof dicomWindow>[0]
  const multi = dicomWindow(
    ds({ WindowWidth: [400, 1500], WindowCenter: [40, -600] }),
  )
  expect(multi && (multi.calMin + multi.calMax) / 2).toBeCloseTo(40, 0)
  expect(multi && multi.calMax - multi.calMin).toBeCloseTo(400, -1)
  expect(dicomWindow(ds({ WindowWidth: 0, WindowCenter: 40 }))).toBeUndefined()
  expect(dicomWindow(ds({}))).toBeUndefined()
  // A per-slice auto window (Siemens MR) is not a series window.
  const perSlice = {
    instances: [
      { WindowWidth: 95, WindowCenter: 35 },
      { WindowWidth: 386, WindowCenter: 172 },
      { WindowWidth: 300, WindowCenter: 150 },
    ],
  } as unknown as Parameters<typeof dicomWindow>[0]
  expect(dicomWindow(perSlice)).toBeUndefined()
  // One differing slice off the first/middle/last sample still disqualifies.
  const oneOff = {
    instances: [40, 80, 40, 40, 40].map((c) => ({
      WindowWidth: 400,
      WindowCenter: c,
    })),
  } as unknown as Parameters<typeof dicomWindow>[0]
  expect(dicomWindow(oneOff)).toBeUndefined()
  expect(dicomWindow(undefined)).toBeUndefined()
})

test("a 3D pane's hanging-protocol orientation sets the render camera", () => {
  expect(
    initialRenderView({ viewportType: 'volume3d', orientation: 'coronal' }),
  ).toEqual([180, 0])
  // Cornerstone's sagittal looks from patient left (viewPlaneNormal +x).
  expect(
    initialRenderView({ viewportType: 'volume3d', orientation: 'sagittal' }),
  ).toEqual([90, 0])
  expect(
    initialRenderView({ viewportType: 'volume', orientation: 'coronal' }),
  ).toBeUndefined()
  expect(initialRenderView({ viewportType: 'volume3d' })).toBeUndefined()
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
  expect(
    cornerstoneWindowingStep({
      globalMin: 0,
      globalMax: 0,
      robustMin: 0,
      robustMax: 0,
    }),
  ).toBeUndefined()
})

test("a linked pane's window baseline follows its peer's window", async () => {
  // Core sync writes the target's calMin/calMax and emits only locationChange,
  // which the viewport routes to trackNiivueWindowLevel.
  const frames: FrameRequestCallback[] = []
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (cb) => frames.push(cb)
  const [a, b] = [new NiiVue(DEFAULT_OPTIONS), new NiiVue(DEFAULT_OPTIONS)]
  for (const nv of [a, b])
    await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  registerNiivue('linked-b', b)
  trackNiivueWindowLevel('linked-b')
  b.addEventListener('locationChange', () => trackNiivueWindowLevel('linked-b'))
  const voi = [{ type: 'voi', id: 'linked-test' }] // apart from other files' panes
  const leaveA = joinSyncGroups('linked-a', a, voi)
  const leaveB = joinSyncGroups('linked-b', b, voi)
  await a.setVolume(0, { calMin: 10, calMax: 30 })
  a.drawScene() // headless: no view, so no GL update draws
  while (frames.length) frames.shift()?.(0)
  expect(getNiivueEntry('linked-b')?.windowLevel).toEqual({
    window: 20,
    level: 20,
  })
  leaveA()
  leaveB()
  unregisterNiivue('linked-b')
  globalThis.requestAnimationFrame = raf
})
