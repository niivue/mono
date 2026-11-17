import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import { getNiivueCommandsModule, voiRange } from './commands'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import {
  jumpToImage,
  NIIVUE_STANDARD_COMMANDS,
  scrollImage,
} from './standardCommands'

function stubNiivue() {
  const volumeUpdates: Array<Record<string, unknown>> = []
  return {
    sliceType: SLICE_TYPE.MULTIPLANAR as number,
    azimuth: 42,
    elevation: -7,
    scaleMultiplier: 1,
    pan2Dxyzmm: [5, 6, 7, 2],
    renderPan: [1, 2],
    crosshairPos: [0.1, 0.2, 0.3],
    volumes: [{ calMin: 0, calMax: 100, permRAS: [1, -3, 2] }] as Array<
      Record<string, unknown>
    >,
    volumeUpdates,
    async setVolume(_index: number, opts: Record<string, unknown>) {
      volumeUpdates.push(opts)
    },
    // Core's 2D turn (NVControlBase): the setter rounds to a quarter turn in
    // 0..270, and rotate2D steps the other way with exactly one flip.
    turn: 0,
    get rotation2D() {
      return this.turn
    },
    set rotation2D(v: number) {
      this.turn = (((Math.round(v / 90) * 90) % 360) + 360) % 360
    },
    isFlipped2DHorizontal: false,
    isFlipped2DVertical: false,
    rotate2D(quarterTurns: number) {
      const step =
        this.isFlipped2DHorizontal !== this.isFlipped2DVertical ? -90 : 90
      this.rotation2D = this.rotation2D + step * quarterTurns
    },
    flip2D(axis: 'horizontal' | 'vertical') {
      if (axis === 'horizontal')
        this.isFlipped2DHorizontal = !this.isFlipped2DHorizontal
      else this.isFlipped2DVertical = !this.isFlipped2DVertical
    },
  }
}

type Definition = {
  commandFn: (opts: Record<string, unknown>) => unknown
  options?: Record<string, unknown>
}

// OHIF's CommandsManager: newer contexts first, an explicit context only,
// definition options under call-time options.
function fakeHost(activeViewportId: string) {
  const calls: Array<{
    name: string
    opts: Record<string, unknown>
    context?: string
  }> = []
  const contexts: Record<string, Record<string, Definition>> = {
    CORNERSTONE: Object.fromEntries(
      NIIVUE_STANDARD_COMMANDS.map((name) => [
        name,
        { commandFn: () => `cornerstone:${name}` },
      ]),
    ),
  }
  const commandsManager = {
    runCommand(
      name: string,
      opts: Record<string, unknown> = {},
      context?: string,
    ) {
      const order = context ? [context] : ['NIIVUE', 'CORNERSTONE']
      const def = order.map((c) => contexts[c]?.[name]).find(Boolean)
      // Record what the resolved commandFn receives.
      const params = { ...def?.options, ...opts }
      calls.push({ name, opts: params, context })
      return def?.commandFn(params)
    },
  }
  const servicesManager = {
    services: {
      viewportGridService: { getActiveViewportId: () => activeViewportId },
      customizationService: { getCustomization: () => undefined },
    },
  }
  const { definitions } = getNiivueCommandsModule({
    servicesManager,
    commandsManager,
  })
  contexts.NIIVUE = definitions as unknown as Record<string, Definition>
  return { calls, contexts, run: commandsManager.runCommand }
}

const registered: string[] = []
function register(viewportId: string, nv = stubNiivue()) {
  registerNiivue(viewportId, nv as unknown as NiiVue)
  registered.push(viewportId)
  return nv
}
afterEach(() => {
  for (const id of registered.splice(0)) unregisterNiivue(id)
})

