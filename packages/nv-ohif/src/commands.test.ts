import { afterEach, describe, expect, it } from 'bun:test'
import type { default as NiiVue, VectorAnnotation } from '@niivue/niivue'
import { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import {
  applyDefaultAnnotationText,
  applyOhifLabelToAnnotation,
  applyOhifVisibilityToAnnotation,
  clearNiivueAnnotations,
  findOverlayCandidate,
  flashStatus,
  getNiivueCommandsModule,
  jumpToNiivueMeasurement,
  NIIVUE_CLIP_PLANES,
  NIIVUE_SLICE_TYPES,
  OVERLAY_COLORMAP,
  OVERLAY_OPACITY,
  readBaseWindowLevel,
  reconcileNiivueAnnotations,
  reflectNiivueAnnotation,
  removeNiivueAnnotation,
  resolveWindowLevel,
  subscribeOhifLabelSync,
  syncNiivueWindowLevelToOhif,
  visibleAnnotationScreenShapes,
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
  const crosshairTargets: Array<[number, number, number]> = []
  const selectedAnnotations: Array<string | null> = []
  return {
    sliceType: SLICE_TYPE.MULTIPLANAR as number,
    primaryDragMode: DRAG_MODE.crosshair as number,
    annotationTool: '' as string,
    annotationIsEnabled: false,
    annotations: [] as VectorAnnotation[],
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
    crosshairTargets,
    selectedAnnotations,
    drawScene() {},
    setCrosshairPos(position: [number, number, number]) {
      crosshairTargets.push(position)
    },
    selectAnnotation(id: string | null) {
      selectedAnnotations.push(id)
    },
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

  it('falls back to the measureLine annotation when no commandsManager exists', () => {
    const nv = stubNiivue()
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueSetMeasurementMode()
    expect(nv.annotationTool).toBe('measureLine')
    expect(nv.annotationIsEnabled).toBe(true)
  })
})

// Stub MeasurementService + displaySetService that record what reflection adds.
function measurementServices(
  viewportId: string,
  backing: Record<string, unknown>[],
  acceptMeasurement = true,
) {
  const added: Array<{ data: Record<string, unknown> }> = []
  const mappings: Array<{ annotationType: string }> = []
  const removed: string[] = []
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
          if (!acceptMeasurement) return undefined
          added.push({
            data: {
              ...data,
              schema: toMeasurementSchema(data as { measurement: unknown }),
            },
          })
          return data.uid as string
        },
        remove: (uid: string) => {
          removed.push(uid)
        },
      },
      displaySetService: {
        getDisplaySetsForSeries: (uid: string) =>
          backing.filter((d) => d.SeriesInstanceUID === uid),
      },
    },
  } as unknown as OhifExtensionParams['servicesManager']
  return { added, mappings, removed, servicesManager }
}

