import { afterEach, describe, expect, it } from 'bun:test'
import type NiiVue from '@niivue/niivue'
import { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import {
  findOverlayCandidate,
  getNiivueCommandsModule,
  NIIVUE_CLIP_PLANES,
  NIIVUE_SLICE_TYPES,
  OVERLAY_COLORMAP,
  OVERLAY_OPACITY,
  readBaseWindowLevel,
  reflectNiivueMeasurement,
  resolveWindowLevel,
  syncNiivueWindowLevelToOhif,
} from './commands'
import {
  getNiivueEntryForViewport,
  getNiivueForViewport,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import type { OhifExtensionParams } from './ohif-types'

// A stub with the scene properties and volume APIs the commands touch.
function stubNiivue() {
  const volumes: unknown[] = []
  const added: Record<string, unknown>[] = []
  const clipPlanes: number[][] = []
  const volumeUpdates: Array<{ index: number; opts: Record<string, unknown> }> =
    []
  const recalculated: number[] = []
  return {
    sliceType: SLICE_TYPE.MULTIPLANAR as number,
    primaryDragMode: DRAG_MODE.crosshair as number,
    azimuth: 42,
    elevation: -7,
    scaleMultiplier: 3,
    pan2Dxyzmm: [5, 6, 7, 2],
    renderPan: [1, 2],
    crosshairPos: [0.1, 0.2, 0.3],
    volumes,
    added,
    clipPlanes,
    volumeUpdates,
    recalculated,
    setClipPlane(dae: number[]) {
      clipPlanes.push(dae)
    },
    async addVolume(spec: Record<string, unknown>) {
      added.push(spec)
      volumes.push(spec)
    },
    async setVolume(index: number, opts: Record<string, unknown>) {
      volumeUpdates.push({ index, opts })
    },
    async recalculateCalMinMax(index: number) {
      recalculated.push(index)
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
  windowLevelPresets?: Record<string, unknown>,
) {
  return {
    services: {
      viewportGridService: { getActiveViewportId: () => activeViewportId },
      displaySetService: { getActiveDisplaySets: () => displaySets },
      customizationService: {
        getCustomization: (id: string) =>
          id === 'cornerstone.windowLevelPresets'
            ? windowLevelPresets
            : undefined,
      },
    },
  }
}

const registered: string[] = []
function register(viewportId: string, nv: ReturnType<typeof stubNiivue>) {
  registerNiivue(viewportId, nv as unknown as NiiVue)
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
    expect(getNiivueForViewport('vp-a')).toBe(a as unknown as NiiVue)
    // A non-NiiVue viewport id still resolves while only one instance exists.
    expect(getNiivueForViewport('vp-other')).toBe(a as unknown as NiiVue)

    const b = stubNiivue()
    register('vp-b', b)
    // With two instances the fallback is ambiguous: exact matches only.
    expect(getNiivueForViewport('vp-b')).toBe(b as unknown as NiiVue)
    expect(getNiivueForViewport('vp-other')).toBeUndefined()
  })
})

describe('niivueSetMeasurementMode', () => {
  it("activates OHIF's Length tool so the tool bridge drives measurement mode", () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const ran: Array<{ name: string; opts?: Record<string, unknown> }> = []
    const commandsManager = {
      runCommand: (name: string, opts?: Record<string, unknown>) => {
        ran.push({ name, opts })
      },
    }
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
      commandsManager,
    })
    definitions.niivueSetMeasurementMode()
    expect(ran).toEqual([
      { name: 'setToolActiveToolbar', opts: { toolName: 'Length' } },
    ])
  })

  it('falls back to NiiVue measurement mode when no commandsManager exists', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetMeasurementMode()
    expect(nv.primaryDragMode).toBe(DRAG_MODE.measurement)
  })
})

