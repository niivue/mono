import { expect, jest, test } from 'bun:test'
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  centerCrosshair,
  cornerstoneWindowingStep,
  dicomWindow,
  initialRenderView,
  readBaseWindowLevel,
} from './commands'
import {
  applyHangingDisplay,
  baseKey,
  briefNote,
  DEFAULT_OPTIONS,
  hangingKeys,
  type Status,
  settleBase,
} from './NiivueViewport'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
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

test("a linked pane's window readout follows its peer's window", async () => {
  // The VOI group copies the window onto the peer's volume showing the same
  // display set (viewportSync.ts); its volumeUpdated drives the W/L readout.
  globalThis.requestAnimationFrame ??= () => 0
  const [a, b] = [new NiiVue(DEFAULT_OPTIONS), new NiiVue(DEFAULT_OPTIONS)]
  for (const nv of [a, b])
    await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  let shown: ReturnType<typeof readBaseWindowLevel>
  b.addEventListener('volumeUpdated', (e) => {
    if (e.detail.volumeIndex === 0) shown = readBaseWindowLevel(b)
  })
  const voi = [{ type: 'voi', id: 'linked-test' }] // apart from other files' panes
  const leave = (['linked-a', 'linked-b'] as const).map((id, i) => {
    registerNiivue(id, i ? b : a)
    updateNiivueViewport(id, {
      displaySets: [{ displaySetInstanceUID: 'linked-ds' }],
    })
    return joinSyncGroups(id, i ? b : a, voi)
  })
  try {
    await a.setVolume(0, { calMin: 10, calMax: 30 })
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual({ window: 20, level: 20 })
  } finally {
    for (const l of leave) l()
    unregisterNiivue('linked-a')
    unregisterNiivue('linked-b')
  }
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
  // Window alone: applied in place, no reload (it would clear measurements).
  const lung = hangingKeys(
    {
      orientation: 'axial',
      viewportType: 'volume',
      syncGroups: [{ type: 'voi', id: 'a' }],
    },
    [{ options: { voi: { windowWidth: 1500, windowCenter: -600 } } }],
  )
  expect(lung.view).toBe(mpr().view)
  expect(lung.load).toBe(mpr().load)
  expect(lung.display).not.toBe(mpr().display)
  // MIP on and off reruns the view and style effects.
  const mip = (blendMode: string) =>
    hangingKeys({ viewportType: 'volume3d' }, [
      { options: { blendMode, slabThickness: 'fullVolume' } },
    ]).view
  expect(mip('MIP')).not.toBe(mip('COMPOSITE'))
})

test("a new hanging protocol's window applies to the loaded base in place", async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const nv = new NiiVue(DEFAULT_OPTIONS)
  await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  registerNiivue('hp', nv)
  const entry = getNiivueEntry('hp')
  if (!entry) throw new Error('not registered')
  entry.displaySets = [{ displaySetInstanceUID: 'ds' }]
  const volume = nv.volumes[0]
  // The protocol's colormap (a TMTV PT pane's) stays under the new window.
  const voi = (windowWidth: number) => [
    {
      options: {
        voi: { windowWidth, windowCenter: 40 },
        colormap: { name: 'hot' },
      },
    },
  ]
  try {
    entry.baseLoading = true
    applyHangingDisplay(entry, { viewportType: 'volume' }, voi(400))
    expect(nv.volumes[0]?.calMax).not.toBe(240)
    entry.baseLoading = false
    applyHangingDisplay(entry, { viewportType: 'volume' }, voi(500))
    await Promise.resolve()
    expect(nv.volumes[0]).toBe(volume)
    expect([nv.volumes[0]?.calMin, nv.volumes[0]?.calMax]).toEqual([-210, 290])
    expect(nv.volumes[0]?.colormap).toBe('Hot')
  } finally {
    unregisterNiivue('hp')
  }
})

