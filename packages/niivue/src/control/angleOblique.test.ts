import { expect, spyOn, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import * as Annotation from '@/annotation'
import { generateShape } from '@/annotation/index'
import { buildLivewireCost } from '@/annotation/livewire'
import NiiVue from '@/NVControl'
import * as Layout from '@/view/NVSliceLayout'
import { initInteraction } from './interactions'

let point = [0, 0, 0]
function controller(tool: string, tilt = false) {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  nv.canvas = {
    width: 200,
    height: 200,
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
  } as never
  nv.view = {
    hitTest: () => ({ isRender: false, sliceType: 0, tileIndex: 0 }),
    screenSlices: [],
    legendLayout: null,
    graphLayout: null,
  } as never
  nv.model.annotation.isEnabled = true
  nv.model.annotation.tool = tool as never
  nv.model.annotation.mergesOverlaps = false
  nv.model.annotation.isClickToPlace = true
  nv.model.volumes = [
    { dimsRAS: [3, 100, 100, 100], pixDimsRAS: [1, 1, 1, 1] },
  ] as never
  // Inverse rotate around x by 60 degrees, so picked world points share voxel z=0.
  if (tilt) {
    nv.model.mm2tex = new Float32Array([
      1,
      0,
      0,
      0,
      0,
      0.5,
      -Math.sqrt(3) / 2,
      0,
      0,
      Math.sqrt(3) / 2,
      0.5,
      0,
      0,
      0,
      0,
      1,
    ]) as never
    nv.model.tex2mm = mat4.invert(
      mat4.create(),
      nv.model.mm2tex as mat4,
    ) as never
  }
  initInteraction(nv)
  return nv
}
function press(nv: NiiVue, p: number[], detail = 1) {
  point = p
  const e = {
    button: 0,
    pointerType: 'mouse',
    pointerId: 1,
    detail,
    clientX: 50,
    clientY: 50,
    shiftKey: false,
    preventDefault() {},
  }
  nv._eventListeners.pointerdown?.(e as never)
  nv._eventListeners.pointerup?.(e as never)
}

// R13 audit: on a slice tilted 60° the 2D projection reads 53.13° for a
// physical right angle; the angle must be measured on the drawn plane.
test('an angle on an oblique slice is the physical angle', () => {
  // Both stubs are process-wide under bun: restore them for later test files.
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    const nv = controller('measureAngle', true)
    // World arms (10, 5, sqrt(75)) and (10, -5, -sqrt(75)) are orthogonal.
    press(nv, [10, 5, Math.sqrt(75)])
    press(nv, [0, 0, 0])
    press(nv, [10, -5, -Math.sqrt(75)])
    expect(nv.annotations[0]?.stats?.angle).toBeCloseTo(90, 4)
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
})

function withStubs(run: () => void) {
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    run()
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
}

// Review of #827: browsers report detail 2 for a fast second click; an angle
// has no double-click close, so that click still places its point.
test('a fast second click places an angle point', () =>
  withStubs(() => {
    const nv = controller('measureAngle')
    press(nv, [2, 2, 0])
    press(nv, [2, 3, 0], 2)
    press(nv, [8, 3, 0])
    expect(nv.annotations).toHaveLength(1)
  }))

// Review of #824: a probe pressed on a selected region's control point places
// a probe; it must not start resizing the region.
test('a probe on a selected ROI handle places a probe', () =>
  withStubs(() => {
    const nv = controller('measurePoint')
    const corner = { x: 5, y: 5 }
    const roi = {
      id: 'roi',
      label: 1,
      group: '',
      sliceType: 0,
      slicePosition: 0,
      polygons: [
        {
          outer: [corner, { x: 9, y: 5 }, { x: 9, y: 9 }, { x: 5, y: 9 }],
          holes: [],
        },
      ],
      style: structuredClone(nv.model.annotation.style),
      shape: { type: 'measureRect', start: corner, end: { x: 9, y: 9 } },
    }
    nv.model.annotations.push(roi as never)
    nv.model._annotationSelection = {
      annotationId: 'roi',
      controlPoints: [corner],
    } as never
    press(nv, [5, 5, 0])
    expect(nv.annotations.map((a) => a.shape?.type).sort()).toEqual([
      'measurePoint',
      'measureRect',
    ])
    expect(nv.annotations.find((a) => a.id === 'roi')?.shape?.end).toEqual({
      x: 9,
      y: 9,
    })
  }))

// Review of #834: a first bidirectional drag is in progress; cancelling it
// ends the drag, so the release commits nothing.
test('cancelAnnotationInProgress ends a bidirectional drag', () =>
  withStubs(() => {
    const nv = controller('bidirectional')
    nv.model.annotation.isClickToPlace = false
    const at = (x: number) => ({
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
      detail: 1,
      clientX: x,
      clientY: 50,
      shiftKey: false,
      preventDefault() {},
    })
    point = [0, 0, 0]
    nv._eventListeners.pointerdown?.(at(50) as never)
    point = [20, 0, 0]
    nv._eventListeners.pointermove?.(at(70) as never)
    expect(nv.isAnnotationInProgress).toBe(true)
    expect(nv.cancelAnnotationInProgress()).toBe(true)
    expect(nv.isDragging).toBe(false)
    nv._eventListeners.pointerup?.(at(70) as never)
    expect(nv.annotations).toHaveLength(0)
    expect(nv.isAnnotationInProgress).toBe(false)
  }))

// Review of #834: a resize records its undo step on release, so cancelling
// one leaves no step behind.
test('a cancelled resize records no undo step', () => {
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    const nv = controller('measureRect')
    const corner = { x: 5, y: 5 }
    nv.model.annotations.push({
      id: 'roi',
      label: 1,
      group: '',
      sliceType: 0,
      slicePosition: 0,
      polygons: [
        {
          outer: [corner, { x: 9, y: 5 }, { x: 9, y: 9 }, { x: 5, y: 9 }],
          holes: [],
        },
      ],
      style: structuredClone(nv.model.annotation.style),
      shape: { type: 'measureRect', start: corner, end: { x: 9, y: 9 } },
    } as never)
    const select = () => {
      nv.model._annotationSelection = {
        annotationId: 'roi',
        controlPoints: [corner],
      } as never
    }
    const at = (type: string, clientX = 50) =>
      nv._eventListeners[type as 'pointerdown']?.({
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        pointerId: 1,
        detail: 1,
        clientX,
        clientY: 50,
        shiftKey: false,
        preventDefault() {},
      } as never)
    point = [5, 5, 0]
    select()
    at('pointerdown')
    expect(nv.isAnnotationInProgress).toBe(true)
    expect(nv.cancelAnnotationInProgress()).toBe(true)
    at('pointerup')
    expect(nv.annotationUndoTop).toBeUndefined()
    // A click on a handle changes nothing and records nothing.
    select()
    at('pointerdown')
    at('pointerup')
    expect(nv.annotationUndoTop).toBeUndefined()
    // A released resize records one.
    select()
    at('pointerdown')
    point = [4, 4, 0]
    at('pointermove', 55)
    at('pointerup', 55)
    const top = nv.annotationUndoTop
    expect(top).toBeDefined()
    // pointercancel (touch interrupted) reverts a moved handle, as a cancel.
    const shape = structuredClone(nv.annotations[0]?.shape)
    select()
    at('pointerdown')
    point = [2, 2, 0]
    at('pointermove', 60)
    expect(nv.annotations[0]?.shape).not.toEqual(shape)
    at('pointercancel')
    expect(nv.annotations[0]?.shape).toEqual(shape)
    expect(nv.annotationUndoTop).toBe(top)
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
})

// Review of #834: tiles are bounds-local, so the close click must be too.
test('a close click in a bounded viewer commits a spline', () => {
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    const nv = new NiiVue({
      backend: 'webgl2',
      bounds: [
        [0.25, 0],
        [0.75, 1],
      ],
    })
    nv.drawScene = () => {}
    nv.canvas = {
      width: 400,
      height: 200,
      style: {},
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 200,
      }),
      addEventListener() {},
      removeEventListener() {},
      setPointerCapture() {},
      releasePointerCapture() {},
    } as never
    nv.view = {
      hitTest: () => ({ isRender: false, sliceType: 0, tileIndex: 0 }),
      screenSlices: [
        {
          mvpMatrix: mat4.create(),
          planeNormal: [0, 0, 1],
          planePoint: [0, 0, 0],
          leftTopWidthHeight: [0, 0, 200, 200],
        },
      ],
      legendLayout: null,
      graphLayout: null,
    } as never
    nv.model.annotation.isEnabled = true
    nv.model.annotation.tool = 'spline'
    nv.model.annotation.isClickToPlace = true
    nv.model.annotation.mergesOverlaps = false
    nv.model.volumes = [
      { dimsRAS: [3, 100, 100, 100], pixDimsRAS: [1, 1, 1, 1] },
    ] as never
    initInteraction(nv)
    // Client x 200 is bounds-local 100, the tile centre: world (0, 0).
    const clicks = [
      [200, 100, [0, 0, 0]],
      [230, 100, [30, 0, 0]],
      [230, 70, [30, 30, 0]],
      [200, 100, [0, 0, 0]],
    ] as const
    for (const [x, y, p] of clicks) {
      point = [...p]
      const e = {
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        pointerId: 1,
        detail: 1,
        clientX: x,
        clientY: y,
        shiftKey: false,
        preventDefault() {},
      }
      nv._eventListeners.pointerdown?.(e as never)
      nv._eventListeners.pointerup?.(e as never)
    }
    expect(nv.annotations).toHaveLength(1)
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
})

