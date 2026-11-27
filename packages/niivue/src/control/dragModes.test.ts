import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { DRAG_MODE } from '@/NVConstants'
import NiiVue from '@/NVControl'
import type NiiVueGPU from '@/NVControlBase'
import type { VectorAnnotation } from '@/NVTypes'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import {
  crosshairPanThresholdCssPx,
  crosshairPanThresholdPx,
  dragForCrosshairPan,
  dragForSlice,
  handleDragRelease,
  isCrosshairPanDrag,
} from './dragModes'

type FakeCanvas = {
  width: number
  getBoundingClientRect: () => { width: number }
}

type FakeCtrlOptions = {
  canvas?: FakeCanvas | null
  withView?: boolean
}

/**
 * Minimal controller stand-in for the crosshair-pan paths. `withView` adds a
 * single 2D tile whose cached plane makes `screenSlicePick` succeed, so the
 * release handler can reach `setCrosshairPos` without a renderer.
 */
function fakeCtrl(opts: FakeCtrlOptions = {}) {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const setCrosshairPos = mock((_mm: [number, number, number]) => {})
  const drawScene = mock(() => {})
  const committed: VectorAnnotation[] = []
  const tile = {
    leftTopWidthHeight: [0, 0, 100, 100],
    mvpMatrix: mat4.create(),
    planeNormal: [0, 0, 1],
    planePoint: [0, 0, 0],
    axCorSag: 0,
  }
  const ctrl = {
    canvas: opts.canvas === undefined ? null : opts.canvas,
    view: opts.withView ? { screenSlices: [tile] } : null,
    activeTileHit: opts.withView
      ? { tileIndex: 0, isRender: false, sliceType: 0 }
      : null,
    isDragging: true,
    model: {
      scene: { pan2Dxyzmm: [0, 0, 0, 1] },
      volumes: [{}],
      tex2mm: mat4.create(),
      layout: { isRadiological: false },
      getVolumes: () => [],
      _dragOverlay: null,
      annotation: {
        activeLabel: 1,
        activeGroup: '',
        style: {
          fillColor: [1, 0, 0, 0.3],
          strokeColor: [1, 0, 0, 1],
          strokeWidth: 1,
        },
      },
    },
    dragStartXY: [10, 10] as [number, number],
    dragEndXY: [10, 10] as [number, number],
    _activeDragMode: DRAG_MODE.crosshairPan,
    _angleState: 'none',
    _pan2DxyzmmAtDragStart: [0, 0, 0, 1] as [number, number, number, number],
    _crosshairPanDidDrag: false,
    emit,
    setCrosshairPos,
    drawScene,
    _commitAnnotation: (ann: VectorAnnotation) => committed.push(ann),
  }
  return {
    ctrl: ctrl as unknown as NiiVueGPU,
    raw: ctrl,
    committed,
    emit,
    setCrosshairPos,
    drawScene,
  }
}

describe('isCrosshairPanDrag', () => {
  test('movement below the threshold is a click', () => {
    expect(isCrosshairPanDrag([0, 0], [0, 0], 4)).toBe(false)
    expect(isCrosshairPanDrag([0, 0], [3, 0], 4)).toBe(false)
    expect(isCrosshairPanDrag([0, 0], [2, 2], 4)).toBe(false)
  })

  test('movement at or beyond the threshold is a drag', () => {
    expect(isCrosshairPanDrag([0, 0], [4, 0], 4)).toBe(true)
    expect(isCrosshairPanDrag([0, 0], [0, -4], 4)).toBe(true)
    expect(isCrosshairPanDrag([0, 0], [3, 3], 4)).toBe(true)
    expect(isCrosshairPanDrag([50, 50], [45, 50], 4)).toBe(true)
  })
})