test('a protocol window changed during the load applies when it settles', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const nv = new NiiVue(DEFAULT_OPTIONS)
  const voi = (windowWidth: number) => [
    { options: { voi: { windowWidth, windowCenter: 40 } } },
  ]
  await nv.loadVolumes([
    { url: new File([fourSlices()], 'four.nii'), calMin: -160, calMax: 240 },
  ])
  registerNiivue('hp', nv)
  const entry = getNiivueEntry('hp')
  if (!entry) throw new Error('not registered')
  entry.displaySets = [{ displaySetInstanceUID: 'ds' }]
  try {
    entry.baseLoading = true
    applyHangingDisplay(entry, { viewportType: 'volume' }, voi(500))
    entry.baseLoading = false
    settleBase('hp', { calMin: -160, calMax: 240 }, {}, voi(500))
    await Promise.resolve()
    expect([nv.volumes[0]?.calMin, nv.volumes[0]?.calMax]).toEqual([-210, 290])
  } finally {
    unregisterNiivue('hp')
  }
})

test('removing the protocol window restores the robust range and gray', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const nv = new NiiVue(DEFAULT_OPTIONS)
  await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  const robust = [nv.volumes[0]?.calMin, nv.volumes[0]?.calMax]
  registerNiivue('hp', nv)
  const entry = getNiivueEntry('hp')
  if (!entry) throw new Error('not registered')
  entry.displaySets = [{ displaySetInstanceUID: 'ds' }]
  try {
    await nv.setVolume(0, { colormap: 'ct_bones' })
    applyHangingDisplay(entry, { viewportType: 'volume' }, undefined)
    await Promise.resolve()
    expect(nv.volumes[0]?.colormap).toBe('gray')
    expect([nv.volumes[0]?.calMin, nv.volumes[0]?.calMax]).toEqual(robust)
  } finally {
    unregisterNiivue('hp')
  }
})

test('a 2D -> 3D protocol on the same series starts a new base (the SEG reloads on it)', () => {
  const dso = [{ options: {} }]
  const twoD = baseKey('ds', true, hangingKeys({ viewportType: 'volume' }, dso))
  const threeD = baseKey(
    'ds',
    true,
    hangingKeys({ viewportType: 'volume3d' }, dso),
  )
  expect(threeD).not.toBe(twoD)
  expect(
    baseKey('ds', true, hangingKeys({ viewportType: 'volume' }, dso)),
  ).toBe(twoD)
})

test('removing a render preset keeps the DICOM window and restores gray', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const nv = new NiiVue(DEFAULT_OPTIONS)
  await nv.loadVolumes([{ url: new File([fourSlices()], 'four.nii') }])
  registerNiivue('hp', nv)
  const entry = getNiivueEntry('hp')
  if (!entry) throw new Error('not registered')
  entry.displaySets = [
    {
      displaySetInstanceUID: 'ds',
      Modality: 'CT',
      instances: [{ WindowWidth: 400, WindowCenter: 40 }],
    },
  ]
  const render = { viewportType: 'volume3d' }
  try {
    applyHangingDisplay(entry, render, [
      { options: { displayPreset: { CT: 'CT-Bone' } } },
    ])
    await Promise.resolve()
    expect(nv.volumes[0]?.colormap).toBe('ct_bones')
    applyHangingDisplay(entry, render, [{ options: {} }])
    await Promise.resolve()
    expect(nv.volumes[0]?.colormap).toBe('gray')
    expect([nv.volumes[0]?.calMin, nv.volumes[0]?.calMax]).toEqual([-160, 240])
  } finally {
    unregisterNiivue('hp')
  }
})

test('a brief note clears after 6 s, unless a newer status replaced it', () => {
  jest.useFakeTimers()
  try {
    let status = { kind: 'idle' } as Status
    const setStatus: Parameters<typeof briefNote>[0] = (next) => {
      status = typeof next === 'function' ? next(status) : next
    }
    briefNote(setStatus, 'incomplete SEG')
    jest.advanceTimersByTime(5999)
    expect(status).toEqual({ kind: 'note', message: 'incomplete SEG' })
    jest.advanceTimersByTime(1)
    expect(status).toEqual({ kind: 'idle' })
    briefNote(setStatus, 'old')
    status = { kind: 'error', message: 'newer' }
    jest.advanceTimersByTime(6000)
    expect(status).toEqual({ kind: 'error', message: 'newer' })
  } finally {
    jest.useRealTimers()
  }
})
