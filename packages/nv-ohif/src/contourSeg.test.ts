import { expect, test } from 'bun:test'
import NiiVue, {
  type AnnotationStyle,
  type VectorAnnotation,
} from '@niivue/niivue'
import {
  addContourSegmentation,
  adoptContours,
  applyContourTool,
  contourGroup,
  contourPane,
  contourRois,
  createContourSegmentation,
  parkContours,
  releaseContourTools,
  reshowContourSegmentation,
} from './contourSeg'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'
import { annotationFromRow } from './srImport'

// A grid tilted 30 degrees about x: one axial voxel plane's mm depth varies
// with y, so a contour's z must be solved per point, not taken from its anchor.
test('RTSTRUCT contour points lie on the shape voxel plane, in LPS', () => {
  const c = Math.cos(Math.PI / 6)
  const s = Math.sin(Math.PI / 6)
  // Row-major RAS voxel -> mm.
  const matRAS = [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]
  const at = [0, 2 * c - 3 * s, 2 * s + 3 * c] // voxel (0, 2, 3)
  const ring = [
    { x: 0, y: -4 },
    { x: 6, y: -4 },
    { x: 6, y: 8 },
  ]
  const shape = {
    id: 'a',
    group: contourGroup('s'),
    label: 1,
    sliceType: 0,
    slicePosition: at[2],
    anchorMM: at,
    polygons: [{ outer: ring, holes: [] }],
  } as unknown as VectorAnnotation
  const nv = {
    volumes: [
      {
        dimsRAS: [3, 10, 10, 10],
        img2RASstep: [1, 10, 100],
        img2RASstart: [0, 0, 0],
        matRAS,
      },
    ],
    annotations: [shape],
  } as unknown as NiiVue
  const [roi] = contourRois(nv, 's', [{ value: 1, label: 'S', rgb: [1, 2, 3] }])
  const data = roi?.contours[0]?.ContourData as number[]
  expect(data).toHaveLength(9)
  for (let i = 0; i < 3; i++) {
    const [x, y, z] = [
      -(data[3 * i] as number),
      -(data[3 * i + 1] as number),
      data[3 * i + 2] as number,
    ]
    expect(x).toBeCloseTo(ring[i]?.x as number, 4)
    expect(y).toBeCloseTo(ring[i]?.y as number, 4)
    // Voxel depth (row 2 of the inverse rotation) is the anchor's, 3.
    expect(-s * y + c * z).toBeCloseTo(3, 3)
  }
})

// Review of the R28 draft: locking or changing the active segment re-armed
// only the owner pane, so a mirror kept drawing into the old segment.
type Seg = { segments: Record<number, { locked?: boolean; label?: string }> }
// OHIF's segmentation service and cornerstone's segmentation state, as far as
// contourSeg uses them.
function ohifHarness() {
  const segs = new Map<string, Seg>()
  const reps = new Map<string, { visible: boolean }>()
  const bus = new EventTarget()
  const active = new Map<string, string>()
  const removedLuts: number[] = []
  const style: Record<string, number> = {}
  let activeLabel = 1
  const modified = (segmentationId: string) =>
    bus.dispatchEvent(
      new CustomEvent('modified', { detail: { segmentationId } }),
    )
  const cst = {
    removeSegmentationRepresentations() {},
    addSegmentations: (input: { segmentationId: string; config: Seg }[]) => {
      for (const x of input) segs.set(x.segmentationId, x.config)
    },
    state: {
      getSegmentation: (id: string) => segs.get(id),
      getColorLUT: () => undefined,
      removeColorLUT: (i: number) => removedLuts.push(i),
      getSegmentationRepresentation: (
        v: string,
        s: { segmentationId: string },
      ) => reps.get(`${v}:${s.segmentationId}`),
    },
    config: {
      color: {
        addColorLUT: (_: unknown, i: number) => i,
        getSegmentIndexColor: () => [255, 0, 0, 255],
      },
      style: { getStyle: () => style },
    },
    defaultSegmentationStateManager: {
      updateState: (f: (s: object) => void) =>
        f({ viewportSegRepresentations: {} }),
      addDefaultSegmentationRepresentation: (
        _: unknown,
        v: string,
        id: string,
      ) => reps.set(`${v}:${id}`, { visible: true }),
    },
    segmentationStyle: { setRenderInactiveSegmentations() {} },
    triggerSegmentationEvents: {
      triggerSegmentationModified: modified,
      triggerSegmentationRepresentationModified() {},
    },
  }
  const service = {
    EVENTS: { SEGMENTATION_MODIFIED: 'modified' },
    subscribe: (event: string, fn: (d: unknown) => void) => {
      const l = (e: Event) => fn((e as CustomEvent).detail)
      bus.addEventListener(event, l)
      return { unsubscribe: () => bus.removeEventListener(event, l) }
    },
    setActiveSegmentation: (v: string, id: string) => active.set(v, id),
    getActiveSegmentation: (v: string) =>
      active.has(v) ? { segmentationId: active.get(v) } : undefined,
    getActiveSegment: () => ({ segmentIndex: activeLabel }),
    setActiveSegment: () => {},
  }
  const servicesManager = { services: { segmentationService: service } }
  const extensionManager = {
    getModuleEntry: () => ({
      exports: {
        getCornerstoneLibraries: () => ({
          cornerstoneTools: { segmentation: cst },
        }),
      },
    }),
  }
  return {
    segs,
    reps,
    removedLuts,
    style,
    active,
    modified,
    servicesManager,
    extensionManager,
    setActiveLabel: (l: number) => {
      activeLabel = l
    },
  }
}

