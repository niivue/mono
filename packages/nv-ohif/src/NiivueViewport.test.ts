import { expect, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  centerCrosshair,
  cornerstoneWindowingStep,
  dicomWindow,
  initialRenderView,
  initialSliceType,
  readBaseWindowLevel,
} from './commands'
import { DEFAULT_OPTIONS, hangingKeys } from './NiivueViewport'
import { buildSliceFrames, frameAt } from './sliceFrames'
import { acquisitionSliceType } from './standardCommands'
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
  expect(acquisitionSliceType({ volumes: [] })).toBeUndefined()
})

test("a linked pane's window readout follows its peer's window", async () => {
  // Core sync writes the target's calMin/calMax and emits only locationChange,
  // which the viewport routes to its W/L readout.
  const frames: FrameRequestCallback[] = []
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (cb) => frames.push(cb)
  const [a, b] = [new NiiVue(DEFAULT_OPTIONS), new NiiVue(DEFAULT_OPTIONS)]
  for (const nv of [a, b])
    await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  let shown: ReturnType<typeof readBaseWindowLevel>
  b.addEventListener('locationChange', () => {
    shown = readBaseWindowLevel(b)
  })
  const voi = [{ type: 'voi', id: 'linked-test' }] // apart from other files' panes
  const leaveA = joinSyncGroups('linked-a', a, voi)
  const leaveB = joinSyncGroups('linked-b', b, voi)
  await a.setVolume(0, { calMin: 10, calMax: 30 })
  a.drawScene() // headless: no view, so no GL update draws
  while (frames.length) frames.shift()?.(0)
  expect(shown).toEqual({ window: 20, level: 20 })
  leaveA()
  leaveB()
  globalThis.requestAnimationFrame = raf
})

test('a new hanging protocol changes the effect keys; a fresh equal one does not', () => {
  const mpr = () =>
    hangingKeys(
      {
        orientation: 'axial',
        viewportType: 'volume',
        syncGroups: [{ type: 'voi', id: 'a' }],
      },
      [{ options: { voi: { windowWidth: 400, windowCenter: 40 } } }],
    )
  const render = hangingKeys(
    { orientation: 'coronal', viewportType: 'volume3d' },
    [{ options: { displayPreset: { CT: 'CT-Bone' } } }],
  )
  // OHIF re-renders with new objects: same values, same keys (no reload).
  expect(mpr()).toEqual(mpr())
  expect(render.view).not.toBe(mpr().view)
  expect(render.load).not.toBe(mpr().load)
  // Window alone: reload, view kept.
  const lung = hangingKeys(
    {
      orientation: 'axial',
      viewportType: 'volume',
      syncGroups: [{ type: 'voi', id: 'a' }],
    },
    [{ options: { voi: { windowWidth: 1500, windowCenter: -600 } } }],
  )
  expect(lung.view).toBe(mpr().view)
  expect(lung.load).not.toBe(mpr().load)
})
