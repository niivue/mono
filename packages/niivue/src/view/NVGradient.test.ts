import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  GRAD_EPS,
  GRAD_SCALE,
  GRAD_SHIFT,
  GRADIENT_SOURCE_CHANNEL,
  SOBEL_RADIUS,
} from './NVGradient'

/**
 * These constants define the gradient texture's encoding, and BOTH backends
 * read them: gl/gradient.ts interpolates them into its GLSL, wgpu/sobel.wgsl
 * takes them as pipeline-overridable constants. Changing one without the other
 * makes WebGL2 and WebGPU render the same volume differently, which is the
 * exact bug this module exists to prevent -- so the values are pinned here.
 */
describe('gradient encoding constants', () => {
  test('the magnitude encoding maps the noise floor to 0', () => {
    // GRAD_EPS is the squared gradient of a single 8-bit intensity level.
    const encode = (g2: number): number =>
      (Math.log2(g2 + GRAD_EPS) + GRAD_SHIFT) * GRAD_SCALE
    expect(encode(0)).toBeCloseTo(0, 12)
  })

  test('the magnitude encoding maps full scale to 1', () => {
    // Each axis is a difference of two [0,1] samples, so a squared gradient of
    // 3 is the largest value three axes can produce.
    const encode = (g2: number): number =>
      (Math.log2(g2 + GRAD_EPS) + GRAD_SHIFT) * GRAD_SCALE
    // Fractionally over 1 (by ~4e-7) because the eps sits inside the log but
    // not in GRAD_SCALE's derivation. Both backends store to rgba8unorm, which
    // clamps, so they overshoot identically and it never reaches a render.
    expect(encode(3)).toBeCloseTo(1, 5)
  })

  test('the encoding is monotonic and stays inside the rgba8 range', () => {
    const encode = (g2: number): number =>
      (Math.log2(g2 + GRAD_EPS) + GRAD_SHIFT) * GRAD_SCALE
    let prev = -Infinity
    for (const g2 of [0, 1e-6, 1e-4, 1e-2, 0.1, 0.5, 1, 2, 3]) {
      const v = encode(g2)
      expect(v).toBeGreaterThan(prev)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1 + 1e-6)
      prev = v
    }
  })

  test('the corner tap offset is fractional, so the linear sampler blends it', () => {
    expect(SOBEL_RADIUS).toBe(0.7)
    expect(Number.isInteger(SOBEL_RADIUS)).toBe(false)
  })

  test('both backends differentiate the colormapped alpha channel', () => {
    // Not red: a LUT's alpha ramp is monotonic in intensity for every
    // colormap, its colour channels are not (hot saturates red at 37%).
    expect(GRADIENT_SOURCE_CHANNEL).toBe('a')
  })
})

/**
 * The two shaders are text, not code this module can import, so nothing stops
 * an edit to one from silently diverging from the other. These read the
 * sources and assert the properties that must hold on both.
 */
describe('the two backends run the same estimator', () => {
  const wgsl = readFileSync(
    new URL('../wgpu/sobel.wgsl', import.meta.url),
    'utf8',
  )
  const glsl = readFileSync(
    new URL('../gl/gradient.ts', import.meta.url),
    'utf8',
  )

  test('wgsl takes the shared constants as overrides, not literals', () => {
    for (const name of ['sobelRadius', 'gradEps', 'gradShift', 'gradScale']) {
      expect(wgsl).toContain(`override ${name}: f32;`)
    }
  })

  test('pass 1 taps alpha, pass 2 taps the blurred temp', () => {
    const tapRe = /texture(?:SampleLevel)?\((?:[^()]|\([^()]*\))*\)\.([rgba])/g
    for (const src of [wgsl, glsl]) {
      const taps = [...src.matchAll(tapRe)].map((m) => m[1])
      // One blur tap on the source, one sobel tap on the blurred temp.
      expect(taps).toEqual([GRADIENT_SOURCE_CHANNEL, 'r'])
    }
  })

  test('the glsl side imports the constants instead of redefining them', () => {
    expect(glsl).toContain("from '@/view/NVGradient'")
    expect(glsl).not.toMatch(/^const (GRAD_EPS|GRAD_SHIFT|GRAD_SCALE) =/m)
    expect(glsl).not.toMatch(/^\s*const sobelRadius =/m)
  })
})
