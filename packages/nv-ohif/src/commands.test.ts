import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVueGPU from '@niivue/niivue'
import { SLICE_TYPE } from '@niivue/niivue'
import {
  findOverlayCandidate,
  getNiivueCommandsModule,
  NIIVUE_CLIP_PLANES,
  NIIVUE_SLICE_TYPES,
  OVERLAY_COLORMAP,
  OVERLAY_OPACITY,
} from './commands'
import {
  getNiivueEntryForViewport,
  getNiivueForViewport,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'

// A stub with the scene properties and volume APIs the commands touch.
function stubNiivue() {
  const volumes: unknown[] = []
  const added: Record<string, unknown>[] = []
  const clipPlanes: number[][] = []
  return {
    sliceType: SLICE_TYPE.MULTIPLANAR as number,
    azimuth: 42,
    elevation: -7,
    scaleMultiplier: 3,
    pan2Dxyzmm: [5, 6, 7, 2],
    renderPan: [1, 2],
    crosshairPos: [0.1, 0.2, 0.3],
    volumes,
    added,
    clipPlanes,
    setClipPlane(dae: number[]) {
      clipPlanes.push(dae)
    },
    async addVolume(spec: Record<string, unknown>) {
      added.push(spec)
      volumes.push(spec)
    },
    async updateGLVolume() {},
    model: {
      removeVolume(index: number) {
        volumes.splice(index, 1)
      },
    },
  }
}

function services(
  activeViewportId: string,
  displaySets: Record<string, unknown>[] = [],
) {
  return {
    services: {
      viewportGridService: { getActiveViewportId: () => activeViewportId },
      displaySetService: { getActiveDisplaySets: () => displaySets },
    },
  }
}

const registered: string[] = []
function register(viewportId: string, nv: ReturnType<typeof stubNiivue>) {
  registerNiivue(viewportId, nv as unknown as NiiVueGPU)
  registered.push(viewportId)
}

afterEach(() => {
  for (const id of registered.splice(0)) unregisterNiivue(id)
})

describe('NIIVUE_SLICE_TYPES', () => {
  it('maps every toolbar name to the matching SLICE_TYPE', () => {
    expect(NIIVUE_SLICE_TYPES).toEqual({
      axial: SLICE_TYPE.AXIAL,
      coronal: SLICE_TYPE.CORONAL,
      sagittal: SLICE_TYPE.SAGITTAL,
      multiplanar: SLICE_TYPE.MULTIPLANAR,
      render: SLICE_TYPE.RENDER,
    })
  })
})

describe('niivueRegistry', () => {
  it('resolves the exact viewport, and falls back to a sole instance', () => {
    const a = stubNiivue()
    register('vp-a', a)
    expect(getNiivueForViewport('vp-a')).toBe(a as unknown as NiiVueGPU)
    // A non-NiiVue viewport id still resolves while only one instance exists.
    expect(getNiivueForViewport('vp-other')).toBe(a as unknown as NiiVueGPU)

    const b = stubNiivue()
    register('vp-b', b)
    // With two instances the fallback is ambiguous: exact matches only.
    expect(getNiivueForViewport('vp-b')).toBe(b as unknown as NiiVueGPU)
    expect(getNiivueForViewport('vp-other')).toBeUndefined()
  })
})

describe('niivueSetSliceType', () => {
  it('sets the mapped slice type on the active viewport instance', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetSliceType({ sliceType: 'render' })
    expect(nv.sliceType).toBe(SLICE_TYPE.RENDER)
    definitions.niivueSetSliceType({ sliceType: 'axial' })
    expect(nv.sliceType).toBe(SLICE_TYPE.AXIAL)
  })

  it('ignores unknown slice types and missing instances', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetSliceType({ sliceType: 'mosaic' })
    definitions.niivueSetSliceType()
    expect(nv.sliceType).toBe(SLICE_TYPE.MULTIPLANAR)
    // No registered instance at all: must not throw.
    unregisterNiivue('vp-1')
    registered.length = 0
    expect(() =>
      definitions.niivueSetSliceType({ sliceType: 'axial' }),
    ).not.toThrow()
  })
})