// Stub MeasurementService + displaySetService that record what reflection adds.
function measurementServices(
  viewportId: string,
  backing: Record<string, unknown>[],
) {
  const added: Array<{ data: Record<string, unknown> }> = []
  const mappings: Array<{ annotationType: string }> = []
  const servicesManager = {
    services: {
      viewportGridService: { getActiveViewportId: () => viewportId },
      measurementService: {
        createSource: (name: string, version: string) => ({ name, version }),
        addMapping: (_source: unknown, annotationType: string) => {
          mappings.push({ annotationType })
        },
        addRawMeasurement: (
          _source: unknown,
          _annotationType: string,
          data: Record<string, unknown>,
          toMeasurementSchema: (d: { measurement: unknown }) => unknown,
        ) => {
          added.push({
            data: {
              ...data,
              schema: toMeasurementSchema(data as { measurement: unknown }),
            },
          })
        },
      },
      displaySetService: {
        getDisplaySetsForSeries: (uid: string) =>
          backing.filter((d) => d.SeriesInstanceUID === uid),
      },
    },
  } as unknown as OhifExtensionParams['servicesManager']
  return { added, mappings, servicesManager }
}

describe('reflectNiivueMeasurement', () => {
  it('adds an OHIF Length measurement (RAS->LPS, series ref, length text)', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const backing = [
      {
        SeriesInstanceUID: 'series-1',
        StudyInstanceUID: 'study-1',
        displaySetInstanceUID: 'ds-1',
        instances: [{ FrameOfReferenceUID: 'for-1' }],
      },
    ]
    updateNiivueViewport('vp-1', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-1', backing)
    const ok = reflectNiivueMeasurement('vp-1', svc.servicesManager, {
      startMM: [10, 20, 30],
      endMM: [10, 20, 40],
      distance: 10,
    })
    expect(ok).toBe(true)
    expect(svc.added).toHaveLength(1)
    const first = svc.added[0]
    if (!first) throw new Error('no measurement added')
    const data = first.data as Record<string, unknown>
    // addRawMeasurement destructures data.annotation.data, so it must exist.
    const annotation = data.annotation as { data?: unknown }
    expect(annotation.data).toBeDefined()
    const m = data.schema as {
      toolName: string
      referenceSeriesUID: string
      referenceStudyUID: string
      displaySetInstanceUID: string
      FrameOfReferenceUID: string
      displayText: { primary: string[] }
      points: number[][]
      data: { length: number; unit: string }
    }
    expect(m.toolName).toBe('Length')
    expect(m.referenceSeriesUID).toBe('series-1')
    expect(m.referenceStudyUID).toBe('study-1')
    expect(m.displaySetInstanceUID).toBe('ds-1')
    expect(m.FrameOfReferenceUID).toBe('for-1')
    expect(m.displayText.primary[0]).toBe('10.0 mm')
    expect(m.data).toEqual({ length: 10, unit: 'mm' })
    // NIfTI RAS -> DICOM LPS negates x and y, keeps z.
    expect(m.points[0]).toEqual([-10, -20, 30])
    expect(m.points[1]).toEqual([-10, -20, 40])
  })

  it('returns false and adds nothing when no backing series has instances', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ SeriesInstanceUID: 's-empty' }] as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    // Backing series resolves but has no instances (e.g. a NIfTI-URL set).
    const svc = measurementServices('vp-1', [{ SeriesInstanceUID: 's-empty' }])
    const ok = reflectNiivueMeasurement('vp-1', svc.servicesManager, {
      startMM: [0, 0, 0],
      endMM: [1, 0, 0],
      distance: 1,
    })
    expect(ok).toBe(false)
    expect(svc.added).toHaveLength(0)
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

  it('resets the visible NVSlide view instead of the hidden volume view', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    let resets = 0
    updateNiivueViewport('vp-1', {
      slideView: {
        setTool() {},
        resetView() {
          resets++
        },
        async saveBitmap() {},
        dispose() {},
      },
    })
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueResetView()
    expect(resets).toBe(1)
    expect(nv.azimuth).toBe(42)
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

describe('resolveWindowLevel', () => {
  const presets = {
    CT: [
      { id: 'ct-soft-tissue', window: '400', level: '40' },
      { id: 'ct-bone', window: '2500', level: '480' },
    ],
    PT: [{ id: 'pt-suv-5', window: '0', level: '5' }],
  }
  it('maps width/center to [calMin, calMax] by id', () => {
    expect(resolveWindowLevel(presets, 'CT', 'ct-soft-tissue', 0)).toEqual([
      -160, 240,
    ])
  })
  it('falls back to index when the id is absent', () => {
    expect(resolveWindowLevel(presets, 'CT', undefined, 1)).toEqual([
      -770, 1730,
    ])
  })
  it('treats a zero-width preset as a 0..level clamp', () => {
    expect(resolveWindowLevel(presets, 'PT', 'pt-suv-5', 0)).toEqual([0, 5])
  })
  it('returns undefined for an unknown modality or preset', () => {
    expect(resolveWindowLevel(presets, 'MR', undefined, 0)).toBeUndefined()
    expect(resolveWindowLevel(presets, 'CT', 'nope', 99)).toBeUndefined()
  })
})

describe('niivueSetWindowLevel', () => {
  it('applies calMin/calMax from width + center', () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetWindowLevel({ window: 80, level: 40 })
    expect(nv.volumeUpdates).toEqual([
      { index: 0, opts: { calMin: 0, calMax: 80 } },
    ])
  })

  it('ignores missing values and empty volumes', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetWindowLevel({ window: 80 })
    nv.volumes.push({ name: 'base' })
    definitions.niivueSetWindowLevel()
    expect(nv.volumeUpdates).toEqual([])
  })
})