// R15 round 19: a probe drag moves anchorMM too; a cancel restores it.
test('a cancelled probe drag restores its point', () => {
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    const nv = controller('measurePoint')
    const p = { x: 5, y: 5 }
    nv.model.annotations.push({
      id: 'probe',
      label: 1,
      group: '',
      sliceType: 0,
      slicePosition: 0,
      anchorMM: [5, 5, 0],
      polygons: generateShape('measurePoint', p, p, 1),
      style: structuredClone(nv.model.annotation.style),
      shape: { type: 'measurePoint', start: p, end: p, width: 1 },
    } as never)
    nv.model._annotationSelection = {
      annotationId: 'probe',
      controlPoints: [p],
    } as never
    const at = (type: string, clientX = 50) =>
      nv._eventListeners[type as 'pointerdown']?.({
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        pointerId: 1,
        detail: 1,
        clientX,
        clientY: 50,
        shiftKey: false,
        preventDefault() {},
      } as never)
    point = [5, 5, 0]
    at('pointerdown')
    point = [20, 20, 0]
    at('pointermove', 70)
    expect(nv.annotations[0]?.anchorMM).toEqual([20, 20, 0])
    expect(nv.cancelAnnotationInProgress()).toBe(true)
    expect(nv.annotations[0]?.anchorMM).toEqual([5, 5, 0])
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
})