const fakePane = () =>
  Object.assign(new EventTarget(), {
    canvas: new EventTarget(),
    annotations: [],
    volumes: [],
    drawScene() {},
    replaceAnnotations() {},
  }) as unknown as NiiVue

test('a mirror pane follows the active segment and its lock', () => {
  const { segs, modified, servicesManager, extensionManager, setActiveLabel } =
    ohifHarness()
  const pane = fakePane
  const owner = pane()
  const mirror = pane()
  for (const [v, nv] of [
    ['owner', owner],
    ['mirror', mirror],
  ] as const) {
    registerNiivue(v, nv)
    updateNiivueViewport(v, {
      displaySets: [{ displaySetInstanceUID: 's' }] as never,
    })
  }
  const id = createContourSegmentation(
    getNiivueEntry('owner') as never,
    {
      servicesManager,
      extensionManager,
    } as never,
  ) as string
  for (const [v, nv] of [
    ['owner', owner],
    ['mirror', mirror],
  ] as const)
    applyContourTool(
      nv,
      v,
      'PlanarFreehandContourSegmentationTool',
      servicesManager as never,
    )
  expect(mirror.annotationIsEnabled).toBe(true)
  const seg = segs.get(id) as Seg
  ;(seg.segments[1] as { locked?: boolean }).locked = true
  modified(id)
  expect(mirror.annotationIsEnabled).toBe(false)
  seg.segments[2] = { label: 'Segment 2' }
  setActiveLabel(2)
  modified(id)
  expect([mirror.annotationIsEnabled, mirror.annotationActiveLabel]).toEqual([
    true,
    2,
  ])
  for (const v of ['owner', 'mirror']) unregisterNiivue(v)
})

test('undo in a mirror cannot drop contours loaded before it', () => {
  const { servicesManager, extensionManager } = ohifHarness()
  const panes = ['owner', 'mirror'].map((v) => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    registerNiivue(v, nv)
    updateNiivueViewport(v, {
      displaySets: [{ displaySetInstanceUID: 's' }] as never,
    })
    return nv
  })
  const mirror = panes[1] as NiiVue
  const shape = (id: string, group: string): VectorAnnotation => ({
    id,
    group,
    label: 1,
    sliceType: 0,
    slicePosition: 0,
    polygons: [
      {
        outer: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        holes: [],
      },
    ],
    style: {
      fillColor: [0, 0, 0, 0],
      strokeColor: [1, 1, 1, 1],
      strokeWidth: 1,
    },
  })
  // An undo step in the mirror from before the load.
  mirror.replaceAnnotations([], [shape('length', 'default')], true)
  addContourSegmentation(
    getNiivueEntry('owner') as never,
    { servicesManager, extensionManager } as never,
    {
      segmentationId: 'rt',
      label: 'RT',
      segments: [{ value: 1, label: 'ROI' }],
      shapes: [shape('roi', contourGroup('rt'))],
    },
  )
  mirror.annotationUndo()
  expect(
    panes.map(
      (nv) => nv.annotations.filter((a) => a.group === 'seg:rt').length,
    ),
  ).toEqual([1, 1])
  for (const v of ['owner', 'mirror']) unregisterNiivue(v)
})