describe('niivueSetWindowLevelPreset', () => {
  it("applies OHIF's preset resolved for the base modality", () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'CT' }],
    })
    const sm = services('vp-1', [], {
      CT: [{ id: 'ct-brain', window: '80', level: '40' }],
    })
    const { definitions } = getNiivueCommandsModule({ servicesManager: sm })
    definitions.niivueSetWindowLevelPreset({
      presetId: 'ct-brain',
      presetIndex: 0,
    })
    expect(nv.volumeUpdates).toEqual([
      { index: 0, opts: { calMin: 0, calMax: 80 } },
    ])
  })

  it('does nothing when the base modality has no matching preset', () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1', Modality: 'MR' }],
    })
    const sm = services('vp-1', [], {
      CT: [{ id: 'ct-brain', window: '80', level: '40' }],
    })
    const { definitions } = getNiivueCommandsModule({ servicesManager: sm })
    definitions.niivueSetWindowLevelPreset({
      presetId: 'ct-brain',
      presetIndex: 0,
    })
    expect(nv.volumeUpdates).toEqual([])
  })
})

describe('readBaseWindowLevel', () => {
  it('derives width + center from the base volume calMin/calMax', () => {
    expect(
      readBaseWindowLevel({ volumes: [{ calMin: -160, calMax: 240 }] }),
    ).toEqual({
      window: 400,
      level: 40,
    })
  })
  it('returns undefined without a base volume or finite range', () => {
    expect(readBaseWindowLevel({ volumes: [] })).toBeUndefined()
    expect(
      readBaseWindowLevel({ volumes: [{ calMin: Number.NaN, calMax: 1 }] }),
    ).toBeUndefined()
  })
})