describe('niivueResetView', () => {
  it('restores camera, zoom, pan, and crosshair defaults', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueResetView()
    expect(nv.azimuth).toBe(110)
    expect(nv.elevation).toBe(10)
    expect(nv.scaleMultiplier).toBe(1)
    expect(nv.pan2Dxyzmm).toEqual([0, 0, 0, 1])
    expect(nv.renderPan).toEqual([0, 0])
    expect(nv.crosshairPos).toEqual([0.5, 0.5, 0.5])
  })
})

describe('niivueSetClipPlane', () => {
  it('applies the preset and records it on the entry', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetClipPlane({ plane: 'right' })
    expect(nv.clipPlanes).toEqual([NIIVUE_CLIP_PLANES.right ?? []])
    expect(getNiivueEntryForViewport('vp-1')?.clipPlane).toBe('right')

    definitions.niivueSetClipPlane({ plane: 'none' })
    expect(nv.clipPlanes[1]?.[0]).toBeGreaterThan(1) // depth > 1 disables
    expect(getNiivueEntryForViewport('vp-1')?.clipPlane).toBe('none')
  })

  it('ignores unknown presets', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetClipPlane({ plane: 'diagonal' })
    definitions.niivueSetClipPlane()
    expect(nv.clipPlanes).toEqual([])
    expect(getNiivueEntryForViewport('vp-1')?.clipPlane).toBe('none')
  })
})

describe('findOverlayCandidate', () => {
  const base = { displaySetInstanceUID: 'ds-base' }
  it('picks the first loadable set that is not the base or an overlay', () => {
    const entry = { displaySets: [base], overlayUIDs: ['ds-loaded'] }
    const candidates = [
      base,
      { displaySetInstanceUID: 'ds-loaded', url: 'https://x/a.nii.gz' },
      { displaySetInstanceUID: 'ds-doc', Modality: 'SR' }, // unsupported
      { displaySetInstanceUID: 'ds-next', url: 'https://x/b.nii.gz' },
    ]
    expect(findOverlayCandidate(entry, candidates)?.displaySetInstanceUID).toBe(
      'ds-next',
    )
  })

  it('returns undefined when nothing else is loadable', () => {
    const entry = { displaySets: [base], overlayUIDs: [] }
    expect(findOverlayCandidate(entry, [base])).toBeUndefined()
  })
})

describe('niivueToggleOverlay', () => {
  it('loads the next series as a colormapped overlay (direct URL path)', async () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-base' }],
    })
    const sm = services('vp-1', [
      { displaySetInstanceUID: 'ds-base' },
      {
        displaySetInstanceUID: 'ds-2',
        url: 'https://x/perf.nii.gz',
        SeriesDescription: 'PERFUSION',
      },
    ])
    const { definitions } = getNiivueCommandsModule({ servicesManager: sm })
    await definitions.niivueToggleOverlay()

    expect(nv.added).toHaveLength(1)
    expect(nv.added[0]?.colormap).toBe(OVERLAY_COLORMAP)
    expect(nv.added[0]?.opacity).toBe(OVERLAY_OPACITY)
    expect(getNiivueEntryForViewport('vp-1')?.overlayUIDs).toEqual(['ds-2'])
  })

  it('removes loaded overlays on the second toggle', async () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' }, { name: 'overlay' })
    register('vp-1', nv)
    const entry = getNiivueEntryForViewport('vp-1')
    if (!entry) throw new Error('entry missing')
    entry.overlayUIDs = ['ds-2']

    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    await definitions.niivueToggleOverlay()
    expect(nv.volumes).toHaveLength(1)
    expect(entry.overlayUIDs).toEqual([])
  })

  it('does nothing without a loaded base volume', async () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const sm = services('vp-1', [
      { displaySetInstanceUID: 'ds-2', url: 'https://x/perf.nii.gz' },
    ])
    const { definitions } = getNiivueCommandsModule({ servicesManager: sm })
    await definitions.niivueToggleOverlay()
    expect(nv.added).toHaveLength(0)
  })
})
