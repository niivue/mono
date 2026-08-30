import { describe, expect, mock, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { DRAG_MODE } from '@/NVConstants'
import type NiiVueGPU from '@/NVControlBase'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import {
  crosshairPanThresholdCssPx,
  crosshairPanThresholdPx,
  dragForCrosshairPan,
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
      _activeMeasurementScreenLine: null,
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
  }
  return {
    ctrl: ctrl as unknown as NiiVueGPU,
    raw: ctrl,
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