describe('syncNiivueWindowLevelToOhif', () => {
  // A services manager whose viewport grid lists our viewport, a same-series
  // sibling, and a different-series viewport.
  function gridServices() {
    return {
      services: {
        viewportGridService: {
          getState: () => ({
            viewports: new Map([
              ['vp-1', { displaySetInstanceUIDs: ['ds-1'] }], // ours
              ['cs-sibling', { displaySetInstanceUIDs: ['ds-1'] }], // same series
              ['cs-other', { displaySetInstanceUIDs: ['ds-9'] }], // different
            ]),
          }),
        },
      },
    }
  }

  it('seeds the baseline silently, then syncs only same-series siblings', () => {
    const nv = stubNiivue()
    nv.volumes.push({ calMin: 0, calMax: 100 }) // W 100 / L 50
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1' }],
    })
    const ran: Array<{ name: string; opts?: Record<string, unknown> }> = []
    const cm = {
      runCommand: (name: string, opts?: Record<string, unknown>) => {
        ran.push({ name, opts })
      },
    }
    const sm = gridServices()

    // First call with no prior baseline: seeds, no sync, no readout.
    expect(syncNiivueWindowLevelToOhif('vp-1', sm, cm)).toBeUndefined()
    expect(ran).toEqual([])
    expect(getNiivueEntryForViewport('vp-1')?.windowLevel).toEqual({
      window: 100,
      level: 50,
    })

    // A contrast drag changed the window: sync the same-series sibling only
    // (never our own viewport, never the different-series one).
    nv.volumes[0] = { calMin: 200, calMax: 600 } // W 400 / L 400
    const wl = syncNiivueWindowLevelToOhif('vp-1', sm, cm)
    expect(wl).toEqual({ window: 400, level: 400 })
    expect(ran).toEqual([
      {
        name: 'setViewportWindowLevel',
        opts: {
          viewportId: 'cs-sibling',
          windowWidth: 400,
          windowCenter: 400,
        },
      },
    ])

    // Unchanged release: no sync, no readout.
    expect(syncNiivueWindowLevelToOhif('vp-1', sm, cm)).toBeUndefined()
    expect(ran).toHaveLength(1)
  })

  it('does not throw without services or a commands manager', () => {
    const nv = stubNiivue()
    nv.volumes.push({ calMin: 0, calMax: 10 })
    register('vp-1', nv)
    updateNiivueViewport('vp-1', {
      displaySets: [{ displaySetInstanceUID: 'ds-1' }],
    })
    syncNiivueWindowLevelToOhif('vp-1', undefined, undefined) // seed
    nv.volumes[0] = { calMin: 0, calMax: 40 }
    expect(() =>
      syncNiivueWindowLevelToOhif('vp-1', undefined, undefined),
    ).not.toThrow()
  })
})

describe('niivueSetColormap', () => {
  it('sets the base volume colormap via setVolume(0)', () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetColormap({ colormap: 'viridis' })
    expect(nv.volumeUpdates).toEqual([
      { index: 0, opts: { colormap: 'viridis' } },
    ])
  })

  it('ignores a missing colormap or empty volumes', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetColormap({ colormap: 'hot' }) // no volume yet
    nv.volumes.push({ name: 'base' })
    definitions.niivueSetColormap() // no colormap
    expect(nv.volumeUpdates).toEqual([])
  })
})

describe('niivueToggleColorbar', () => {
  it('flips the colorbar visibility on the active viewport', () => {
    const nv = { ...stubNiivue(), isColorbarVisible: false }
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueToggleColorbar()
    expect(nv.isColorbarVisible).toBe(true)
    definitions.niivueToggleColorbar()
    expect(nv.isColorbarVisible).toBe(false)
  })
})

describe('niivueToggleInterpolation', () => {
  it('flips nearest-neighbor interpolation on the active viewport', () => {
    const nv = { ...stubNiivue(), volumeIsNearestInterpolation: false }
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueToggleInterpolation()
    expect(nv.volumeIsNearestInterpolation).toBe(true)
    definitions.niivueToggleInterpolation()
    expect(nv.volumeIsNearestInterpolation).toBe(false)
  })
})

describe('niivueAutoWindowLevel', () => {
  it('recomputes the robust window on the base volume', () => {
    const nv = stubNiivue()
    nv.volumes.push({ name: 'base' })
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueAutoWindowLevel()
    expect(nv.recalculated).toEqual([0])
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
