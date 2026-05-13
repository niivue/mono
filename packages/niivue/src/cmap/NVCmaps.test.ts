import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeLabelLut, makeLut } from './NVCmaps'

type LutJson = {
  R?: unknown
  G?: unknown
  B?: unknown
  A?: unknown
  I?: unknown
  labels?: unknown
}

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number')

const expectByteValues = (values: number[]) => {
  for (const value of values) {
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(255)
  }
}

const lutDirectory = join(import.meta.dir, 'luts')
const lutFiles = readdirSync(lutDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort()

const readLut = (file: string): LutJson =>
  JSON.parse(readFileSync(join(lutDirectory, file), 'utf8')) as LutJson

// ---------------------------------------------------------------------------
// bundled colormaps
// ---------------------------------------------------------------------------
describe('bundled colormaps', () => {
  test('include colormaps ported from the original NiiVue package', () => {
    expect(lutFiles).toContain('jet.json')
    expect(lutFiles).toContain('magma.json')
    expect(lutFiles).toContain('ct_bones.json')
    expect(lutFiles).toContain('_slicer3d.json')
  })

  test.each(lutFiles)('%s has valid color stops', (file) => {
    const lut = readLut(file)
    expect(isNumberArray(lut.R)).toBe(true)
    expect(isNumberArray(lut.G)).toBe(true)
    expect(isNumberArray(lut.B)).toBe(true)
    expect(isNumberArray(lut.I)).toBe(true)
    expect(isNumberArray(lut.A)).toBe(true)

    const R = lut.R as number[]
    const G = lut.G as number[]
    const B = lut.B as number[]
    const A = lut.A as number[]
    const I = lut.I as number[]

    expect(R.length).toBeGreaterThanOrEqual(2)
    expect(G.length).toBe(R.length)
    expect(B.length).toBe(R.length)
    expect(A.length).toBe(R.length)
    expect(I.length).toBe(R.length)
    expectByteValues(R)
    expectByteValues(G)
    expectByteValues(B)
    expectByteValues(A)
    expectByteValues(I)
    expect(I[0]).toBe(0)
    if (!file.startsWith('_')) {
      expect(I[I.length - 1]).toBe(255)
    }

    for (let index = 1; index < I.length; index++) {
      expect(I[index]).toBeGreaterThan(I[index - 1] as number)
    }

    if (file.startsWith('_') || Array.isArray(lut.labels)) {
      const labelLut = makeLabelLut({ R, G, B, A, I })
      expect(labelLut.lut.length).toBeGreaterThan(0)
      expect(labelLut.min).toBe(I[0])
      expect(labelLut.max).toBe(I[I.length - 1])
    } else {
      expect(makeLut(R, G, B, A, I).length).toBe(256 * 4)
    }

    if (Array.isArray(lut.labels)) {
      expect(lut.labels.length).toBe(R.length)
    }
  })
})

// ---------------------------------------------------------------------------
// makeLut
// ---------------------------------------------------------------------------
describe('makeLut', () => {
  test('grayscale_producesLinearRamp', () => {
    // Black (0) → White (255) across full range
    const lut = makeLut([0, 255], [0, 255], [0, 255], [255, 255], [0, 255])
    expect(lut[0]).toBe(0) // R at index 0
    expect(lut[1]).toBe(0) // G at index 0
    expect(lut[2]).toBe(0) // B at index 0
    expect(lut[3]).toBe(255) // A at index 0
    // Last entry (index 255)
    const last = 255 * 4
    expect(lut[last]).toBe(255)
    expect(lut[last + 1]).toBe(255)
    expect(lut[last + 2]).toBe(255)
  })

  test('twoStops_interpolatesCorrectly', () => {
    // Red at 0, Blue at 255
    const lut = makeLut([255, 0], [0, 0], [0, 255], [255, 255], [0, 255])
    // Midpoint (index 128)
    const mid = 128 * 4
    // Should be roughly half-way between red and blue
    expect(lut[mid]).toBeGreaterThan(100) // R declining
    expect(lut[mid]).toBeLessThan(140)
    expect(lut[mid + 2]).toBeGreaterThan(100) // B increasing
    expect(lut[mid + 2]).toBeLessThan(140)
  })

  test('returns1024bytes', () => {
    const lut = makeLut([0, 255], [0, 255], [0, 255], [255, 255], [0, 255])
    expect(lut.length).toBe(256 * 4)
  })
})

// ---------------------------------------------------------------------------
// makeLabelLut
// ---------------------------------------------------------------------------
describe('makeLabelLut', () => {
  test('setsBackgroundTransparent', () => {
    const cm = {
      R: [0, 255, 0],
      G: [0, 0, 255],
      B: [0, 0, 0],
      A: undefined as unknown as number[],
      I: [0, 1, 2],
    }
    const result = makeLabelLut(cm)
    // Index 0 (background) should be transparent
    expect(result.lut[3]).toBe(0) // alpha of first entry
    // Index 1 should be opaque (default alphaFill=255)
    expect(result.lut[4 + 3]).toBe(255)
  })

  test('mismatchedArrayLengths_throws', () => {
    const cm = {
      R: [0, 255],
      G: [0],
      B: [0, 0],
      A: undefined as unknown as number[],
      I: [0, 1],
    }
    expect(() => makeLabelLut(cm)).toThrow()
  })

  test('respectsCustomAlpha', () => {
    const cm = {
      R: [0, 255],
      G: [0, 0],
      B: [0, 0],
      A: [0, 128],
      I: [0, 1],
    }
    const result = makeLabelLut(cm)
    expect(result.lut[3]).toBe(0) // index 0: custom A=0
    expect(result.lut[4 + 3]).toBe(128) // index 1: custom A=128
  })

  test('setsMinMax', () => {
    const cm = {
      R: [255, 0, 0],
      G: [0, 255, 0],
      B: [0, 0, 255],
      A: undefined as unknown as number[],
      I: [5, 6, 7],
    }
    const result = makeLabelLut(cm)
    expect(result.min).toBe(5)
    expect(result.max).toBe(7)
  })
})