describe('reflectNiivueAnnotation', () => {
  const backing = [
    {
      SeriesInstanceUID: 'series-1',
      StudyInstanceUID: 'study-1',
      displaySetInstanceUID: 'ds-1',
      Modality: 'CT',
      instances: [{ FrameOfReferenceUID: 'for-1' }],
    },
  ]
  const ellipse = (id: string): VectorAnnotation =>
    ({
      id,
      label: 0,
      group: '',
      sliceType: 0,
      slicePosition: 0,
      anchorMM: [10, 20, 30],
      polygons: [],
      style: {
        fillColor: [1, 1, 1, 1],
        strokeColor: [1, 1, 1, 1],
        strokeWidth: 1,
      },
      stats: { area: 123.4, min: 5, mean: 50, max: 200, stdDev: 12 },
      shape: {
        type: 'measureEllipse',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
      },
    }) as unknown as VectorAnnotation

  it('defaults new annotation text to max(existing #N)+1 and mutates the stored copy', () => {
    const first = { ...ellipse('first'), text: 'ROI #1' } as VectorAnnotation
    const emittedSecond = ellipse('second')
    const storedSecond = { ...emittedSecond }
    expect(
      applyDefaultAnnotationText(emittedSecond, [first, storedSecond]),
    ).toBe(true)
    expect(emittedSecond.text).toBe('ROI #2')
    // The stored (post-merge) copy is updated too, so the overlay shows it.
    expect(storedSecond.text).toBe('ROI #2')

    emittedSecond.text = 'Custom label'
    expect(
      applyDefaultAnnotationText(emittedSecond, [first, storedSecond]),
    ).toBe(false)
    expect(emittedSecond.text).toBe('Custom label')
  })

  function setup(viewportId: string) {
    register(viewportId, stubNiivue())
    updateNiivueViewport(viewportId, {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    return measurementServices(viewportId, backing)
  }

  it('adds an OHIF EllipticalROI with area, stats, and four LPS points', () => {
    const svc = setup('vp-a1')
    const ok = reflectNiivueAnnotation(
      'vp-a1',
      svc.servicesManager,
      ellipse('a'),
    )
    expect(ok).toBe(true)
    expect(svc.added).toHaveLength(1)
    const m = svc.added[0]?.data.schema as {
      toolName: string
      referenceSeriesUID: string
      displayText: { primary: string[] }
      points: number[][]
      data: { area: number; mean: number; unit: string; areaUnit: string }
    }
    expect(m.toolName).toBe('EllipticalROI')
    expect(m.referenceSeriesUID).toBe('series-1')
    expect(m.displayText.primary[0]).toBe('123.4 mm²')
    expect(m.displayText.primary[1]).toBe('Max: 200.0 HU')
    expect(m.data.area).toBe(123.4)
    expect(m.data.mean).toBe(50)
    expect(m.data.areaUnit).toBe('mm²')
    // cornerstone3D reads consecutive pairs as axes: [top, bottom] (vertical),
    // then [left, right] (horizontal) — NOT interleaved top/right/bottom/left.
    expect(m.points).toEqual([
      [-0.5, 0, 0], // top
      [-0.5, -1, 0], // bottom
      [0, -0.5, 0], // left
      [-1, -0.5, 0], // right
    ])
  })

  it('maps points on a coronal slice at a non-zero depth (arg order)', () => {
    const line: VectorAnnotation = {
      id: 'cor',
      label: 0,
      group: '',
      sliceType: 1, // CORONAL
      slicePosition: 30,
      anchorMM: [10, 30, 20],
      polygons: [],
      style: {
        fillColor: [1, 1, 1, 1],
        strokeColor: [1, 1, 1, 1],
        strokeWidth: 1,
      },
      stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, length: 5 },
      shape: {
        type: 'measureLine',
        start: { x: 10, y: 20 },
        end: { x: 10, y: 25 },
      },
    } as unknown as VectorAnnotation
    const svc = setup('vp-coronal')
    expect(
      reflectNiivueAnnotation('vp-coronal', svc.servicesManager, line),
    ).toBe(true)
    const m = svc.added[0]?.data.schema as { points: number[][] }
    // coronal slice2DToMM(pt, slicePosition=30, sliceType=1) = [x, 30, y];
    // RAS->LPS negates x,y. The swapped arg order collapsed this to the axial
    // branch with depth 1, which this asserts against.
    expect(m.points).toEqual([
      [-10, -30, 20],
      [-10, -30, 25],
    ])
  })

  it('adds an OHIF Length from a measureLine (length text, no area)', () => {
    const line = (id: string): VectorAnnotation =>
      ({
        id,
        label: 0,
        group: '',
        sliceType: 0,
        slicePosition: 0,
        anchorMM: [10, 20, 30],
        polygons: [],
        style: {
          fillColor: [1, 1, 1, 1],
          strokeColor: [1, 1, 1, 1],
          strokeWidth: 1,
        },
        stats: { area: 0, min: 0, mean: 0, max: 0, stdDev: 0, length: 42.5 },
        shape: {
          type: 'measureLine',
          start: { x: 0, y: 0 },
          end: { x: 3, y: 4 },
        },
      }) as unknown as VectorAnnotation
    const svc = setup('vp-len')
    const ok = reflectNiivueAnnotation('vp-len', svc.servicesManager, line('L'))
    expect(ok).toBe(true)
    const m = svc.added[0]?.data.schema as {
      toolName: string
      displayText: { primary: string[] }
      points: number[][]
      data: { length: number; unit: string }
    }
    expect(m.toolName).toBe('Length')
    expect(m.displayText.primary).toEqual(['42.5 mm'])
    expect(m.data).toEqual({ length: 42.5, unit: 'mm' })
    expect(m.points).toEqual([
      [0, 0, 0],
      [-3, -4, 0],
    ])
  })

  it('reflects freehand as a PlanarFreehandROI polyline', () => {
    const svc = setup('vp-a2')
    const anno = ellipse('b')
    anno.shape = undefined
    anno.polygons = [
      {
        outer: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 1, y: 2 },
        ],
        holes: [],
      },
    ]
    expect(reflectNiivueAnnotation('vp-a2', svc.servicesManager, anno)).toBe(
      true,
    )
    const measurement = svc.added[0]?.data.schema as {
      toolName: string
      points: number[][]
    }
    expect(measurement.toolName).toBe('PlanarFreehandROI')
    expect(measurement.points).toHaveLength(3)
  })

  it('does not misrepresent multi-part or holed freehand geometry', () => {
    const svc = setup('vp-freehand-complex')
    const annotation = ellipse('complex')
    annotation.shape = undefined
    const triangle = {
      outer: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 2 },
      ],
      holes: [] as Array<Array<{ x: number; y: number }>>,
    }
    annotation.polygons = [
      triangle,
      {
        outer: [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 5, y: 6 },
        ],
        holes: [],
      },
    ]
    expect(
      reflectNiivueAnnotation(
        'vp-freehand-complex',
        svc.servicesManager,
        annotation,
      ),
    ).toBe(false)

    annotation.polygons = [
      {
        ...triangle,
        holes: [
          [
            { x: 0.5, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0.75, y: 1 },
          ],
        ],
      },
    ]
    expect(
      reflectNiivueAnnotation(
        'vp-freehand-complex',
        svc.servicesManager,
        annotation,
      ),
    ).toBe(false)
    expect(svc.added).toHaveLength(0)
  })

  it('reflects arrow endpoints tip-first (arrowhead at points[0])', () => {
    const svc = setup('vp-arrow')
    const annotation = ellipse('arrow')
    annotation.shape = {
      type: 'arrow',
      start: { x: 1, y: 2 }, // tail
      end: { x: 4, y: 6 }, // arrowhead / tip
    }
    annotation.stats = undefined
    expect(
      reflectNiivueAnnotation('vp-arrow', svc.servicesManager, annotation),
    ).toBe(true)
    const measurement = svc.added[0]?.data.schema as { points: number[][] }
    // cornerstone3D ArrowAnnotate anchors at points[0]; emit the tip (end) first.
    expect(measurement.points).toEqual([
      [-4, -6, 0], // tip
      [-1, -2, 0], // tail
    ])
  })

  it('reflects the row label from the annotation text (empty when cleared) (R3-2)', () => {
    const svc = setup('vp-clear')
    const a = ellipse('c')
    a.text = 'ROI #1'
    reflectNiivueAnnotation('vp-clear', svc.servicesManager, a)
    expect((svc.added[0]?.data.schema as { label: string }).label).toBe(
      'ROI #1',
    )
    // Clearing the text yields an EMPTY row label, not a 'NiiVue <Tool>' fallback
    // (which would echo back onto the canvas and make clearing impossible).
    a.text = undefined
    reflectNiivueAnnotation('vp-clear', svc.servicesManager, a)
    expect((svc.added[1]?.data.schema as { label: string }).label).toBe('')
  })

  it('deletes a row when changed geometry becomes permanently unsupported', () => {
    const nv = stubNiivue()
    register('vp-neg', nv)
    updateNiivueViewport('vp-neg', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-neg', backing)
    const good = ellipse('n')
    nv.annotations = [good]
    reflectNiivueAnnotation('vp-neg', svc.servicesManager, good)
    const addsBefore = svc.added.length
    // Mutate into an unreflectable shape: a bidirectional missing its short axis
    // yields 2 points < minPoints 4 (permanentlyUnsupported).
    nv.annotations = [
      {
        ...ellipse('n'),
        shape: {
          type: 'measureBidirectional',
          start: { x: 0, y: 0 },
          end: { x: 3, y: 4 },
        },
      } as unknown as VectorAnnotation,
    ]
    reconcileNiivueAnnotations('vp-neg', svc.servicesManager)
    // Per product decision, the stale row is removed rather than misrepresenting
    // the new geometry; nothing new is added.
    expect(svc.removed).toHaveLength(1)
    expect(svc.added.length).toBe(addsBefore)
    // A second reconcile with the same bad geometry is a no-op (negative cache).
    reconcileNiivueAnnotations('vp-neg', svc.servicesManager)
    expect(svc.added.length).toBe(addsBefore)
    expect(svc.removed).toHaveLength(1)
  })

  it('retries a thrown removal of an unsupported row, then negative-caches (F1)', () => {
    const nv = stubNiivue()
    register('vp-f1', nv)
    updateNiivueViewport('vp-f1', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-f1', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as { remove: (uid: string) => void }
    let removeAttempts = 0
    measurementService.remove = (uid) => {
      removeAttempts += 1
      if (removeAttempts === 1) throw new Error('temporarily unavailable')
      svc.removed.push(uid)
    }
    const good = ellipse('f')
    nv.annotations = [good]
    reflectNiivueAnnotation('vp-f1', svc.servicesManager, good)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    // Edit into a permanently-unsupported shape.
    nv.annotations = [
      {
        ...ellipse('f'),
        shape: {
          type: 'measureBidirectional',
          start: { x: 0, y: 0 },
          end: { x: 3, y: 4 },
        },
      } as unknown as VectorAnnotation,
    ]
    // First reconcile: removal THROWS -> row + uid retained, NOT negative-cached.
    reconcileNiivueAnnotations('vp-f1', svc.servicesManager)
    expect(removeAttempts).toBe(1)
    expect(svc.removed).toHaveLength(0)
    // Second reconcile: removal is retried and succeeds -> row removed, then cached.
    reconcileNiivueAnnotations('vp-f1', svc.servicesManager)
    expect(removeAttempts).toBe(2)
    expect(svc.removed).toEqual([uid])
    // Third reconcile: negative cache is now in place; no further removal attempts.
    reconcileNiivueAnnotations('vp-f1', svc.servicesManager)
    expect(removeAttempts).toBe(2)
  })

  it('retries a transient failure when the backing series becomes available', () => {
    const nv = stubNiivue()
    const availableBacking: typeof backing = []
    register('vp-retry', nv)
    updateNiivueViewport('vp-retry', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-retry', availableBacking)
    nv.annotations = [ellipse('retry')]

    // No backing series yet -> retryable failure, NOT cached.
    reconcileNiivueAnnotations('vp-retry', svc.servicesManager)
    expect(svc.added).toHaveLength(0)

    // Once the backing series resolves, the next reconcile reflects it — even
    // though the annotation content did not change (round-4 R4-2 / #3).
    availableBacking.push(...backing)
    reconcileNiivueAnnotations('vp-retry', svc.servicesManager)
    expect(svc.added).toHaveLength(1)
  })

  it('does not record a row when OHIF rejects the measurement', () => {
    register('vp-rejected', stubNiivue())
    updateNiivueViewport('vp-rejected', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-rejected', backing, false)
    expect(
      reflectNiivueAnnotation(
        'vp-rejected',
        svc.servicesManager,
        ellipse('rejected'),
      ),
    ).toBe(false)
    expect(svc.added).toHaveLength(0)
    removeNiivueAnnotation('vp-rejected', svc.servicesManager, 'rejected')
    expect(svc.removed).toHaveLength(0)
  })

  it('does not reflect an incomplete shape with too few declared points', () => {
    const svc = setup('vp-a2-incomplete')
    const anno = ellipse('incomplete')
    anno.shape = {
      type: 'measureBidirectional',
      start: { x: 0, y: 0 },
      end: { x: 3, y: 4 },
    }
    expect(
      reflectNiivueAnnotation('vp-a2-incomplete', svc.servicesManager, anno),
    ).toBe(false)
    expect(svc.added).toHaveLength(0)
  })

  it('removeNiivueAnnotation removes only that reflected row', () => {
    const svc = setup('vp-a3')
    reflectNiivueAnnotation('vp-a3', svc.servicesManager, ellipse('keep'))
    reflectNiivueAnnotation('vp-a3', svc.servicesManager, ellipse('drop'))
    removeNiivueAnnotation('vp-a3', svc.servicesManager, 'drop')
    expect(svc.removed).toHaveLength(1)
  })

  it('retries a failed row removal on the next reconciliation', () => {
    const nv = stubNiivue()
    register('vp-remove-retry', nv)
    updateNiivueViewport('vp-remove-retry', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-remove-retry', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as { remove: (uid: string) => void }
    let attempts = 0
    measurementService.remove = (uid) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporarily unavailable')
      svc.removed.push(uid)
    }
    const annotation = ellipse('retry-remove')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-remove-retry', svc.servicesManager, annotation)
    nv.annotations = []

    reconcileNiivueAnnotations('vp-remove-retry', svc.servicesManager)
    expect(attempts).toBe(1)
    expect(svc.removed).toHaveLength(0)

    reconcileNiivueAnnotations('vp-remove-retry', svc.servicesManager)
    expect(attempts).toBe(2)
    expect(svc.removed).toHaveLength(1)
  })

  it('clearNiivueAnnotations removes every reflected row for the viewport', () => {
    const svc = setup('vp-a4')
    reflectNiivueAnnotation('vp-a4', svc.servicesManager, ellipse('c1'))
    reflectNiivueAnnotation('vp-a4', svc.servicesManager, ellipse('c2'))
    clearNiivueAnnotations('vp-a4', svc.servicesManager)
    expect(svc.removed).toHaveLength(2)
  })

  it('reconcile removes only vanished rows and leaves untouched rows alone', () => {
    const nv = stubNiivue()
    register('vp-a6', nv)
    updateNiivueViewport('vp-a6', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-a6', backing)
    reflectNiivueAnnotation('vp-a6', svc.servicesManager, ellipse('keep'))
    reflectNiivueAnnotation('vp-a6', svc.servicesManager, ellipse('drop'))
    const dropUid = (svc.added[1]?.data.schema as { uid: string }).uid
    // Undo removed 'drop'; 'keep' is unchanged.
    nv.annotations = [ellipse('keep')]
    reconcileNiivueAnnotations('vp-a6', svc.servicesManager)
    // Only the vanished row is removed; the unchanged 'keep' row is NOT re-added.
    expect(svc.removed).toEqual([dropUid])
    expect(svc.added).toHaveLength(2)
  })

  it('reconcile updates a changed row without re-minting any uid', () => {
    const nv = stubNiivue()
    register('vp-a7', nv)
    updateNiivueViewport('vp-a7', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-a7', backing)
    reflectNiivueAnnotation('vp-a7', svc.servicesManager, ellipse('A'))
    reflectNiivueAnnotation('vp-a7', svc.servicesManager, ellipse('B'))
    const aUid = (svc.added[0]?.data.schema as { uid: string }).uid
    const uidB = (svc.added[1]?.data.schema as { uid: string }).uid
    // A is resized (stats change); B is untouched.
    const aChanged = ellipse('A')
    ;(aChanged as { stats: Record<string, number> }).stats = {
      area: 999,
      min: 5,
      mean: 50,
      max: 200,
      stdDev: 12,
    }
    nv.annotations = [aChanged, ellipse('B')]
    reconcileNiivueAnnotations('vp-a7', svc.servicesManager)
    expect(svc.removed).toHaveLength(0)
    // A is updated once with the same uid; B is not submitted again.
    expect(svc.added).toHaveLength(3)
    const refreshed = svc.added[2]?.data.schema as {
      uid: string
      data: { area: number }
    }
    expect(refreshed.uid).toBe(aUid)
    expect(refreshed.uid).not.toBe(uidB)
    expect(refreshed.data.area).toBe(999)
  })

  it('reconcile detects slice-depth changes in reflected geometry', () => {
    const nv = stubNiivue()
    register('vp-depth', nv)
    updateNiivueViewport('vp-depth', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-depth', backing)
    const annotation = ellipse('depth')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-depth', svc.servicesManager, annotation)
    annotation.slicePosition = 12
    reconcileNiivueAnnotations('vp-depth', svc.servicesManager)
    expect(svc.added).toHaveLength(2)
    const updated = svc.added[1]?.data.schema as {
      uid: string
      points: number[][]
    }
    expect(updated.points.every((point) => point[2] === 12)).toBe(true)
  })

  it('pushes an edited OHIF label back onto the annotation as free text', () => {
    const texts: Array<{ id: string; text: string }> = []
    const nv = {
      ...stubNiivue(),
      setAnnotationText: (id: string, text: string) => texts.push({ id, text }),
    }
    register('vp-a5', nv)
    updateNiivueViewport('vp-a5', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-a5', backing)
    reflectNiivueAnnotation('vp-a5', svc.servicesManager, ellipse('lbl'))
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    applyOhifLabelToAnnotation(uid, 'Tumor A')
    expect(texts).toEqual([{ id: 'lbl', text: 'Tumor A' }])
    // An unknown uid is a no-op.
    applyOhifLabelToAnnotation('not-ours', 'x')
    expect(texts).toHaveLength(1)
  })

  it('jumps to the owning viewport and selects the reflected annotation', () => {
    const nv = stubNiivue()
    const activated: string[] = []
    register('vp-jump', nv)
    updateNiivueViewport('vp-jump', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-jump', backing)
    const servicesMap = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services as Record<string, unknown>
    servicesMap.viewportGridService = {
      setActiveViewportId: (viewportId: string) => activated.push(viewportId),
    }
    const annotation = ellipse('jump')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-jump', svc.servicesManager, annotation)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid

    jumpToNiivueMeasurement(uid, svc.servicesManager)

    expect(activated).toEqual(['vp-jump'])
    // Jumps to the shape CENTER (mm), not anchorMM (the drag-start corner): the
    // ellipse start{0,0}/end{1,1} centers at (0.5,0.5) -> axial mm [0.5,0.5,0]
    // (round-4 R4-4).
    expect(nv.crosshairTargets).toEqual([[0.5, 0.5, 0]])
    expect(nv.selectedAnnotations).toEqual(['jump'])
  })

  it('jumps an arrow to its tip, not its tail (R4-4)', () => {
    const nv = stubNiivue()
    register('vp-arrowjump', nv)
    updateNiivueViewport('vp-arrowjump', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-arrowjump', backing)
    const a = ellipse('aj')
    a.shape = { type: 'arrow', start: { x: 1, y: 2 }, end: { x: 4, y: 6 } }
    a.stats = undefined
    nv.annotations = [a]
    reflectNiivueAnnotation('vp-arrowjump', svc.servicesManager, a)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    jumpToNiivueMeasurement(uid, svc.servicesManager)
    // Arrow tip = shape.end {4,6} -> axial mm [4,6,0] (not the tail or anchorMM).
    expect(nv.crosshairTargets).toEqual([[4, 6, 0]])
  })

  it('clears bookkeeping when the host cannot remove a row, so it does not leak (R4-1)', () => {
    const texts: Array<{ id: string; text: string }> = []
    const nv = {
      ...stubNiivue(),
      setAnnotationText: (id: string, text: string) => texts.push({ id, text }),
    }
    register('vp-noremove', nv)
    updateNiivueViewport('vp-noremove', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const added: Array<{ uid: string }> = []
    // A MeasurementService with NO remove method.
    const sm = {
      services: {
        viewportGridService: { getActiveViewportId: () => 'vp-noremove' },
        measurementService: {
          createSource: () => ({}),
          addMapping: () => {},
          addRawMeasurement: (
            _s: unknown,
            _t: string,
            data: { uid: string; measurement: unknown },
            toSchema: (d: { measurement: unknown }) => { uid: string },
          ) => {
            added.push(toSchema(data))
            return data.uid
          },
        },
        displaySetService: {
          getDisplaySetsForSeries: (uid: string) =>
            backing.filter((d) => d.SeriesInstanceUID === uid),
        },
      },
    } as unknown as OhifExtensionParams['servicesManager']
    const a = ellipse('a')
    nv.annotations = [a]
    reflectNiivueAnnotation('vp-noremove', sm, a)
    const uid = added[0]?.uid ?? ''
    removeNiivueAnnotation('vp-noremove', sm, 'a')
    // Bookkeeping is gone even though the OHIF row could not be removed: a later
    // label event for the old uid is a no-op (before the fix the maps leaked).
    applyOhifLabelToAnnotation(uid, 'x')
    expect(texts).toHaveLength(0)
  })

  it('shares one OHIF label subscription across viewports', () => {
    let subscriptions = 0
    let unsubscriptions = 0
    const servicesManager = {
      services: {
        measurementService: {
          EVENTS: { MEASUREMENT_UPDATED: 'measurement-updated' },
          subscribe: () => {
            subscriptions += 1
            return {
              unsubscribe: () => {
                unsubscriptions += 1
              },
            }
          },
        },
      },
    } as unknown as OhifExtensionParams['servicesManager']
    const releaseFirst = subscribeOhifLabelSync(servicesManager)
    const releaseSecond = subscribeOhifLabelSync(servicesManager)
    expect(subscriptions).toBe(1)
    releaseFirst?.()
    expect(unsubscriptions).toBe(0)
    releaseSecond?.()
    expect(unsubscriptions).toBe(1)
  })

  it('handles OHIF jump events through the shared measurement subscription', () => {
    const nv = stubNiivue()
    const callbacks = new Map<string, (payload: unknown) => void>()
    register('vp-jump-event', nv)
    updateNiivueViewport('vp-jump-event', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-jump-event', backing)
    const servicesMap = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services as Record<string, unknown>
    const measurementService = servicesMap.measurementService as {
      EVENTS?: Record<string, string>
      subscribe?: (
        event: string,
        callback: (payload: unknown) => void,
      ) => {
        unsubscribe: () => void
      }
    }
    measurementService.EVENTS = {
      JUMP_TO_MEASUREMENT: 'jump',
    }
    measurementService.subscribe = (event, callback) => {
      callbacks.set(event, callback)
      return { unsubscribe: () => callbacks.delete(event) }
    }
    const annotation = ellipse('jump-event')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-jump-event', svc.servicesManager, annotation)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    const release = subscribeOhifLabelSync(svc.servicesManager)

    callbacks.get('jump')?.({ measurement: { uid } })

    // Shape center in mm (round-4 R4-4), not anchorMM.
    expect(nv.crosshairTargets).toEqual([[0.5, 0.5, 0]])
    expect(nv.selectedAnnotations).toEqual(['jump-event'])
    release?.()
  })

  it('removes the NiiVue annotation when its OHIF measurement is deleted from the panel', () => {
    const removedAnnotationIds: string[] = []
    const nv = {
      ...stubNiivue(),
      removeAnnotation(id: string) {
        removedAnnotationIds.push(id)
        const i = nv.annotations.findIndex((a) => a.id === id)
        if (i >= 0) nv.annotations.splice(i, 1)
      },
    }
    const callbacks = new Map<string, (payload: unknown) => void>()
    register('vp-remove-event', nv)
    updateNiivueViewport('vp-remove-event', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-remove-event', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as {
      EVENTS?: Record<string, string>
      subscribe?: (
        event: string,
        callback: (payload: unknown) => void,
      ) => { unsubscribe: () => void }
    }
    measurementService.EVENTS = { MEASUREMENT_REMOVED: 'removed' }
    measurementService.subscribe = (event, callback) => {
      callbacks.set(event, callback)
      return { unsubscribe: () => callbacks.delete(event) }
    }
    const annotation = ellipse('remove-event')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-remove-event', svc.servicesManager, annotation)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    const release = subscribeOhifLabelSync(svc.servicesManager)

    // OHIF broadcasts the removed uid as a bare string.
    callbacks.get('removed')?.({ measurement: uid })

    expect(removedAnnotationIds).toEqual(['remove-event'])
    expect(nv.annotations).toHaveLength(0)
    // We must NOT call measurementService.remove: OHIF already deleted the row.
    expect(svc.removed).toHaveLength(0)
    // Bookkeeping is gone, so a duplicate remove event is an inert no-op.
    callbacks.get('removed')?.({ measurement: uid })
    expect(removedAnnotationIds).toEqual(['remove-event'])
    release?.()
  })

  it('does not re-enter when our own removal echoes MEASUREMENT_REMOVED', () => {
    const removedAnnotationIds: string[] = []
    const nv = {
      ...stubNiivue(),
      removeAnnotation(id: string) {
        removedAnnotationIds.push(id)
      },
    }
    const callbacks = new Map<string, (payload: unknown) => void>()
    register('vp-remove-echo', nv)
    updateNiivueViewport('vp-remove-echo', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-remove-echo', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as {
      EVENTS?: Record<string, string>
      subscribe?: (
        event: string,
        callback: (payload: unknown) => void,
      ) => { unsubscribe: () => void }
      remove: (uid: string) => void
    }
    measurementService.EVENTS = { MEASUREMENT_REMOVED: 'removed' }
    measurementService.subscribe = (event, callback) => {
      callbacks.set(event, callback)
      return { unsubscribe: () => callbacks.delete(event) }
    }
    // Real OHIF fires MEASUREMENT_REMOVED synchronously from remove().
    measurementService.remove = (uid) => {
      svc.removed.push(uid)
      callbacks.get('removed')?.({ measurement: uid })
    }
    const annotation = ellipse('remove-echo')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-remove-echo', svc.servicesManager, annotation)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    const release = subscribeOhifLabelSync(svc.servicesManager)

    // Our teardown calls measurementService.remove, which echoes the event. The
    // removingUids guard keeps that from re-entering and removing the annotation.
    removeNiivueAnnotation('vp-remove-echo', svc.servicesManager, 'remove-echo')

    expect(svc.removed).toEqual([uid])
    expect(removedAnnotationIds).toHaveLength(0)
    release?.()
  })

  it('hides and shows the annotation when its OHIF measurement visibility toggles', () => {
    let draws = 0
    const nv = {
      ...stubNiivue(),
      drawScene() {
        draws += 1
      },
    }
    const callbacks = new Map<string, (payload: unknown) => void>()
    register('vp-vis', nv)
    updateNiivueViewport('vp-vis', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-vis', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as {
      EVENTS?: Record<string, string>
      subscribe?: (
        event: string,
        callback: (payload: unknown) => void,
      ) => { unsubscribe: () => void }
    }
    measurementService.EVENTS = { MEASUREMENT_UPDATED: 'updated' }
    measurementService.subscribe = (event, callback) => {
      callbacks.set(event, callback)
      return { unsubscribe: () => callbacks.delete(event) }
    }
    const annotation = ellipse('vis')
    nv.annotations = [annotation]
    reflectNiivueAnnotation('vp-vis', svc.servicesManager, annotation)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    const release = subscribeOhifLabelSync(svc.servicesManager)

    const shapes = [{ id: 'vis' }, { id: 'other' }] as unknown as Parameters<
      typeof visibleAnnotationScreenShapes
    >[1]
    // Visible by default: every projected shape passes through.
    expect(visibleAnnotationScreenShapes('vp-vis', shapes)).toHaveLength(2)

    // Hide it: the overlay filter drops that id and the viewport re-renders.
    callbacks.get('updated')?.({ measurement: { uid, isVisible: false } })
    expect(draws).toBe(1)
    expect(
      visibleAnnotationScreenShapes('vp-vis', shapes).map((s) => s.id),
    ).toEqual(['other'])

    // Idempotent: a repeat hide is a no-op (no extra redraw).
    callbacks.get('updated')?.({ measurement: { uid, isVisible: false } })
    expect(draws).toBe(1)

    // Show it again: the id passes through once more.
    callbacks.get('updated')?.({ measurement: { uid, isVisible: true } })
    expect(draws).toBe(2)
    expect(visibleAnnotationScreenShapes('vp-vis', shapes)).toHaveLength(2)
    release?.()
  })

  it('records a hide even when the viewport entry is unavailable (finding 2)', () => {
    const svc = setup('vp-vis-noentry')
    reflectNiivueAnnotation(
      'vp-vis-noentry',
      svc.servicesManager,
      ellipse('gone'),
    )
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    // The viewport unregisters (transient remount) before the toggle arrives.
    unregisterNiivue('vp-vis-noentry')
    applyOhifVisibilityToAnnotation(uid, false)
    const shapes = [{ id: 'gone' }] as unknown as Parameters<
      typeof visibleAnnotationScreenShapes
    >[1]
    // The hidden state was still recorded, so the next render filters it out.
    expect(
      visibleAnnotationScreenShapes('vp-vis-noentry', shapes),
    ).toHaveLength(0)
  })

  it('keeps the hidden flag when the row is dropped but the annotation lives (finding 1)', () => {
    const nv = stubNiivue()
    register('vp-vis-reconcile', nv)
    updateNiivueViewport('vp-vis-reconcile', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-vis-reconcile', backing)
    const anno = ellipse('alive')
    nv.annotations = [anno]
    reflectNiivueAnnotation('vp-vis-reconcile', svc.servicesManager, anno)
    const uid = (svc.added[0]?.data.schema as { uid: string }).uid
    applyOhifVisibilityToAnnotation(uid, false)
    const shapes = [{ id: 'alive' }] as unknown as Parameters<
      typeof visibleAnnotationScreenShapes
    >[1]
    expect(
      visibleAnnotationScreenShapes('vp-vis-reconcile', shapes),
    ).toHaveLength(0)

    // Reconcile drops the OHIF row while the annotation is STILL in nv.annotations
    // (permanently-unsupported edit). The hidden flag must survive.
    removeNiivueAnnotation('vp-vis-reconcile', svc.servicesManager, 'alive')
    expect(
      visibleAnnotationScreenShapes('vp-vis-reconcile', shapes),
    ).toHaveLength(0)

    // But once the annotation is genuinely gone, the flag is cleared.
    nv.annotations = []
    // Re-hide (the row is gone, so re-reflect to re-establish the mapping+row).
    reflectNiivueAnnotation('vp-vis-reconcile', svc.servicesManager, anno)
    const uid2 = (svc.added[1]?.data.schema as { uid: string }).uid
    applyOhifVisibilityToAnnotation(uid2, false)
    nv.annotations = []
    removeNiivueAnnotation('vp-vis-reconcile', svc.servicesManager, 'alive')
    expect(
      visibleAnnotationScreenShapes('vp-vis-reconcile', shapes),
    ).toHaveLength(1)
  })

  it('does not re-enter on its own remove echoes during teardown (finding 3)', () => {
    const removedAnnotationIds: string[] = []
    const nv = {
      ...stubNiivue(),
      removeAnnotation(id: string) {
        removedAnnotationIds.push(id)
      },
    }
    const callbacks = new Map<string, (payload: unknown) => void>()
    register('vp-clear-echo', nv)
    updateNiivueViewport('vp-clear-echo', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const svc = measurementServices('vp-clear-echo', backing)
    const measurementService = (
      svc.servicesManager as NonNullable<OhifExtensionParams['servicesManager']>
    ).services.measurementService as {
      EVENTS?: Record<string, string>
      subscribe?: (
        event: string,
        callback: (payload: unknown) => void,
      ) => { unsubscribe: () => void }
      remove: (uid: string) => void
    }
    measurementService.EVENTS = { MEASUREMENT_REMOVED: 'removed' }
    measurementService.subscribe = (event, callback) => {
      callbacks.set(event, callback)
      return { unsubscribe: () => callbacks.delete(event) }
    }
    // Real OHIF fires MEASUREMENT_REMOVED synchronously from remove().
    measurementService.remove = (uid) => {
      svc.removed.push(uid)
      callbacks.get('removed')?.({ measurement: uid })
    }
    const a = ellipse('c1')
    const b = ellipse('c2')
    nv.annotations = [a, b]
    reflectNiivueAnnotation('vp-clear-echo', svc.servicesManager, a)
    reflectNiivueAnnotation('vp-clear-echo', svc.servicesManager, b)
    const release = subscribeOhifLabelSync(svc.servicesManager)

    // Teardown removes both rows while the subscription is still live.
    clearNiivueAnnotations('vp-clear-echo', svc.servicesManager)

    expect(svc.removed).toHaveLength(2)
    // The removingUids guard kept the echoes from re-entering nv.removeAnnotation.
    expect(removedAnnotationIds).toHaveLength(0)
    release?.()
  })

  it('does not infinitely recurse when an update echoes MEASUREMENT_UPDATED (R2-0)', () => {
    // A measurement service that upserts and, like real OHIF, synchronously
    // broadcasts MEASUREMENT_UPDATED on an UPDATE (a reused uid) — the exact
    // echo the prior test mock never produced, which hid the recursion.
    const anno = ellipse('x') as unknown as { id: string; text?: string }
    const annos = [anno as unknown as VectorAnnotation]
    let addCalls = 0
    let updatedCb:
      | ((p: { measurement: { uid: string; label?: string } }) => void)
      | undefined
    const seen = new Set<string>()
    let sm: OhifExtensionParams['servicesManager']
    const nv = {
      ...stubNiivue(),
      annotations: annos,
      setAnnotationText: (id: string, text: string) => {
        const a = annos.find((x) => x.id === id) as
          | { text?: string }
          | undefined
        if (a) a.text = text || undefined
        // Mirror NiivueViewport: setAnnotationText emits annotationChanged, which
        // reconciles.
        reconcileNiivueAnnotations('vp-loop', sm)
      },
    }
    register('vp-loop', nv)
    updateNiivueViewport('vp-loop', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const measurementService = {
      createSource: () => ({}),
      addMapping: () => {},
      addRawMeasurement: (
        _s: unknown,
        _t: string,
        data: { measurement: unknown },
        toSchema: (d: { measurement: unknown }) => {
          uid: string
          label?: string
        },
      ) => {
        addCalls += 1
        const m = toSchema(data)
        const isUpdate = seen.has(m.uid)
        seen.add(m.uid)
        if (isUpdate)
          updatedCb?.({ measurement: { uid: m.uid, label: m.label } })
        return m.uid
      },
      remove: () => {},
      EVENTS: { MEASUREMENT_UPDATED: 'updated' },
      subscribe: (
        evt: string,
        cb: (p: { measurement: { uid: string; label?: string } }) => void,
      ) => {
        if (evt === 'updated') updatedCb = cb
        return {
          unsubscribe: () => {
            updatedCb = undefined
          },
        }
      },
    }
    sm = {
      services: {
        viewportGridService: { getActiveViewportId: () => 'vp-loop' },
        measurementService,
        displaySetService: {
          getDisplaySetsForSeries: (uid: string) =>
            backing.filter((d) => d.SeriesInstanceUID === uid),
        },
      },
    } as unknown as OhifExtensionParams['servicesManager']
    subscribeOhifLabelSync(sm)
    reflectNiivueAnnotation('vp-loop', sm, annos[0] as VectorAnnotation)
    const addsAfterFirst = addCalls
    // Resize: change stats -> reconcile updates in place (reuses the uid) ->
    // MEASUREMENT_UPDATED echoes -> label sync -> setAnnotationText -> reconcile.
    // The re-entrancy guard + unchanged-text guard bound this to a few calls
    // instead of a stack overflow.
    annos[0] = {
      ...(ellipse('x') as object),
      stats: { area: 999, min: 5, mean: 50, max: 200, stdDev: 12 },
    } as unknown as VectorAnnotation
    reconcileNiivueAnnotations('vp-loop', sm)
    expect(addCalls - addsAfterFirst).toBeLessThan(5)
  })

  it('re-entrancy guard alone bounds recursion when each echo label differs (R3-6)', () => {
    // Every echo carries a DIFFERENT label, so the unchanged-text guard never
    // fires — only the reconcile re-entrancy guard prevents infinite recursion.
    // This isolates that guard (the other test also passes on the text guard).
    const anno = ellipse('y') as unknown as { id: string; text?: string }
    const annos = [anno as unknown as VectorAnnotation]
    let addCalls = 0
    let labelSeq = 0
    let updatedCb:
      | ((p: { measurement: { uid: string; label?: string } }) => void)
      | undefined
    const seen = new Set<string>()
    let sm: OhifExtensionParams['servicesManager']
    const nv = {
      ...stubNiivue(),
      annotations: annos,
      setAnnotationText: (id: string, text: string) => {
        const a = annos.find((x) => x.id === id) as
          | { text?: string }
          | undefined
        if (a) a.text = text || undefined
        reconcileNiivueAnnotations('vp-loop2', sm)
      },
    }
    register('vp-loop2', nv)
    updateNiivueViewport('vp-loop2', {
      displaySets: backing as unknown as Parameters<
        typeof updateNiivueViewport
      >[1]['displaySets'],
    })
    const measurementService = {
      createSource: () => ({}),
      addMapping: () => {},
      addRawMeasurement: (
        _s: unknown,
        _t: string,
        data: { measurement: unknown },
        toSchema: (d: { measurement: unknown }) => { uid: string },
      ) => {
        addCalls += 1
        const m = toSchema(data)
        const isUpdate = seen.has(m.uid)
        seen.add(m.uid)
        // Always echo a brand-new label so the unchanged-text guard cannot help.
        if (isUpdate)
          updatedCb?.({ measurement: { uid: m.uid, label: `L${++labelSeq}` } })
        return m.uid
      },
      remove: () => {},
      EVENTS: { MEASUREMENT_UPDATED: 'updated' },
      subscribe: (
        evt: string,
        cb: (p: { measurement: { uid: string; label?: string } }) => void,
      ) => {
        if (evt === 'updated') updatedCb = cb
        return {
          unsubscribe: () => {
            updatedCb = undefined
          },
        }
      },
    }
    sm = {
      services: {
        viewportGridService: { getActiveViewportId: () => 'vp-loop2' },
        measurementService,
        displaySetService: {
          getDisplaySetsForSeries: (uid: string) =>
            backing.filter((d) => d.SeriesInstanceUID === uid),
        },
      },
    } as unknown as OhifExtensionParams['servicesManager']
    subscribeOhifLabelSync(sm)
    reflectNiivueAnnotation('vp-loop2', sm, annos[0] as VectorAnnotation)
    const addsAfterFirst = addCalls
    annos[0] = {
      ...(ellipse('y') as object),
      stats: { area: 42, min: 5, mean: 50, max: 200, stdDev: 12 },
    } as unknown as VectorAnnotation
    reconcileNiivueAnnotations('vp-loop2', sm)
    expect(addCalls - addsAfterFirst).toBeLessThan(5)
  })

  it('applyDefaultAnnotationText labels by tool and never reuses a number (R4-3)', () => {
    const mk = (id: string, type: string): VectorAnnotation =>
      ({
        id,
        text: undefined,
        polygons: [],
        shape: { type, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      }) as unknown as VectorAnnotation
    // A measured line (Length) gets NO default text (its ruler draws the mm).
    const line = mk('l', 'measureLine')
    expect(applyDefaultAnnotationText(line, [line])).toBe(false)
    expect(line.text).toBeUndefined()
    // Tool-aware prefixes: an arrow is an Arrow, not an ROI.
    const arrow = mk('a', 'arrow')
    expect(applyDefaultAnnotationText(arrow, [line, arrow])).toBe(true)
    expect(arrow.text).toBe('Arrow #1')
    // ROI #1 was deleted; a new ROI must not reuse the surviving #2.
    const r2 = {
      ...mk('r2', 'measureEllipse'),
      text: 'ROI #2',
    } as VectorAnnotation
    const r3 = mk('r3', 'measureEllipse')
    expect(applyDefaultAnnotationText(r3, [r2, r3])).toBe(true)
    expect(r3.text).toBe('ROI #3')
    // An already-labeled annotation is left alone.
    expect(applyDefaultAnnotationText(r2, [r2, r3])).toBe(false)
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

describe('niivueToggleCrosshair', () => {
  it('hides then shows the crosshair (width 0 <-> 1) and redraws', () => {
    let drawn = 0
    const nv = {
      ...stubNiivue(),
      crosshairWidth: 1,
      is3DCrosshairVisible: true,
      drawScene: () => {
        drawn++
      },
    }
    register('vp-1', nv)
    const { definitions } = getNiivueCommandsModule({
      servicesManager: services('vp-1'),
    })
    definitions.niivueToggleCrosshair()
    expect(nv.crosshairWidth).toBe(0)
    expect(nv.is3DCrosshairVisible).toBe(false)
    definitions.niivueToggleCrosshair()
    expect(nv.crosshairWidth).toBe(1)
    expect(nv.is3DCrosshairVisible).toBe(true)
    expect(drawn).toBe(2)
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

describe('flashStatus', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  function statusEntry() {
    const writes: Array<string | null> = []
    const entry = {
      setStatus: (message: string | null) => writes.push(message),
    } as unknown as Parameters<typeof flashStatus>[0]
    return { entry, writes }
  }

  it('clears its own message after the flash duration', async () => {
    const { entry, writes } = statusEntry()
    flashStatus(entry, 'No other loadable series in this study.', 10)
    expect(writes).toEqual(['No other loadable series in this study.'])
    await sleep(30)
    expect(writes).toEqual(['No other loadable series in this study.', null])
  })

  it('does not blank a newer status when its timer fires late', async () => {
    const { entry, writes } = statusEntry()
    flashStatus(entry, 'Overlay load failed: boom', 10)
    // A retried load writes fresh progress before the failure flash expires.
    flashStatus(entry, 'Fetching overlay: PERFUSION... 3/10', 1000)
    await sleep(30)
    // The stale timer must not clear the live progress readout.
    expect(writes).toEqual([
      'Overlay load failed: boom',
      'Fetching overlay: PERFUSION... 3/10',
    ])
  })
})
