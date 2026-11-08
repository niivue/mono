import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import { getNiivueCommandsModule, voiRange } from './commands'
import {
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { NIIVUE_STANDARD_COMMANDS } from './standardCommands'

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
    expect(calls[1]?.opts).toEqual({ orientation: 'sagittal', presetIndex: 1 })
    expect(nv.sliceType).toBe(SLICE_TYPE.MULTIPLANAR)
    expect(nv.pan2Dxyzmm).toEqual([5, 6, 7, 2])
    expect(nv.azimuth).toBe(42)
    expect(nv.volumeUpdates).toEqual([])
  })

  it('pass the merged scale direction through', () => {
    register('nv-1')
    const { calls, run } = fakeHost('cs-1')
    run('scaleDownViewport', {})
    expect(calls[1]?.opts).toEqual({ direction: -1 })
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
