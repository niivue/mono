import { describe, expect, test } from 'bun:test'
import { pinchCamera } from './pinchZoom'

const min = [-100, -100, -100]
const max = [100, 100, 100]

describe('pinchCamera', () => {
  test('spreading the fingers zooms 2D by the distance ratio', () => {
    const cam = pinchCamera(
      { distance: 100, pan: [0, 0, 0, 1], scale: 1, anchorMM: [0, 0, 0] },
      200,
      min,
      max,
      false,
    )
    expect(cam.pan2Dxyzmm?.[3]).toBe(2)
    expect(cam.scaleMultiplier).toBeUndefined()
  })
  test('2D zoom is clamped and the 3D render follows when yoked', () => {
    const cam = pinchCamera(
      { distance: 100, pan: [0, 0, 0, 4], scale: 1, anchorMM: [0, 0, 0] },
      1000,
      min,
      max,
      true,
    )
    expect(cam.pan2Dxyzmm?.[3]).toBe(10)
    expect(cam.scaleMultiplier).toBe(10)
  })
  test('an off-centre anchor stays put: the pan shifts toward it', () => {
    const cam = pinchCamera(
      { distance: 100, pan: [0, 0, 0, 1], scale: 1, anchorMM: [50, 0, 0] },
      200,
      min,
      max,
      false,
    )
    expect(cam.pan2Dxyzmm?.[0]).not.toBe(0)
  })
  test('a pinch on the 3D render scales it within 0.5-2', () => {
    const pinch = { distance: 100, pan: [0, 0, 0, 1], scale: 1, anchorMM: null }
    expect(pinchCamera(pinch, 150, min, max, false)).toEqual({
      scaleMultiplier: 1.5,
    })
    expect(pinchCamera(pinch, 10, min, max, false)).toEqual({
      scaleMultiplier: 0.5,
    })
  })
})