// Review of #875: a row adopted while a contour tool was armed took the
// segment's colour and fill.
test('a row adopted while a contour tool is armed keeps the measurement style', () => {
  const { servicesManager, extensionManager } = ohifHarness()
  const measure: AnnotationStyle = {
    fillColor: [1, 0, 0, 0],
    strokeColor: [1, 1, 0, 1],
    strokeWidth: 1,
  }
  const nv = Object.assign(new EventTarget(), {
    canvas: new EventTarget(),
    annotations: [],
    volumes: [{ permRAS: [1, 2, 3] }],
    annotationStyle: measure,
    annotationAreaIsGeometric: true,
    drawScene() {},
    replaceAnnotations() {},
  }) as unknown as NiiVue
  registerNiivue('p', nv)
  updateNiivueViewport('p', {
    displaySets: [{ displaySetInstanceUID: 's' }] as never,
  })
  createContourSegmentation(
    getNiivueEntry('p') as never,
    { servicesManager, extensionManager } as never,
  )
  applyContourTool(
    nv,
    'p',
    'PlanarFreehandContourSegmentationTool',
    servicesManager as never,
  )
  expect(nv.annotationStyle).not.toEqual(measure)
  const row = annotationFromRow(nv, {
    uid: 'l',
    toolName: 'Length',
    points: [
      [0, 0, 5],
      [10, 0, 5],
    ],
  })
  expect(row?.style).toEqual(measure)
  releaseContourTools('p')
  unregisterNiivue('p')
})

// Review of #875: deleting a parked segmentation leaked its colour LUT.
test('a parked segmentation deleted before adoption frees its colour LUT', () => {
  const { segs, removedLuts, servicesManager, extensionManager } = ohifHarness()
  registerNiivue('p', fakePane())
  updateNiivueViewport('p', {
    displaySets: [{ displaySetInstanceUID: 'lut' }] as never,
  })
  const params = { servicesManager, extensionManager } as never
  const id = createContourSegmentation(
    getNiivueEntry('p') as never,
    params,
  ) as string
  parkContours('p')
  expect(removedLuts).toEqual([])
  segs.delete(id)
  adoptContours(getNiivueEntry('p') as never, params)
  expect(removedLuts.length).toBe(1)
  unregisterNiivue('p')
})

// Review of #876: a mirror already gone from the registry was picked as heir,
// so the owner neither handed over nor parked, and the contours were lost.
test('an owner parks when its only live mirror is unregistered', () => {
  const { removedLuts, servicesManager, extensionManager } = ohifHarness()
  for (const v of ['heirOwner', 'heirMirror']) {
    registerNiivue(v, fakePane())
    updateNiivueViewport(v, {
      displaySets: [{ displaySetInstanceUID: 'heir' }] as never,
    })
  }
  const params = { servicesManager, extensionManager } as never
  createContourSegmentation(getNiivueEntry('heirOwner') as never, params)
  unregisterNiivue('heirMirror')
  parkContours('heirOwner')
  expect(removedLuts).toEqual([])
  unregisterNiivue('heirOwner')
})

// Review of #877: an anchored and an unanchored shape on one voxel plane were
// keyed by voxel index and by mm, so their overlap counted twice.
test('anchored and unanchored shapes on one plane count shared voxels once', () => {
  const { servicesManager, extensionManager } = ohifHarness()
  const ring = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ]
  // Voxel z 3 is mm z -7: an mm depth is not a voxel index.
  const matRAS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -10, 0, 0, 0, 1]
  const annotations: VectorAnnotation[] = []
  const nv = Object.assign(fakePane(), {
    annotations,
    volumes: [
      {
        dimsRAS: [3, 10, 10, 10],
        pixDimsRAS: [1, 1, 1, 1],
        img2RASstep: [1, 10, 100],
        img2RASstart: [0, 0, 0],
        matRAS,
      },
    ],
  }) as unknown as NiiVue
  registerNiivue('count', nv)
  updateNiivueViewport('count', {
    displaySets: [{ displaySetInstanceUID: 'count' }] as never,
  })
  const id = createContourSegmentation(
    getNiivueEntry('count') as never,
    { servicesManager, extensionManager } as never,
  ) as string
  const shape = (sid: string, anchorMM?: number[]) =>
    ({
      id: sid,
      group: contourGroup(id),
      label: 1,
      sliceType: 0,
      slicePosition: -7,
      anchorMM,
      polygons: [{ outer: ring, holes: [] }],
    }) as unknown as VectorAnnotation
  const one = shape('one', [0, 0, -7])
  annotations.push(one)
  const single = contourPane(id)?.rows()[0]?.count ?? 0
  expect(single).toBeGreaterThan(0)
  annotations.push(shape('two'))
  expect(contourPane(id)?.rows()[0]?.count).toBe(single)
  unregisterNiivue('count')
})