describe('crosshairPanThresholdPx', () => {
  test('falls back to the CSS threshold without a canvas', () => {
    const { ctrl } = fakeCtrl({ canvas: null })
    expect(crosshairPanThresholdPx(ctrl)).toBe(crosshairPanThresholdCssPx)
  })

  test('scales the CSS threshold by the backing-store ratio', () => {
    const { ctrl } = fakeCtrl({
      canvas: { width: 800, getBoundingClientRect: () => ({ width: 400 }) },
    })
    expect(crosshairPanThresholdPx(ctrl)).toBe(crosshairPanThresholdCssPx * 2)
  })

  test('guards against a zero-width layout box', () => {
    const { ctrl } = fakeCtrl({
      canvas: { width: 800, getBoundingClientRect: () => ({ width: 0 }) },
    })
    expect(crosshairPanThresholdPx(ctrl)).toBe(crosshairPanThresholdCssPx * 800)
  })
})

describe('dragForCrosshairPan', () => {
  test('does nothing until the threshold is crossed', () => {
    const { ctrl, raw, emit } = fakeCtrl({ withView: true })
    raw.dragEndXY = [12, 11]
    expect(dragForCrosshairPan(ctrl)).toBe(false)
    expect(raw._crosshairPanDidDrag).toBe(false)
    expect(raw.model.scene.pan2Dxyzmm).toEqual([0, 0, 0, 1])
    expect(emit).not.toHaveBeenCalled()
  })

  test('pans like DRAG_MODE.pan once the threshold is crossed', () => {
    const { ctrl, raw, emit } = fakeCtrl({ withView: true })
    raw.dragEndXY = [30, 10]
    expect(dragForCrosshairPan(ctrl)).toBe(true)
    expect(raw._crosshairPanDidDrag).toBe(true)
    expect(raw.model.scene.pan2Dxyzmm).not.toEqual([0, 0, 0, 1])
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'pan2Dxyzmm',
      value: raw.model.scene.pan2Dxyzmm,
    })
  })

  test('stays a pan after the pointer returns inside the threshold', () => {
    const { ctrl, raw } = fakeCtrl({ withView: true })
    raw._crosshairPanDidDrag = true
    raw.dragEndXY = [10, 10]
    expect(dragForCrosshairPan(ctrl)).toBe(true)
    expect(raw._crosshairPanDidDrag).toBe(true)
  })
})

/**
 * The mm position `screenSlicePickAt` yields for a canvas pixel on the fake
 * tile, so tests can assert WHICH point the crosshair was placed at.
 */
function pickAt(
  raw: ReturnType<typeof fakeCtrl>['raw'],
  px: number,
  py: number,
): [number, number, number] | null {
  const view = raw.view
  const tileHit = raw.activeTileHit
  if (!view || !tileHit) return null
  return NVSliceLayout.screenSlicePick(
    view.screenSlices as never,
    raw.model as never,
    px,
    py,
    tileHit as never,
  )
}

describe('handleDragRelease for crosshairPan', () => {
  test('a click places the crosshair at the release point', () => {
    const { ctrl, raw, setCrosshairPos } = fakeCtrl({ withView: true })
    raw.dragEndXY = [11, 10]
    handleDragRelease(ctrl)
    expect(setCrosshairPos).toHaveBeenCalledTimes(1)
    expect(raw._activeDragMode).toBe(DRAG_MODE.none)
    expect(raw._pan2DxyzmmAtDragStart).toBeNull()
    expect(raw._crosshairPanDidDrag).toBe(false)
  })

  test('press at A, release at B inside the threshold places the crosshair at B, not A', () => {
    const { ctrl, raw, setCrosshairPos } = fakeCtrl({ withView: true })
    // pointerup refreshes dragEndXY from the release coordinates, so a click
    // with no pointermove still releases at B rather than the stale press
    // point A.
    raw.dragStartXY = [10, 10]
    raw.dragEndXY = [12, 11]
    const mmAtB = pickAt(raw, 12, 11)
    const mmAtA = pickAt(raw, 10, 10)
    expect(mmAtB).not.toBeNull()
    expect(mmAtB).not.toEqual(mmAtA)
    handleDragRelease(ctrl)
    expect(setCrosshairPos).toHaveBeenCalledTimes(1)
    expect(setCrosshairPos.mock.calls[0][0]).toEqual(
      mmAtB as [number, number, number],
    )
  })

  test('press at A, no moves, release beyond the threshold does not place the crosshair', () => {
    const { ctrl, raw, setCrosshairPos } = fakeCtrl({ withView: true })
    // No pointermove ever ran, so _crosshairPanDidDrag is still false, but the
    // refreshed release point exceeded the threshold: neither a pan happened
    // nor was this a click, so the crosshair must not move.
    raw.dragStartXY = [10, 10]
    raw.dragEndXY = [40, 40]
    expect(raw._crosshairPanDidDrag).toBe(false)
    handleDragRelease(ctrl)
    expect(setCrosshairPos).not.toHaveBeenCalled()
    expect(raw._activeDragMode).toBe(DRAG_MODE.none)
  })

  test('a gesture that panned does not move the crosshair', () => {
    const { ctrl, raw, setCrosshairPos } = fakeCtrl({ withView: true })
    raw.dragEndXY = [40, 40]
    dragForCrosshairPan(ctrl)
    handleDragRelease(ctrl)
    expect(setCrosshairPos).not.toHaveBeenCalled()
    expect(raw._activeDragMode).toBe(DRAG_MODE.none)
    expect(raw._crosshairPanDidDrag).toBe(false)
  })

  test('a cancelled gesture (didDrag forced) does not move the crosshair', () => {
    const { ctrl, raw, setCrosshairPos } = fakeCtrl({ withView: true })
    // pointercancel marks the gesture as dragged before releasing.
    raw._crosshairPanDidDrag = true
    handleDragRelease(ctrl)
    expect(setCrosshairPos).not.toHaveBeenCalled()
  })
})

