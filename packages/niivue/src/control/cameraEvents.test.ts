import { describe, expect, mock, test } from 'bun:test'
import type NiiVueGPU from '@/NVControlBase'
import {
  applyPanFollowsCrosshair,
  emitOrientationChange,
  emitPan2DChange,
  emitScaleMultiplierChange,
} from './cameraEvents'

type Scene = {
  azimuth?: number
  elevation?: number
  scaleMultiplier?: number
  pan2Dxyzmm?: [number, number, number, number]
  crosshairPos?: [number, number, number]
}

function fakeCtrl(scene: Scene) {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const ctrl = { model: { scene }, emit } as unknown as NiiVueGPU
  return { ctrl, emit }
}

/**
 * Fake controller with enough model for applyPanFollowsCrosshair: symmetric
 * [-90, 90] mm extents and the model's linear scene-fraction interpolation.
 */
function fakeFollowCtrl(
  pan2Dxyzmm: [number, number, number, number],
  crosshairPos: [number, number, number],
  isPanFollowingCrosshair: boolean,
) {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const extentsMin = [-90, -90, -90]
  const extentsMax = [90, 90, 90]
  const model = {
    scene: { pan2Dxyzmm, crosshairPos },
    interaction: { isPanFollowingCrosshair },
    extentsMin,
    extentsMax,
    scene2mm: (frac: number[]) =>
      frac.map((f, i) => extentsMin[i] + f * (extentsMax[i] - extentsMin[i])),
  }
  const ctrl = { model, emit } as unknown as NiiVueGPU
  return { ctrl, emit, pan: pan2Dxyzmm }
}

describe('camera interaction events', () => {
  test('emitOrientationChange mirrors the azimuth/elevation setters', () => {
    const { ctrl, emit } = fakeCtrl({ azimuth: 110, elevation: 10 })
    emitOrientationChange(ctrl)
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit).toHaveBeenNthCalledWith(1, 'azimuthElevationChange', {
      azimuth: 110,
      elevation: 10,
    })
    expect(emit).toHaveBeenNthCalledWith(2, 'change', {
      property: 'azimuth',
      value: 110,
    })
    expect(emit).toHaveBeenNthCalledWith(3, 'change', {
      property: 'elevation',
      value: 10,
    })
  })

  test('emitScaleMultiplierChange emits a scaleMultiplier change', () => {
    const { ctrl, emit } = fakeCtrl({ scaleMultiplier: 1.5 })
    emitScaleMultiplierChange(ctrl)
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'scaleMultiplier',
      value: 1.5,
    })
  })

  test('emitPan2DChange emits a pan2Dxyzmm change', () => {
    const { ctrl, emit } = fakeCtrl({ pan2Dxyzmm: [1, 2, 3, 4] })
    emitPan2DChange(ctrl)
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'pan2Dxyzmm',
      value: [1, 2, 3, 4],
    })
  })
})

describe('applyPanFollowsCrosshair', () => {
  // Fraction 1 on x maps to +90 mm; at zoom 2 the visible x window with zero
  // pan is [-45, 45], so this crosshair is off-window on x only.
  const offWindowX: [number, number, number] = [1, 0.5, 0.5]

  test('optionOffLeavesThePanUntouchedAndEmitsNothing', () => {
    const { ctrl, emit, pan } = fakeFollowCtrl([0, 0, 0, 2], offWindowX, false)
    expect(applyPanFollowsCrosshair(ctrl)).toBe(false)
    expect(pan).toEqual([0, 0, 0, 2])
    expect(emit).not.toHaveBeenCalled()
  })

  test('zoomAtOrBelowOneLeavesThePanUntouched', () => {
    for (const zoom of [1, 0.5]) {
      const { ctrl, emit, pan } = fakeFollowCtrl(
        [40, 0, 0, zoom],
        offWindowX,
        true,
      )
      expect(applyPanFollowsCrosshair(ctrl)).toBe(false)
      expect(pan).toEqual([40, 0, 0, zoom])
      expect(emit).not.toHaveBeenCalled()
    }
  })

  test('visibleCrosshairLeavesThePanUntouched', () => {
    const { ctrl, emit, pan } = fakeFollowCtrl(
      [0, 0, 0, 2],
      [0.6, 0.5, 0.5],
      true,
    )
    expect(applyPanFollowsCrosshair(ctrl)).toBe(false)
    expect(pan).toEqual([0, 0, 0, 2])
    expect(emit).not.toHaveBeenCalled()
  })

  test('offWindowCrosshairPansMinimallyAndEmitsThePanChange', () => {
    const { ctrl, emit, pan } = fakeFollowCtrl([0, 0, 0, 2], offWindowX, true)
    expect(applyPanFollowsCrosshair(ctrl)).toBe(true)
    // Crosshair at +90 mm, window edge at +45 mm: minimal move is -45 on x,
    // mutated in place so the renderer sees it on the caller's redraw.
    expect(pan).toEqual([-45, 0, 0, 2])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('change', {
      property: 'pan2Dxyzmm',
      value: pan,
    })
  })
})