// Review of #876: a mirror took the owner's active or inactive style although
// another segmentation is active on it.
test('each pane styles a segmentation by its own active segmentation', () => {
  const { style, active, modified, servicesManager, extensionManager } =
    ohifHarness()
  style.fillAlphaInactive = 0.1
  const shapes = new Map<string, VectorAnnotation[]>()
  for (const v of ['styleOwner', 'styleMirror']) {
    const annotations: VectorAnnotation[] = []
    shapes.set(v, annotations)
    registerNiivue(v, Object.assign(fakePane(), { annotations }))
    updateNiivueViewport(v, {
      displaySets: [{ displaySetInstanceUID: 'style' }] as never,
    })
  }
  const id = createContourSegmentation(
    getNiivueEntry('styleOwner') as never,
    { servicesManager, extensionManager } as never,
  ) as string
  for (const list of shapes.values())
    list.push({
      id: crypto.randomUUID(),
      group: contourGroup(id),
      label: 1,
      sliceType: 0,
      slicePosition: 0,
      polygons: [],
    } as unknown as VectorAnnotation)
  active.set('styleMirror', 'other')
  modified(id)
  expect(
    [...shapes.values()].map((list) => list[0]?.style?.fillColor[3]),
  ).toEqual([0.5, 0.1])
  for (const v of shapes.keys()) unregisterNiivue(v)
})

// Review of #878: a mirror added later kept the owner pane's style.
test('a mirror added later takes its own pane style', () => {
  const { style, active, modified, servicesManager, extensionManager } =
    ohifHarness()
  style.fillAlphaInactive = 0.1
  const owner: VectorAnnotation[] = []
  registerNiivue('lateOwner', Object.assign(fakePane(), { annotations: owner }))
  updateNiivueViewport('lateOwner', {
    displaySets: [{ displaySetInstanceUID: 'late' }] as never,
  })
  const params = { servicesManager, extensionManager } as never
  const id = createContourSegmentation(
    getNiivueEntry('lateOwner') as never,
    params,
  ) as string
  owner.push({
    id: 'late1',
    group: contourGroup(id),
    label: 1,
    sliceType: 0,
    slicePosition: 0,
    polygons: [],
  } as unknown as VectorAnnotation)
  modified(id)
  const mirror: VectorAnnotation[] = []
  registerNiivue(
    'lateMirror',
    Object.assign(fakePane(), {
      annotations: mirror,
      replaceAnnotations: (_: string[], add: VectorAnnotation[]) =>
        mirror.push(...add),
      clearAnnotationHistory() {},
    }),
  )
  updateNiivueViewport('lateMirror', {
    displaySets: [{ displaySetInstanceUID: 'late' }] as never,
  })
  active.set('lateMirror', 'other')
  adoptContours(getNiivueEntry('lateMirror') as never, params)
  expect([
    owner[0]?.style?.fillColor[3],
    mirror[0]?.style?.fillColor[3],
  ]).toEqual([0.5, 0.1])
  for (const v of ['lateOwner', 'lateMirror']) unregisterNiivue(v)
})

// Review of #875: a segment deleted while its contours were parked came back
// on adoption, since no sync was running to drop its shapes.
test('a segment deleted while parked stays deleted on adoption', () => {
  const { segs, servicesManager, extensionManager } = ohifHarness()
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  registerNiivue('park', nv)
  updateNiivueViewport('park', {
    displaySets: [{ displaySetInstanceUID: 'parked' }] as never,
  })
  const params = { servicesManager, extensionManager } as never
  const group = contourGroup('pk')
  const shape = (label: number): VectorAnnotation => ({
    id: `s${label}`,
    group,
    label,
    sliceType: 0,
    slicePosition: 0,
    polygons: [
      {
        outer: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
        holes: [],
      },
    ],
    style: {
      fillColor: [0, 0, 0, 0],
      strokeColor: [1, 1, 1, 1],
      strokeWidth: 1,
    },
  })
  addContourSegmentation(getNiivueEntry('park') as never, params, {
    segmentationId: 'pk',
    label: 'PK',
    segments: [
      { value: 1, label: 'A' },
      { value: 2, label: 'B' },
    ],
    shapes: [shape(1), shape(2)],
  })
  parkContours('park')
  nv.removeAnnotations(nv.annotations.map((a) => a.id))
  delete segs.get('pk')?.segments[2]
  adoptContours(getNiivueEntry('park') as never, params)
  expect(
    nv.annotations.filter((a) => a.group === group).map((a) => a.label),
  ).toEqual([1])
  unregisterNiivue('park')
})