// R15 round 19: a new multi-click shape drops the selection, as a drag shape
// does, so Delete does not remove an older (jumped-to) annotation.
test('starting an angle clears the selection', () => {
  const savedWindow = globalThis.window
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
  } as never
  const pick = spyOn(Layout, 'screenSlicePick').mockImplementation(
    () => point as never,
  )
  try {
    const nv = controller('measureAngle')
    nv.model.annotations.push({
      id: 'old',
      label: 1,
      group: '',
      sliceType: 0,
      slicePosition: 40,
      polygons: [],
      style: structuredClone(nv.model.annotation.style),
    } as never)
    nv.selectAnnotation('old')
    press(nv, [10, 0, 0])
    expect(nv.selectedAnnotation).toBeNull()
  } finally {
    pick.mockRestore()
    globalThis.window = savedWindow
  }
})

// Review of #834: live wire's points are its snapped path, so the close test
// counts clicks: A, B, back near A retraces one edge and must not close.
test('live wire needs three clicks to close', () =>
  withStubs(() => {
    const w = 20
    const id = mat4.create()
    const slice = spyOn(Annotation, 'extractLivewireSlice').mockReturnValue({
      image: new Float32Array(w * w),
      cost: buildLivewireCost(new Float32Array(w * w), w, w),
      width: w,
      height: w,
      ax0: 0,
      ax1: 1,
      depthDim: 2,
      depthVox: 0,
      sliceType: 0,
      slicePosition: 0,
      mm2vox: id,
      vox2mm: id,
    } as never)
    try {
      const nv = controller('livewire')
      // Every point projects to the press position: each click is near A.
      const toCentre = new Float32Array(16)
      toCentre[15] = 1
      ;(nv.view as { screenSlices: unknown }).screenSlices = [
        {
          mvpMatrix: toCentre,
          planeNormal: [0, 0, 1],
          planePoint: [0, 0, 0],
          leftTopWidthHeight: [0, 0, 100, 100],
        },
      ] as never
      press(nv, [2, 2, 0])
      press(nv, [12, 2, 0])
      press(nv, [2.2, 2, 0])
      expect(nv.annotations).toHaveLength(0)
      // A third click placed: the next press near A closes.
      press(nv, [2, 2, 0])
      expect(nv.annotations).toHaveLength(1)
    } finally {
      slice.mockRestore()
    }
  }))