describe('handleDragRelease for measurement', () => {
  const release = (endXY: [number, number]) => {
    const { ctrl, raw, committed } = fakeCtrl({ withView: true })
    raw._activeDragMode = DRAG_MODE.measurement
    raw.dragEndXY = endXY
    handleDragRelease(ctrl)
    return { raw, committed }
  }

  test('a click without a drag records no measurement', () => {
    const { raw, committed } = release([10, 10])
    expect(committed).toHaveLength(0)
    expect(raw._activeDragMode).toBe(DRAG_MODE.none)
  })

  test('a drag commits a measureLine annotation with its mm length', () => {
    // 50 px of a 100 px tile spanning [-1, 1] mm.
    const { committed } = release([60, 10])
    expect(committed).toHaveLength(1)
    expect(committed[0]?.shape?.type).toBe('measureLine')
    expect(committed[0]?.stats?.length).toBeCloseTo(1)
  })
})

describe('handleDragRelease for angle', () => {
  const setup = () => {
    const { ctrl, raw, committed } = fakeCtrl({ withView: true })
    Object.assign(raw.model, {
      ui: { measureLineColor: [1, 0, 0, 1], measureTextColor: [1, 0, 0, 1] },
    })
    raw._activeDragMode = DRAG_MODE.angle
    raw._angleState = 'drawing_first_line'
    /** Press at `from`, release at `to`, as the pointer handlers do. */
    const gesture = (from: [number, number], to: [number, number]) => {
      raw._activeDragMode = DRAG_MODE.angle
      raw.dragStartXY = from
      raw.dragEndXY = to
      handleDragRelease(ctrl)
    }
    return { raw, committed, gesture }
  }

  test('a click without a drag starts no angle', () => {
    const { raw, committed, gesture } = setup()
    gesture([10, 10], [10, 10])
    expect(raw._angleState).toBe('none')
    expect(committed).toHaveLength(0)
  })

  test('a zero-length or zero-degree second arm is ignored, then a real one commits a measureAngle', () => {
    const { raw, committed, gesture } = setup()
    gesture([10, 50], [50, 50]) // first arm, vertex at (50, 50)
    expect(raw._angleState).toBe('drawing_second_line')
    gesture([50, 50], [50, 50]) // click on the vertex
    gesture([20, 50], [20, 50]) // click back along the first arm: 0 degrees
    expect(raw._angleState).toBe('drawing_second_line')
    expect(committed).toHaveLength(0)
    gesture([50, 20], [50, 20]) // click straight up: 90 degrees
    expect(raw._angleState).toBe('none')
    expect(committed).toHaveLength(1)
    expect(committed[0]?.shape?.type).toBe('measureAngle')
    expect(committed[0]?.stats?.angle).toBeCloseTo(90)
  })
})