describe('standard commands', () => {
  it('delegate to CORNERSTONE with identical options when NiiVue is not active', () => {
    const nv = register('nv-1')
    const { calls, run } = fakeHost('cs-1')
    for (const name of NIIVUE_STANDARD_COMMANDS) {
      calls.length = 0
      const opts = { orientation: 'sagittal', presetIndex: 1 }
      expect(run(name, opts)).toBe(`cornerstone:${name}`)
      expect(calls).toHaveLength(2) // the hotkey, then one delegation
      expect(calls[1]?.context).toBe('CORNERSTONE')
      expect(calls[1]?.name).toBe(name)
      expect(calls[1]?.opts).toEqual(calls[0]?.opts as Record<string, unknown>)
    }
    // A command without default options passes the call-time options unchanged.
    calls.length = 0
    run('resetViewport', { orientation: 'sagittal', presetIndex: 1 })
    expect(calls[1]?.opts).toEqual({ orientation: 'sagittal', presetIndex: 1 })
    expect(nv.sliceType).toBe(SLICE_TYPE.MULTIPLANAR)
    expect(nv.pan2Dxyzmm).toEqual([5, 6, 7, 2])
    expect(nv.azimuth).toBe(42)
    expect(nv.volumeUpdates).toEqual([])
  })

  it('do not recurse when CORNERSTONE lacks the command', () => {
    const { calls, contexts, run } = fakeHost('cs-1')
    delete contexts.CORNERSTONE?.resetViewport
    expect(run('resetViewport')).toBeUndefined()
    expect(calls.map((c) => c.context)).toEqual([undefined, 'CORNERSTONE'])
  })

  it('honour an explicit viewportId over the active viewport', () => {
    const nv = register('nv-1')
    const { calls, run } = fakeHost('cs-1')
    run('setViewportOrientation', { viewportId: 'nv-1', orientation: 'axial' })
    expect(nv.sliceType).toBe(SLICE_TYPE.AXIAL)
    expect(calls).toHaveLength(1)
    // And the reverse: an explicit Cornerstone id with NiiVue active.
    run('resetViewport', { viewportId: 'cs-2' })
    expect(calls[2]?.context).toBe('CORNERSTONE')
  })

  it('scale and fit the 2D zoom like Cornerstone (x1/0.9, x1/1.1, reset)', () => {
    const nv = register('nv-1')
    const { run } = fakeHost('nv-1')
    run('scaleUpViewport')
    expect(nv.pan2Dxyzmm[3]).toBeCloseTo(2 / 0.9)
    run('scaleDownViewport')
    expect(nv.pan2Dxyzmm[3]).toBeCloseTo(2 / 0.9 / 1.1)
    expect(nv.pan2Dxyzmm.slice(0, 3)).toEqual([5, 6, 7])
    run('fitViewportToWindow')
    expect(nv.pan2Dxyzmm).toEqual([0, 0, 0, 1])
    expect(nv.azimuth).toBe(42) // fit is not a reset
  })

  it('scale the render view and clamp it', () => {
    const nv = register('nv-1')
    nv.sliceType = SLICE_TYPE.RENDER
    const { run } = fakeHost('nv-1')
    for (let i = 0; i < 20; i++) run('scaleUpViewport')
    expect(nv.scaleMultiplier).toBe(2)
    run('fitViewportToWindow')
    expect(nv.scaleMultiplier).toBe(1)
    expect(nv.renderPan).toEqual([0, 0])
    expect(nv.pan2Dxyzmm).toEqual([5, 6, 7, 2])
  })

  it('zoom and fit a slide through its view', () => {
    register('nv-1')
    const seen: Array<number | 'fit'> = []
    updateNiivueViewport('nv-1', {
      slideView: {
        setTool() {},
        tool: undefined,
        annotations: undefined,
        focusAnnotation() {},
        resetView() {},
        zoom: (f) => seen.push(f),
        fit: () => seen.push('fit'),
        setWindow() {},
        async saveBitmap() {},
        dispose() {},
      },
    })
    const { run } = fakeHost('nv-1')
    run('scaleUpViewport')
    run('scaleDownViewport')
    run('fitViewportToWindow')
    expect(seen).toEqual([1 / 0.9, 1 / 1.1, 'fit'])
  })

  it('set orientation, acquisition from the volume axes', () => {
    const nv = register('nv-1')
    const { run } = fakeHost('nv-1')
    run('setViewportOrientation', { orientation: 'sagittal' })
    expect(nv.sliceType).toBe(SLICE_TYPE.SAGITTAL)
    // permRAS [1, -3, 2]: voxel dim 3 runs anterior-posterior.
    run('setViewportOrientation', { orientation: 'acquisition' })
    expect(nv.sliceType).toBe(SLICE_TYPE.CORONAL)
    run('setViewportOrientation', { orientation: 'reformat' })
    expect(nv.sliceType).toBe(SLICE_TYPE.CORONAL)
  })

  it('reset the view and apply a preset by index', () => {
    const nv = register('nv-1')
    updateNiivueViewport('nv-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'CT' }],
    })
    const { run } = fakeHost('nv-1')
    run('resetViewport')
    expect(nv.azimuth).toBe(110)
    expect(nv.pan2Dxyzmm).toEqual([0, 0, 0, 1])
    run('setWindowLevelPreset', { presetIndex: 1 }) // CT lung: W1500 L-600
    expect(nv.volumeUpdates).toEqual([{ calMin: -1350, calMax: 150 }])
  })
})

