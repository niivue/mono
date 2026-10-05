import { describe, expect, test } from 'bun:test'
import { OVERLAY_ALPHA_BLEND, OVERLAY_COLOR_BLEND } from '@/NVConstants'
import { blendOverlayData } from '@/volume/overlayBlend'

// One voxel: pure red at alpha 0.6 and pure green at alpha 0.4 (fractions
// summing to 1, like two tissue maps).
const red = new Uint8Array([255, 0, 0, 153])
const green = new Uint8Array([0, 255, 0, 102])
const blend = (alpha: number, color: number) =>
  Array.from(blendOverlayData([red, green], [1, 1, 1], alpha, color))

describe('blendOverlayData', () => {
  test('MAX + ADDITIVE keeps the legacy result', () => {
    // alpha = max = 0.6; rgb = (0.6, 0.4) / 0.6
    expect(
      blend(OVERLAY_ALPHA_BLEND.MAX, OVERLAY_COLOR_BLEND.ADDITIVE),
    ).toEqual([255, 170, 0, 153])
  })
  test('ADDITIVE alpha makes fractions summing to 1 opaque', () => {
    expect(
      blend(OVERLAY_ALPHA_BLEND.ADDITIVE, OVERLAY_COLOR_BLEND.ADDITIVE),
    ).toEqual([153, 102, 0, 255])
  })
  test('OVER alpha is the union 1 - (1-a)(1-b)', () => {
    // 1 - 0.4 * 0.6 = 0.76; MEAN colour = (0.6, 0.4)
    expect(blend(OVERLAY_ALPHA_BLEND.OVER, OVERLAY_COLOR_BLEND.MEAN)).toEqual([
      153, 102, 0, 194,
    ])
  })
  test('empty voxels stay transparent', () => {
    expect(
      Array.from(blendOverlayData([new Uint8Array(4)], [1, 1, 1])),
    ).toEqual([0, 0, 0, 0])
  })
})
