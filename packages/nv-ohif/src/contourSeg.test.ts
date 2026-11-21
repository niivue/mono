import { expect, test } from 'bun:test'
import NiiVue, { type VectorAnnotation } from '@niivue/niivue'
import {
  addContourSegmentation,
  applyContourTool,
  contourGroup,
  contourRois,
  createContourSegmentation,
} from './contourSeg'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
  updateNiivueViewport,
} from './niivueRegistry'

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
  let activeLabel = 1
  const modified = (segmentationId: string) =>
    bus.dispatchEvent(
      new CustomEvent('modified', { detail: { segmentationId } }),
    )
  const cst = {
    addSegmentations: (input: { segmentationId: string; config: Seg }[]) => {
      for (const x of input) segs.set(x.segmentationId, x.config)
    },
    state: {
      getSegmentation: (id: string) => segs.get(id),
      getColorLUT: () => undefined,
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
      style: { getStyle: () => ({}) },
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
    modified,
    servicesManager,
    extensionManager,
    setActiveLabel: (l: number) => {
      activeLabel = l
    },
  }
}

test('a mirror pane follows the active segment and its lock', () => {
  const { segs, modified, servicesManager, extensionManager, setActiveLabel } =
    ohifHarness()
  const pane = () =>
    Object.assign(new EventTarget(), {
      canvas: new EventTarget(),
      annotations: [],
      volumes: [],
      drawScene() {},
      replaceAnnotations() {},
    }) as unknown as NiiVue
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