describe('rotate and flip commands', () => {
  it('turn clockwise and counterclockwise on screen, with or without a flip', () => {
    const nv = register('nv-1')
    const { run } = fakeHost('nv-1')
    run('rotateViewportCW')
    expect(nv.rotation2D).toBe(90)
    run('rotateViewportCCW')
    run('rotateViewportCCW')
    expect(nv.rotation2D).toBe(270)
    // One flip: the stored turn runs the other way, the screen turn does not.
    run('flipViewportHorizontal')
    run('rotateViewportCW')
    expect(nv.rotation2D).toBe(180)
  })

  it('set an absolute turn as seen, inverting it under one flip (Cornerstone set mode)', () => {
    const nv = register('nv-1')
    const { run } = fakeHost('nv-1')
    run('rotateViewportCWSet')
    expect(nv.rotation2D).toBe(90)
    run('setViewportVerticalFlip')
    run('rotateViewportCWSet', { rotation: 90 })
    expect(nv.rotation2D).toBe(270) // -90, normalised
    run('setViewportHorizontalFlip') // two flips: parity restored
    run('rotateViewportCWSet', { rotation: 180 })
    expect(nv.rotation2D).toBe(180)
  })

  it('toggle flips, and set them to an explicit value', () => {
    const nv = register('nv-1')
    const { run } = fakeHost('nv-1')
    run('flipViewportHorizontal')
    run('flipViewportVertical')
    expect([nv.isFlipped2DHorizontal, nv.isFlipped2DVertical]).toEqual([
      true,
      true,
    ])
    run('flipViewportVertical')
    expect(nv.isFlipped2DVertical).toBe(false)
    run('setViewportHorizontalFlip', { flipped: false })
    run('setViewportVerticalFlip')
    expect([nv.isFlipped2DHorizontal, nv.isFlipped2DVertical]).toEqual([
      false,
      true,
    ])
  })

  for (const reset of ['resetViewport', 'niivueResetView'])
    it(`clear the turn and flips on ${reset} (OHIF's and NiiVue's reset)`, () => {
      const nv = register('nv-1')
      const { run } = fakeHost('nv-1')
      run('rotateViewportCW')
      run('flipViewportHorizontal')
      run('setViewportVerticalFlip')
      run(reset)
      expect([
        nv.rotation2D,
        nv.isFlipped2DHorizontal,
        nv.isFlipped2DVertical,
      ]).toEqual([0, false, false])
    })

  it('leave a render-only view alone (the turn applies to 2D tiles only)', () => {
    const nv = register('nv-1')
    nv.sliceType = SLICE_TYPE.RENDER
    const { run } = fakeHost('nv-1')
    for (const name of [
      'rotateViewportCW',
      'flipViewportHorizontal',
      'setViewportVerticalFlip',
    ])
      run(name)
    expect([
      nv.rotation2D,
      nv.isFlipped2DHorizontal,
      nv.isFlipped2DVertical,
    ]).toEqual([0, false, false])
  })

  it('leave a slide (WSI) viewport alone', () => {
    const nv = register('nv-1')
    let resets = 0
    updateNiivueViewport('nv-1', {
      slideView: {
        setTool() {},
        tool: undefined,
        annotations: undefined,
        focusAnnotation() {},
        resetView: () => resets++,
        zoom() {},
        fit() {},
        setWindow() {},
        async saveBitmap() {},
        dispose() {},
      },
    })
    const { run } = fakeHost('nv-1')
    for (const name of [
      'rotateViewportCW',
      'rotateViewportCWSet',
      'flipViewportHorizontal',
      'setViewportVerticalFlip',
    ])
      run(name)
    run('resetViewport')
    expect([
      nv.rotation2D,
      nv.isFlipped2DHorizontal,
      nv.isFlipped2DVertical,
    ]).toEqual([0, false, false])
    expect(resets).toBe(1)
  })
})