test('dragForSlice: vertical drag steps slices, slow drags add up', () => {
  const moves: number[][] = []
  const ctrl = {
    canvas: null,
    activeTileHit: { sliceType: 1 }, // coronal: depth is y
    dragStartXY: [0, 0],
    dragEndXY: [0, 0],
    model: { getVolumes: () => [{}] },
    moveCrosshairInVox: (x: number, y: number, z: number) =>
      moves.push([x, y, z]),
  } as unknown as NiiVueGPU
  const dragTo = (y: number) => {
    ctrl.dragEndXY = [0, y]
    dragForSlice(ctrl)
  }
  for (let y = 1; y <= 9; y++) dragTo(y) // 1 px moves: steps at 4 and 8 px
  dragTo(0) // back up 8 px from the consumed start (8): two slices back
  expect(moves).toEqual([
    [0, 1, 0],
    [0, 1, 0],
    [0, -2, 0],
  ])
})

test('contrast box orders the window for a negative rescale slope', () => {
  const { ctrl, raw } = fakeCtrl({ withView: true })
  const vol = {
    img: Uint8Array.from({ length: 16 }, (_, i) => i),
    dimsRAS: [3, 4, 4, 1],
    img2RASstart: [0, 0, 0],
    img2RASstep: [1, 4, 16],
    matRAS: mat4.create(),
    hdr: { scl_slope: -2, scl_inter: 100 },
    nVox3D: 16,
    calMin: 0,
    calMax: 0,
  }
  Object.assign(raw, { _updateGLChanged: async () => {} })
  raw.model.getVolumes = () => [vol] as never
  raw._activeDragMode = DRAG_MODE.contrast
  raw.dragStartXY = [20, 20]
  raw.dragEndXY = [60, 60]
  const pick = spyOn(NVSliceLayout, 'screenSlicePick').mockImplementation(
    (_s, _m, x, y) => [x / 20, y / 20, 0],
  )
  handleDragRelease(ctrl)
  pick.mockRestore()
  // raw 5..15 -> 90..70
  expect([vol.calMin, vol.calMax]).toEqual([70, 90])
})

// Audit of the drag-mode migration: through the real commit (not a mocked
// _commitAnnotation), a drag keeps any nonzero length and measures it on the
// slice's own plane, tilted or not.
describe('a drag measurement through the real commit', () => {
  const drag = (tilt: number, start: number[], end: number[]) => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    const voxelToWorld = mat4.fromXRotation(mat4.create(), tilt)
    nv.model.volumes = [
      {
        dimsRAS: [3, 20, 20, 20],
        pixDimsRAS: [1, 1, 1, 1],
        matRAS: mat4.transpose(mat4.create(), voxelToWorld),
      },
    ] as never
    nv.model.tex2mm = voxelToWorld
    nv.model.mm2tex = mat4.invert(mat4.create(), voxelToWorld)
    nv.view = {
      screenSlices: [
        {
          leftTopWidthHeight: [0, 0, 100, 100],
          mvpMatrix: mat4.fromXRotation(mat4.create(), -tilt),
          planeNormal: [0, -Math.sin(tilt), Math.cos(tilt)],
          planePoint: [0, 0, 0],
          axCorSag: 0,
        },
      ],
    } as never
    nv.activeTileHit = { tileIndex: 0, isRender: false, sliceType: 0 } as never
    nv.isDragging = true
    nv._activeDragMode = DRAG_MODE.measurement
    nv.dragStartXY = start as never
    nv.dragEndXY = end as never
    handleDragRelease(nv)
    return nv.annotations
  }

  test('a 0.2 mm drag is kept', () => {
    const [ann] = drag(0, [10, 10], [20, 10])
    expect(ann?.stats?.length).toBeCloseTo(0.2, 6)
  })

  test('a drag on a 60 degree tilted slice keeps its world length', () => {
    const [ann] = drag(Math.PI / 3, [50, 50], [50, 0])
    expect(ann?.stats?.length).toBeCloseTo(1, 6)
  })
})
