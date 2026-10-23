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
  test('OVER colour composites later overlays over earlier ones', () => {
    // P = (0.6, 0, 0) * 0.6 + (0, 0.4, 0) = (0.36, 0.4, 0); rgb = P / 0.76
    expect(blend(OVERLAY_ALPHA_BLEND.OVER, OVERLAY_COLOR_BLEND.OVER)).toEqual([
      121, 134, 0, 194,
    ])
    // Colour is independent of the alpha mode
    expect(blend(OVERLAY_ALPHA_BLEND.MAX, OVERLAY_COLOR_BLEND.OVER)).toEqual([
      121, 134, 0, 153,
    ])
    // Reversed order: red now on top
    expect(
      Array.from(
        blendOverlayData(
          [green, red],
          [1, 1, 1],
          OVERLAY_ALPHA_BLEND.OVER,
          OVERLAY_COLOR_BLEND.OVER,
        ),
      ),
    ).toEqual([201, 54, 0, 194])
  })
  test('an opaque top overlay hides the ones below', () => {
    const opaqueRed = new Uint8Array([255, 0, 0, 255])
    const opaqueGreen = new Uint8Array([0, 255, 0, 255])
    expect(
      Array.from(
        blendOverlayData(
          [opaqueRed, opaqueGreen],
          [1, 1, 1],
          OVERLAY_ALPHA_BLEND.OVER,
          OVERLAY_COLOR_BLEND.OVER,
        ),
      ),
    ).toEqual([0, 255, 0, 255])
  })
  test('MAX colour keeps the brightest weighted component', () => {
    // P = (max(0.6, 0), max(0, 0.4), 0) = (0.6, 0.4, 0); alpha max 0.6
    expect(blend(OVERLAY_ALPHA_BLEND.MAX, OVERLAY_COLOR_BLEND.MAX)).toEqual([
      255, 170, 0, 153,
    ])
    // Fluorescence over brightfield: gray at full alpha, green nuclei at 0.8.
    // ADDITIVE would clip green to 255; MAX keeps it at 0.8.
    const gray = new Uint8Array([128, 128, 128, 255])
    const nuclei = new Uint8Array([0, 255, 0, 204])
    const fuse = (layers: Uint8Array[]) =>
      Array.from(
        blendOverlayData(
          layers,
          [1, 1, 1],
          OVERLAY_ALPHA_BLEND.MAX,
          OVERLAY_COLOR_BLEND.MAX,
        ),
      )
    expect(fuse([gray, nuclei])).toEqual([128, 204, 128, 255])
    // Commutative, unlike OVER
    expect(fuse([nuclei, gray])).toEqual([128, 204, 128, 255])
    // A faint near-black layer on top never darkens what is underneath
    const faint = new Uint8Array([13, 13, 13, 230])
    expect(fuse([gray, faint])).toEqual([128, 128, 128, 255])
  })
  test('empty voxels stay transparent', () => {
    expect(
      Array.from(blendOverlayData([new Uint8Array(4)], [1, 1, 1])),
    ).toEqual([0, 0, 0, 0])
  })
})