// Review of #858: with no live-wire slice the clicks still count toward a close.
test('live wire without a slice closes near its first click', () =>
  withStubs(() => {
    const slice = spyOn(Annotation, 'extractLivewireSlice').mockReturnValue(
      null,
    )
    try {
      const nv = controller('livewire')
      const toCentre = new Float32Array(16)
      toCentre[15] = 1
      ;(nv.view as { screenSlices: unknown }).screenSlices = [
        {
          mvpMatrix: toCentre,
          planeNormal: [0, 0, 1],
          planePoint: [0, 0, 0],
          leftTopWidthHeight: [0, 0, 100, 100],
        },
      ] as never
      press(nv, [2, 2, 0])
      press(nv, [12, 2, 0])
      press(nv, [12, 12, 0])
      press(nv, [2, 2, 0])
      expect(nv.annotations).toHaveLength(1)
      // Clicks on one spot place one point, so no degenerate contour closes.
      for (let i = 0; i < 4; i++) press(nv, [40, 40, 0])
      expect(nv.annotations).toHaveLength(1)
    } finally {
      slice.mockRestore()
    }
  }))

// One axial tile, mm (x, y) at canvas (100 + x, 100 - y); `tilt` is the
// 60-degree slice of controller(tool, true).
function tile(nv: NiiVue, tilt = false) {
  ;(nv.view as { screenSlices: unknown }).screenSlices = [
    {
      axCorSag: 0,
      mvpMatrix: mat4.fromScaling(mat4.create(), [0.01, 0.01, 0.01]),
      planeNormal: tilt ? [0, -Math.sqrt(3) / 2, 0.5] : [0, 0, 1],
      planePoint: [0, 0, 0],
      leftTopWidthHeight: [0, 0, 200, 200],
    },
  ]
}
// Press at world `a`, drag to `b`, release (screen from the x, y mm).
function drag(nv: NiiVue, a: number[], b: number[]) {
  const at = (p: number[]) =>
    ({
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
      detail: 1,
      clientX: 100 + (p[0] as number),
      clientY: 100 - (p[1] as number),
      shiftKey: false,
      preventDefault() {},
    }) as never
  point = a
  nv._eventListeners.pointerdown?.(at(a))
  point = b
  nv._eventListeners.pointermove?.(at(b))
  nv._eventListeners.pointerup?.(at(b))
}
function grabMode(nv: NiiVue) {
  nv.model._annotationSelection = null
  nv.model.annotation.isEnabled = false
  nv.model.annotation.isHandleGrab = true
}