// Review of #875: a Combine result copies its first operand's style, so a
// hidden segment's alpha 0 landed on a visible one when voxel counts held.
test("an edit restyles shapes carrying another segment's style", () => {
  const { modified, servicesManager, extensionManager } = ohifHarness()
  const owner: VectorAnnotation[] = []
  const nv = Object.assign(fakePane(), { annotations: owner })
  registerNiivue('restyle', nv)
  updateNiivueViewport('restyle', {
    displaySets: [{ displaySetInstanceUID: 'restyle' }] as never,
  })
  const id = createContourSegmentation(
    getNiivueEntry('restyle') as never,
    { servicesManager, extensionManager } as never,
  ) as string
  modified(id)
  // Counted once, so the edit below leaves the voxel counts as they were.
  nv.dispatchEvent(new CustomEvent('annotationAdded'))
  owner.push({
    id: 'copied',
    group: contourGroup(id),
    label: 1,
    sliceType: 0,
    slicePosition: 0,
    polygons: [],
    style: { fillColor: [1, 0, 0, 0] },
  } as unknown as VectorAnnotation)
  nv.dispatchEvent(new CustomEvent('annotationAdded'))
  expect(owner[0]?.style?.fillColor[3]).toBe(0.5)
  unregisterNiivue('restyle')
})

// Review of #877: re-showing a live RTSTRUCT in a pane of another series added
// a contour representation with no shapes behind it.
test('re-showing a contour segmentation on another series adds nothing', () => {
  const { reps, servicesManager, extensionManager } = ohifHarness()
  for (const [v, series] of [
    ['reOwner', 'reA'],
    ['reOther', 'reB'],
  ]) {
    registerNiivue(v as string, fakePane())
    updateNiivueViewport(v as string, {
      displaySets: [{ displaySetInstanceUID: series }] as never,
    })
  }
  const id = createContourSegmentation(
    getNiivueEntry('reOwner') as never,
    { servicesManager, extensionManager } as never,
  ) as string
  expect(
    reshowContourSegmentation(id, 'reOther', extensionManager as never),
  ).toBe(true)
  expect(reps.has(`reOther:${id}`)).toBe(false)
  for (const v of ['reOwner', 'reOther']) unregisterNiivue(v)
})

// Review of #878: a mirror took segment visibility from the owner's representation.
test('a segment hidden only in a mirror is hidden there only', () => {
  const { reps, modified, servicesManager, extensionManager } = ohifHarness()
  const shapes = new Map<string, VectorAnnotation[]>()
  for (const v of ['visOwner', 'visMirror']) {
    const annotations: VectorAnnotation[] = []
    shapes.set(v, annotations)
    registerNiivue(v, Object.assign(fakePane(), { annotations }))
    updateNiivueViewport(v, {
      displaySets: [{ displaySetInstanceUID: 'vis' }] as never,
    })
  }
  const id = createContourSegmentation(
    getNiivueEntry('visOwner') as never,
    { servicesManager, extensionManager } as never,
  ) as string
  for (const list of shapes.values())
    list.push({
      id: crypto.randomUUID(),
      group: contourGroup(id),
      label: 1,
      sliceType: 0,
      slicePosition: 0,
      polygons: [],
    } as unknown as VectorAnnotation)
  reps.set(`visMirror:${id}`, {
    visible: true,
    segments: { 1: { visible: false } },
  } as never)
  modified(id)
  expect(
    [...shapes.values()].map((list) => list[0]?.style?.fillColor[3]),
  ).toEqual([0.5, 0])
  // Core strokes too when the overlay's font never loads.
  expect(
    [...shapes.values()].map((list) => list[0]?.style?.strokeColor[3]),
  ).toEqual([1, 0])
  for (const v of shapes.keys()) unregisterNiivue(v)
})
