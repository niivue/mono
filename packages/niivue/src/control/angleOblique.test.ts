import { expect, spyOn, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { generateShape } from '@/annotation/index'
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
    // A released resize still records one.
    select()
    at('pointerdown')
    at('pointerup')
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