// annotation.isHandleGrab: a press on a shown shape's handle drags it with
// annotation mode off (another tool active) and no selecting click first.
test('isHandleGrab drags a Length end with annotation mode off', () =>
  withStubs(() => {
    const nv = controller('measureLine')
    press(nv, [10, 10, 0])
    press(nv, [30, 10, 0])
    grabMode(nv)
    tile(nv)
    drag(nv, [30, 10, 0], [30, 40, 0])
    expect(nv.annotations).toHaveLength(1)
    expect(nv.annotations[0]?.shape?.end).toEqual({ x: 30, y: 40 })
    expect(nv.annotations[0]?.stats?.length).toBeCloseTo(Math.hypot(20, 30), 6)
  }))

// Review of #868: a cancelled grab leaves nothing selected, as pointerup does.
test('isHandleGrab cancelled by pointercancel reverts and deselects', () =>
  withStubs(() => {
    const nv = controller('measureLine')
    press(nv, [10, 10, 0])
    press(nv, [30, 10, 0])
    grabMode(nv)
    tile(nv)
    const at = (type: string, p: number[]) => {
      point = p
      nv._eventListeners[type as 'pointerdown']?.({
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        pointerId: 1,
        detail: 1,
        clientX: 100 + (p[0] as number),
        clientY: 100 - (p[1] as number),
        shiftKey: false,
        preventDefault() {},
      } as never)
    }
    at('pointerdown', [30, 10, 0])
    at('pointermove', [30, 40, 0])
    expect(nv.model._annotationSelection).not.toBeNull()
    at('pointercancel', [30, 40, 0])
    expect(nv.annotations[0]?.shape?.end).toEqual({ x: 30, y: 10 })
    expect(nv.model._annotationSelection).toBeNull()
  }))

// Review of #871: only a grab deselects; a plain click away from the shape keeps
// a selection made through the API (an OHIF panel row, nv-mcp select).
test('a click outside annotation mode keeps an API selection', () =>
  withStubs(() => {
    const nv = controller('measureLine')
    press(nv, [10, 10, 0])
    press(nv, [30, 10, 0])
    grabMode(nv)
    tile(nv)
    nv.setCrosshairPos = () => {}
    ;(nv.model.volumes[0] as { matRAS?: mat4 }).matRAS = mat4.create()
    const id = nv.annotations[0]?.id ?? ''
    nv.selectAnnotation(id)
    drag(nv, [60, 60, 0], [60, 60, 0])
    expect(nv.selectedAnnotation).toBe(id)
  }))

// External audit: on a tilted slice a bidirectional's handle drag kept slice-2D
// right angles and lengths, which are not physical there.
test('a bidirectional resized on an oblique slice stays perpendicular in mm', () =>
  withStubs(() => {
    const nv = controller('measureBidirectional', true)
    press(nv, [0, 0, 0])
    press(nv, [20, 0, 0])
    grabMode(nv)
    tile(nv, true)
    drag(nv, [20, 0, 0], [20, 10, Math.sqrt(300)])
    const ann = nv.annotations[0]
    const s = ann?.shape
    if (!s?.start2 || !s.end2) throw new Error('no short axis')
    // World vector of a slice-2D step on this plane: z = sqrt(3) y.
    const world = (
      a: { x: number; y: number },
      b: { x: number; y: number },
    ) => [b.x - a.x, b.y - a.y, Math.sqrt(3) * (b.y - a.y)]
    const u = world(s.start, s.end)
    const v = world(s.start2, s.end2)
    expect(ann?.stats?.length).toBeCloseTo(
      Math.hypot(20, 10, Math.sqrt(300)),
      5,
    )
    const cos =
      (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) /
      Math.hypot(...u) /
      Math.hypot(...v)
    expect(cos).toBeCloseTo(0, 6)
    // Re-audit: crossing arms share a centre; each polygon moves with one arm.
    expect(ann?.polygons).toHaveLength(2)
    const xs = (ann?.polygons[0]?.outer ?? []).map((p) => p.x)
    expect(Math.min(...xs)).toBeLessThan(0.5)
    expect(Math.max(...xs)).toBeGreaterThan(19.5)
  }))