describe('voiRange', () => {
  it('reads the hanging protocol voi of the first display set', () => {
    expect(
      voiRange([{ options: { voi: { windowWidth: 400, windowCenter: 40 } } }]),
    ).toEqual({ calMin: -160, calMax: 240 })
    // Cornerstone also accepts the options inline (item.options || item).
    expect(voiRange([{ voi: { windowWidth: 400, windowCenter: 40 } }])).toEqual(
      { calMin: -160, calMax: 240 },
    )
    expect(voiRange(undefined)).toBeUndefined()
    expect(voiRange([{ options: {} }])).toBeUndefined()
    expect(
      voiRange([{ options: { voi: { windowWidth: 0, windowCenter: 40 } } }]),
    ).toBeUndefined()
  })
})

it('jumpToImage and scrollImage move through the slice -> frame map', () => {
  const calls: number[][] = []
  const entry = {
    nv: {
      setCrosshairPos: (p: number[]) => calls.push(p),
      sliceType: 0,
      volumes: [{ permRAS: [1, 2, 3] }],
    },
    crosshairMM: [5, 6, 1],
    // Display-set order runs head-first; the converted volume runs foot-first.
    displaySets: [
      {
        instances: [
          { SOPInstanceUID: 'top' },
          { SOPInstanceUID: 'mid' },
          { SOPInstanceUID: 'bot' },
        ],
      },
    ],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [
        { SOPInstanceUID: 'bot', frameNumber: 1 },
        { SOPInstanceUID: 'mid', frameNumber: 1 },
        { SOPInstanceUID: 'top', frameNumber: 1 },
        undefined,
      ],
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  jumpToImage(entry, -1)
  // Out of range: no SOP, so it must not land on the unmapped slot.
  jumpToImage(entry, 7)
  // From 'mid': next is 'bot' (display-set order), previous 'top'.
  scrollImage(entry, 1)
  scrollImage(entry, -1)
  // In-plane (x, y) kept; z on the chosen instance's slice.
  expect(calls).toEqual([
    [5, 6, 2],
    [5, 6, 0],
    [5, 6, 0],
    [5, 6, 2],
  ])
})

it('scrollImage steps a split series across its outputs', () => {
  // Output A is a lone localizer slice; B is another output.
  const switched: string[] = []
  const entry = {
    nv: {
      sliceType: 0,
      volumes: [{ permRAS: [1, 2, 3] }],
      moveCrosshairInVox: () => {},
    },
    crosshairMM: [0, 0, 0],
    displaySets: [
      { instances: [{ SOPInstanceUID: 'A' }, { SOPInstanceUID: 'B' }] },
    ],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [{ SOPInstanceUID: 'A', frameNumber: 1 }],
    },
    switchToInstance: (sop: string) => {
      switched.push(sop)
      return Promise.resolve(true)
    },
  } as unknown as Parameters<typeof scrollImage>[0]
  scrollImage(entry, 1)
  // Clamped, not wrapped to the last instance.
  scrollImage(entry, -1)
  expect(switched).toEqual(['B', 'A'])
})

it('jumpToImage counts the frames of a single multi-frame instance', () => {
  const calls: number[][] = []
  const entry = {
    nv: { setCrosshairPos: (p: number[]) => calls.push(p) },
    crosshairMM: [5, 6, 0],
    displaySets: [{ instances: [{ SOPInstanceUID: 'mf', NumberOfFrames: 3 }] }],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [1, 2, 3].map((frameNumber) => ({
        SOPInstanceUID: 'mf',
        frameNumber,
      })),
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 1)
  jumpToImage(entry, -1)
  jumpToImage(entry, 3)
  expect(calls).toEqual([
    [5, 6, 1],
    [5, 6, 2],
  ])
})

