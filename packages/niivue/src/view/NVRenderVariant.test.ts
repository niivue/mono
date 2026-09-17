import { describe, expect, test } from 'bun:test'
import {
  GENERIC_RENDER_VARIANT,
  type RenderVariantState,
  renderVariantConstants,
  renderVariantDefines,
  renderVariantKey,
} from './NVRenderVariant'

const idle: RenderVariantState = {
  clipPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 2]).flat(),
  isClipCutaway: false,
  renderMode: 0,
  cubic: false,
  gradientAmount: 0,
  gradientOpacity: 0,
  silhouette: 0,
  hasOverlay: false,
  hasPaqd: false,
  hasDrawing: false,
}

describe('renderVariantKey', () => {
  test('a plain draw clears every flag', () => {
    expect(renderVariantKey(idle)).toBe(0)
  })

  test('any plane with |depth| <= 1 enables clipping', () => {
    const clipPlanes = Array.from(idle.clipPlanes)
    clipPlanes[4 * 5 + 3] = -1
    expect(renderVariantKey({ ...idle, clipPlanes })).toBe(1)
  })

  test('clip depths are judged as the shader sees them', () => {
    for (const depth of [Number.NaN, 1 + 1e-10]) {
      const clipPlanes = Array.from(idle.clipPlanes)
      clipPlanes[3] = depth
      expect(renderVariantKey({ ...idle, clipPlanes })).toBe(1)
    }
  })

  test('each feature sets its own bit and never CHUNKED', () => {
    const key = renderVariantKey({
      ...idle,
      isClipCutaway: true,
      renderMode: 1,
      cubic: true,
      silhouette: 0.5,
      hasOverlay: true,
      hasPaqd: true,
      hasDrawing: true,
    })
    expect(renderVariantConstants(key)).toEqual({
      ...renderVariantConstants(GENERIC_RENDER_VARIANT),
      HAS_CLIP: 0,
      CHUNKED: 0,
    })
  })
})

test('GLSL defines mirror the key', () => {
  const src = renderVariantDefines(GENERIC_RENDER_VARIANT & ~1)
  expect(src).toContain('#define HAS_CLIP false\n')
  expect(src).toContain('#define CHUNKED true\n')
})