// External audit: editing one arm of an erased angle rebuilt the other whole.
test('resizing one arm of an angle keeps the erased gap in the other', () =>
  withStubs(() => {
    const nv = controller('measureAngle')
    press(nv, [0, 20, 0])
    press(nv, [0, 0, 0])
    press(nv, [20, 0, 0])
    tile(nv)
    nv.model.annotation.tool = 'freehand'
    nv.model.annotation.isErasing = true
    nv.model.annotation.brushRadius = 2
    drag(nv, [-3, 10, 0], [3, 10, 0])
    const gap = { x: 0, y: 10 }
    expect(
      Annotation.hitTestAnnotationPolygon(gap, nv.annotations[0] as never),
    ).toBe(-1)
    nv.model.annotation.isErasing = false
    grabMode(nv)
    drag(nv, [20, 0, 0], [30, 0, 0])
    expect(nv.annotations[0]?.shape?.end2).toEqual({ x: 30, y: 0 })
    expect(
      Annotation.hitTestAnnotationPolygon(gap, nv.annotations[0] as never),
    ).toBe(-1)
  }))

// Re-audit: with annotation mode on, a shape the host hides must not be
// resized through the selected-handle path the grab falls back to.
test('a hidden shape stays put when its selected handle is dragged', () =>
  withStubs(() => {
    const nv = controller('measureLine')
    press(nv, [0, 0, 0])
    press(nv, [20, 0, 0])
    tile(nv)
    nv.model.annotation.isHandleGrab = true
    drag(nv, [20, 0, 0], [30, 0, 0])
    expect(nv.selectedAnnotation).toBe(nv.annotations[0]?.id ?? '')
    nv.annotationIsGrabbable = () => false
    drag(nv, [30, 0, 0], [40, 0, 0])
    expect(nv.annotations[0]?.shape?.end).toEqual({ x: 30, y: 0 })
  }))

// Contour segmentation (nv-ohif): on a tilted slice the mm depth of a press
// varies across the slice, so two overlapping strokes on it still merge.
test('overlapping shapes on one oblique slice merge', () =>
  withStubs(() => {
    const nv = controller('rectangle', true)
    nv.model.annotation.mergesOverlaps = true
    const onSlice = (x: number, y: number) => [x, y, Math.sqrt(3) * y]
    press(nv, onSlice(0, 0))
    press(nv, onSlice(10, 10))
    press(nv, onSlice(5, 5))
    press(nv, onSlice(15, 15))
    expect(nv.annotations).toHaveLength(1)
  }))

// A shape drawn wholly inside one the host locks (a locked contour segment of
// another label) stores nothing, so it records no undo step either.
test('a stroke swallowed by a locked shape records no undo step', () =>
  withStubs(() => {
    const nv = controller('rectangle')
    nv.model.annotation.mergesOverlaps = true
    press(nv, [0, 0, 0])
    press(nv, [20, 20, 0])
    nv.model.annotation.tool = 'measureLine'
    press(nv, [40, 40, 0])
    press(nv, [60, 40, 0])
    nv.model.annotation.tool = 'rectangle'
    // A host's replace appends the shape after the measurement; the store
    // puts measurements last, a reorder that is no edit.
    const rect = nv.annotations.find((a) => a.shape?.type === 'rectangle')
    if (rect) nv.replaceAnnotations([rect.id], [rect])
    const steps = nv.annotationUndoTop
    nv.annotationIsGrabbable = () => false
    nv.model.annotation.activeLabel = 2
    press(nv, [5, 5, 0])
    press(nv, [10, 10, 0])
    expect(nv.annotations).toHaveLength(2)
    expect(nv.annotationUndoTop).toBe(steps)
  }))