it('jumpToImage counts only the instances the shown output holds', () => {
  // Coronal + sagittal localizers in one series; the pane shows only sag.
  const calls: number[][] = []
  const entry = {
    nv: { setCrosshairPos: (p: number[]) => calls.push(p) },
    crosshairMM: [5, 6, 0],
    displaySets: [
      {
        instances: ['cor', 'sag'].map((SOPInstanceUID) => ({ SOPInstanceUID })),
      },
    ],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [{ SOPInstanceUID: 'sag', frameNumber: 1 }],
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  expect(calls).toEqual([[5, 6, 0]])
  // One image: index 1 is out of range.
  jumpToImage(entry, 1)
  expect(calls).toHaveLength(1)
})

it('jumpToImage counts the shown frames of a split multi-frame instance', () => {
  // A 4-frame instance whose shown output holds frames 2 and 4.
  const calls: number[][] = []
  const entry = {
    nv: { setCrosshairPos: (p: number[]) => calls.push(p) },
    crosshairMM: [5, 6, 1],
    displaySets: [{ instances: [{ SOPInstanceUID: 'mf', NumberOfFrames: 4 }] }],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [2, 4].map((frameNumber) => ({
        SOPInstanceUID: 'mf',
        frameNumber,
      })),
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  jumpToImage(entry, -1)
  jumpToImage(entry, 2)
  expect(calls).toEqual([
    [5, 6, 0],
    [5, 6, 1],
  ])
})

it('firstImage and lastImage jump to the ends of the shown stack', () => {
  const calls: number[][] = []
  const nv = Object.assign(stubNiivue(), {
    setCrosshairPos: (p: number[]) => calls.push(p),
  })
  register('nv-1', nv)
  updateNiivueViewport('nv-1', {
    crosshairMM: [5, 6, 1],
    displaySets: [
      {
        instances: ['a', 'b', 'c'].map((SOPInstanceUID) => ({
          SOPInstanceUID,
        })),
      },
    ],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: ['a', 'b', 'c'].map((SOPInstanceUID) => ({
        SOPInstanceUID,
        frameNumber: 1,
      })),
    },
  } as unknown as Parameters<typeof updateNiivueViewport>[1])
  const { run } = fakeHost('nv-1')
  run('firstImage')
  run('lastImage')
  expect(calls).toEqual([
    [5, 6, 0],
    [5, 6, 2],
  ])
})

it('jumpToImage on a volume viewport counts along the volume', () => {
  const calls: number[][] = []
  const entry = {
    nv: { setCrosshairPos: (p: number[]) => calls.push(p) },
    crosshairMM: [5, 6, 1],
    isVolumeViewport: true,
    displaySets: [
      {
        instances: ['top', 'mid', 'bot'].map((SOPInstanceUID) => ({
          SOPInstanceUID,
        })),
      },
    ],
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: ['bot', 'mid', 'top'].map((SOPInstanceUID) => ({
        SOPInstanceUID,
        frameNumber: 1,
      })),
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  jumpToImage(entry, -1)
  jumpToImage(entry, 3)
  expect(calls).toEqual([
    [5, 6, 0],
    [5, 6, 2],
  ])
})

it('jumpToImage on a non-DICOM volume steps the voxel slices of the view axis', () => {
  const calls: number[][] = []
  const nv = {
    setCrosshairPos: (p: number[]) => calls.push(p),
    // 2 mm voxels from (10, 20, 30).
    vox2mm: (v: number[]) => v.map((c, a) => 10 * (a + 1) + 2 * c),
    sliceType: SLICE_TYPE.AXIAL as number,
    volumes: [{ dimsRAS: [3, 3, 2, 4], permRAS: [3, 1, 2] }],
  }
  const entry = {
    nv,
    crosshairMM: [15, 22, 33],
    displaySets: [],
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  jumpToImage(entry, -1)
  jumpToImage(entry, 4)
  // Not a 2D view: the acquisition (permRAS 3) axis, here x.
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  jumpToImage(entry, 1)
  expect(calls).toEqual([
    [15, 22, 30],
    [15, 22, 36],
    [12, 22, 33],
  ])
})

it.each([
  true,
  false,
])('jumpToImage off the acquisition plane counts along the view axis (volume viewport %p)', (isVolumeViewport) => {
  const calls: number[][] = []
  const entry = {
    nv: {
      setCrosshairPos: (p: number[]) => calls.push(p),
      vox2mm: (v: number[]) => v,
      sliceType: SLICE_TYPE.SAGITTAL as number,
      volumes: [{ dimsRAS: [3, 3, 3, 3], permRAS: [1, 2, 3] }],
    },
    crosshairMM: [2, 1, 1],
    isVolumeViewport,
    displaySets: [{ instances: [{ SOPInstanceUID: 'a' }] }],
    // An axial slice map: it cannot step sagittal slices.
    sliceFrames: {
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      frames: [1, 2, 3].map((frameNumber) => ({
        SOPInstanceUID: 'a',
        frameNumber,
      })),
    },
  } as unknown as Parameters<typeof jumpToImage>[0]
  jumpToImage(entry, 0)
  expect(calls).toEqual([[0, 1, 1]])
})
