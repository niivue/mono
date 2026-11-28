import { describe, expect, test } from 'bun:test'
import type { DrawingChangedDetail } from '@/index'
import { UIKitDrawingSlices, type UIKitDrawingSource } from './drawingSlices'

// A 3x4x5 drawing; voxel (x, y, z) at x + 3y + 12z.
function source() {
  const target = new EventTarget()
  const img = new Uint8Array(60)
  const nv = {
    drawingVolume: { img, dimsRAS: [3, 3, 4, 5] },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as UIKitDrawingSource
  const emit = (detail: DrawingChangedDetail) =>
    target.dispatchEvent(new CustomEvent('drawingChanged', { detail }))
  return { nv, img, emit }
}

describe('UIKitDrawingSlices', () => {
  test('counts slices from a full pass, then from a box', () => {
    const { nv, img, emit } = source()
    img[2 + 3 * 1 + 12 * 1] = 1 // (2, 1, 1)
    let changes = 0
    const slices = new UIKitDrawingSlices(nv, () => changes++)
    expect(slices.runs(2)).toEqual([[1, 1]])

    img[0 + 3 * 3 + 12 * 2] = 2 // paint (0, 3, 2)
    img[2 + 3 * 1 + 12 * 1] = 0 // erase (2, 1, 1)
    emit({ action: 'stroke', box: { min: [0, 1, 1], max: [2, 3, 2] } })
    expect(changes).toBe(1)
    expect(slices.runs(0)).toEqual([[0, 0]])
    expect(slices.runs(1)).toEqual([[3, 3]])
    expect(slices.runs(2)).toEqual([[2, 2]])
  })

  test('a change outside the box waits for a boxless update', () => {
    const { nv, img, emit } = source()
    const slices = new UIKitDrawingSlices(nv)
    img[1 + 12 * 4] = 1 // (1, 0, 4), outside the box below
    emit({ action: 'stroke', box: { min: [0, 0, 0], max: [2, 3, 1] } })
    expect(slices.runs(2)).toEqual([])
    emit({ action: 'undo' })
    expect(slices.runs(2)).toEqual([[4, 4]])
    slices.destroy()
    img.fill(0)
    emit({ action: 'undo' })
    expect(slices.runs(2)).toEqual([[4, 4]])
  })
  // Review of #879: a new drawing with the same x size and voxel count kept
  // the old per-slice arrays.
  test('a drawing of other dims recounts even with a box', () => {
    const { nv, emit } = source()
    const slices = new UIKitDrawingSlices(nv)
    const img = new Uint8Array(60)
    img[0 + 3 * 4 + 15 * 3] = 1 // (0, 4, 3) on a 3x5x4 grid
    nv.drawingVolume = { img, dimsRAS: [3, 3, 5, 4] }
    emit({ action: 'stroke', box: { min: [0, 0, 0], max: [2, 4, 3] } })
    expect([slices.runs(1), slices.runs(2)]).toEqual([[[4, 4]], [[3, 3]]])
  })
})
