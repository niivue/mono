import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '@/logger'
import { LABEL_LUT_WIDTH, labelLutTexels } from '@/view/NVOrient'
import {
  addColormap,
  colormapKey,
  colormapNames,
  customColormaps,
  drawingColormapNames,
  invertLut,
  isDrawingColormap,
  isGeneratedLabelColormap,
  isLabelColormap,
  labelLutFor,
  lutrgba8,
  makeLabelLut,
  makeLut,
} from './NVCmaps'

type LutJson = {
  R?: unknown
  G?: unknown
  B?: unknown
  A?: unknown
  I?: unknown
  labels?: unknown
  min?: unknown
  max?: unknown
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
    expect(lutFiles).toContain('slicer3d.json')
  })

  // lookupColorMap() carries this window so a viewer can apply it with the colormap.
  test.each(
    lutFiles.filter((file) => file.startsWith('ct_')),
  )('%s declares its Hounsfield window', (file) => {
    const { min, max } = readLut(file)
    expect(typeof min).toBe('number')
    expect(typeof max).toBe('number')
    expect(min as number).toBeLessThan(max as number)
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

    const isLabel = Array.isArray(lut.labels)
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
    // A ramp spans the whole 256-entry LUT; a label table lists its own IDs.
    if (!isLabel) {
      expect(I[I.length - 1]).toBe(255)
    }

    for (let index = 1; index < I.length; index++) {
      expect(I[index]).toBeGreaterThan(I[index - 1] as number)
    }

    if (isLabel) {
      const labelLut = makeLabelLut({ R, G, B, A, I })
      expect(labelLut.lut.length).toBeGreaterThan(0)
      expect(labelLut.min).toBe(I[0])
      expect(labelLut.max).toBe(I[I.length - 1])
    } else {
      expect(makeLut(R, G, B, A, I).length).toBe(256 * 4)
    }

    // Names are optional: an empty array still marks a label table.
    if (isLabel && (lut.labels as unknown[]).length > 0) {
      expect((lut.labels as unknown[]).length).toBe(R.length)
    }
  })

  // These were label tables before kind came from the `labels` key.
  test.each([
    'freesurfer.json',
    'itksnap.json',
    'roi_i256.json',
  ])('%s is a label table', (file) => {
    expect(Array.isArray(readLut(file).labels)).toBe(true)
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

describe('invertLut', () => {
  test('reversesColorsEndForEnd', () => {
    const lut = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const inverted = invertLut(lut)
    expect(Array.from(inverted)).toEqual([
      9, 10, 11, 4, 5, 6, 7, 8, 1, 2, 3, 12,
    ])
  })

  test('leavesTheAlphaRampInPlace', () => {
    // Index 0 must stay transparent, or every voxel below calMin would paint.
    const lut = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 255])
    const inverted = invertLut(lut)
    expect(inverted[3]).toBe(0)
    expect(inverted[7]).toBe(255)
  })

  test('leavesTheInputUntouched', () => {
    const lut = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8])
    const before = Array.from(lut)
    invertLut(lut)
    expect(Array.from(lut)).toEqual(before)
  })

  test('isItsOwnInverse', () => {
    const lut = makeLut([0, 255], [0, 128], [255, 0], [255, 255], [0, 255])
    expect(Array.from(invertLut(invertLut(lut)))).toEqual(Array.from(lut))
  })

  test('lutrgba8AppliesTheInversionOnRequest', () => {
    // The LUT registry needs `import.meta.glob`, which Bun does not provide, so
    // every name resolves to the built-in gray fallback here. That is enough to
    // check the `invert` argument is threaded through: the fallback is a real
    // 256-entry ramp.
    log.setLogLevel('silent')
    const plain = lutrgba8('gray')
    const inverted = lutrgba8('gray', true)
    log.setLogLevel('info')
    expect(Array.from(inverted)).toEqual(Array.from(invertLut(plain)))
    // Gray ramps dark to light, so inverting swaps the ends.
    expect(inverted[0]).toBe(plain[plain.length - 4])
  })
})

// ---------------------------------------------------------------------------
// colormapKey
// ---------------------------------------------------------------------------
describe('colormapKey', () => {
  // The orient caches key their colormap textures on this, so re-registering a
  // name must change it, or a volume keeps drawing the replaced colors.
  log.setLogLevel('silent')
  const red = { R: [0, 255], G: [0, 0], B: [0, 0] }
  const green = { R: [0, 0], G: [0, 255], B: [0, 0] }

  test('isEmptyForNoColormap', () => {
    expect(colormapKey(undefined)).toBe('')
    expect(colormapKey('')).toBe('')
  })

  test('isStableUntilTheNameIsReRegistered', () => {
    addColormap('keyTestA', red)
    const first = colormapKey('keyTestA')
    expect(colormapKey('keyTestA')).toBe(first)
    addColormap('keyTestA', green)
    expect(colormapKey('keyTestA')).not.toBe(first)
  })

  test('tracksTheCanonicalName', () => {
    // addColormap upper-cases the first letter, so both spellings resolve to
    // the same entry and a re-registration under either moves both keys.
    const lower = colormapKey('keyTestB')
    const upper = colormapKey('KeyTestB')
    addColormap('KeyTestB', red)
    expect(colormapKey('keyTestB')).not.toBe(lower)
    expect(colormapKey('KeyTestB')).not.toBe(upper)
  })

  test('leavesOtherNamesAlone', () => {
    const other = colormapKey('keyTestC')
    addColormap('keyTestD', red)
    expect(colormapKey('keyTestC')).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// colormap kinds
// ---------------------------------------------------------------------------
describe('colormap kinds', () => {
  // Bun has no import.meta.glob, so the registry holds only runtime colormaps
  // and the generated Random palette here.
  log.setLogLevel('silent')
  addColormap('kindRamp', { R: [0, 255], G: [0, 255], B: [0, 255] })
  addColormap('kindAtlas', {
    R: [0, 255, 0],
    G: [0, 0, 255],
    B: [0, 0, 0],
    labels: ['air', 'left', 'right'],
  })
  addColormap('kindWide', {
    R: [0, 9],
    G: [0, 9],
    B: [0, 9],
    I: [0, 2035],
    labels: [],
  })

  test('aLabelsArrayMakesALabelColormap', () => {
    expect(isLabelColormap('kindAtlas')).toBe(true)
    expect(isLabelColormap('kindRamp')).toBe(false)
    expect(isLabelColormap('Random')).toBe(true)
    expect(isLabelColormap('noSuchMap')).toBe(false)
  })

  test('namesFilterByKind', () => {
    expect(colormapNames('label')).toContain('KindAtlas')
    expect(colormapNames('label')).not.toContain('KindRamp')
    expect(colormapNames('continuous')).toContain('KindRamp')
    expect(colormapNames()).toEqual(
      expect.arrayContaining(['KindAtlas', 'KindRamp']),
    )
  })

  test('aLabelTableDefaultsItsIndicesToItsEntries', () => {
    const lut = labelLutFor('kindAtlas')
    expect(lut?.min).toBe(0)
    expect(lut?.max).toBe(2)
    expect(lut?.labels).toEqual(['air', 'left', 'right'])
  })

  test('aLabelTableKeepsIdZeroTransparentByDefault', () => {
    const lut = labelLutFor('kindAtlas')
    expect(lut?.lut[3]).toBe(0)
    expect(lut?.lut[7]).toBe(255)
  })

  test('aLabelTableMayHoldASingleEntry', () => {
    expect(() =>
      addColormap('kindOne', { R: [255], G: [0], B: [0], labels: ['mask'] }),
    ).not.toThrow()
    expect(() =>
      addColormap('kindRampOne', { R: [255], G: [0], B: [0] }),
    ).toThrow()
  })

  test('drawingsTakeLabelTablesWithIdsUpTo255', () => {
    addColormap('kindNegative', {
      R: [0, 255],
      G: [0, 0],
      B: [0, 0],
      I: [-1, 0],
      labels: ['below', 'air'],
    })
    expect(isDrawingColormap('kindNegative')).toBe(false)
    expect(isDrawingColormap('kindAtlas')).toBe(true)
    expect(isDrawingColormap('kindWide')).toBe(false)
    expect(isDrawingColormap('kindRamp')).toBe(false)
    expect(drawingColormapNames()).toContain('KindAtlas')
    expect(drawingColormapNames()).not.toContain('KindWide')
  })

  test('aLabelTableSpanIsCappedSoAFewEntriesCannotAskForGigabytes', () => {
    const wide = (hi: number) => () =>
      addColormap('kindHuge', {
        R: [0, 0],
        G: [0, 0],
        B: [0, 0],
        I: [0, hi],
        labels: [],
      })
    expect(wide(300_000_000)).toThrow()
    expect(wide(300_000)).not.toThrow()
    expect(wide(Number.NaN)).not.toThrow() // span comes from the finite ID
    const allNaN = () =>
      addColormap('kindNaN', {
        R: [0],
        G: [0],
        B: [0],
        I: [Number.NaN],
        labels: [],
      })
    expect(allNaN).toThrow()
  })

  test('aDenseTableTooLargeToSpreadStillListsDrawingColormaps', () => {
    const n = 2_000_000 // past Bun's argument limit (V8 throws near 120k)
    const ids = Array.from({ length: n }, (_, i) => i)
    addColormap('kindDense', { R: ids, G: ids, B: ids, labels: [] })
    expect(drawingColormapNames()).not.toContain('KindDense')
  })

  test('aContinuousColormapHasNoLabelLut', () => {
    expect(labelLutFor('kindRamp')).toBeNull()
    expect(labelLutFor(undefined)).toBeNull()
  })

  test('onlyRuntimeColormapsAreCustom', () => {
    const custom = customColormaps()
    expect(Object.keys(custom)).toContain('KindAtlas')
    expect(Object.keys(custom)).not.toContain('Random')
  })
})

// ---------------------------------------------------------------------------
// generated Random palette
// ---------------------------------------------------------------------------
describe('Random palette', () => {
  test('aNaNRangeDoesNotThrow', () => {
    expect(labelLutFor('Random', [Number.NaN, Number.NaN])?.max).toBe(255)
  })

  test('coversIds0To255WhateverTheRange', () => {
    // A segmentation can add IDs above the ones the file held at load.
    const lut = labelLutFor('Random', [0, 3])
    expect(lut?.min).toBe(0)
    expect(lut?.max).toBe(255)
    expect(lut?.lut[4 * 200 + 3]).toBe(255)
  })

  test('isGeneratedLabelColormapNamesOnlyTheRandomPalette', () => {
    expect(isGeneratedLabelColormap('random')).toBe(true)
    expect(isGeneratedLabelColormap('gray')).toBe(false)
    expect(isGeneratedLabelColormap(undefined)).toBe(false)
  })

  test('spansTheVolumeRangeSoEveryIdHasAColour', () => {
    // FreeSurfer aparc+aseg: cortical parcels run past 2000.
    const lut = labelLutFor('Random', [0, 2035])
    expect(lut?.min).toBe(0)
    expect(lut?.max).toBe(2035)
    const alpha = (id: number) => lut?.lut[4 * id + 3]
    expect(alpha(0)).toBe(0)
    expect(alpha(2035)).toBe(255)
  })

  test('givesAnIdTheSameColourWhateverTheRange', () => {
    const a = labelLutFor('Random', [0, 50])
    const b = labelLutFor('Random', [0, 3000])
    expect(Array.from(a?.lut.slice(4 * 17, 4 * 18) ?? [])).toEqual(
      Array.from(b?.lut.slice(4 * 17, 4 * 18) ?? []),
    )
  })

  test('handlesRangesPastTheSpreadArgumentLimit', () => {
    const lut = labelLutFor('Random', [0, 500_000])
    expect(lut?.max).toBe(500_000)
  })
})

// ---------------------------------------------------------------------------
// label LUT texture layout
// ---------------------------------------------------------------------------
describe('labelLutTexels', () => {
  test('wrapsIntoRowsSoWideRangesFitAnyGpu', () => {
    const n = 16_000
    const texels = labelLutTexels(new Uint8ClampedArray(n * 4).fill(7))
    expect(texels.width).toBe(LABEL_LUT_WIDTH)
    expect(texels.height).toBe(Math.ceil(n / LABEL_LUT_WIDTH))
    expect(texels.data.length).toBe(texels.width * texels.height * 4)
    // Entry i sits at column i % width, row i / width.
    const i = 300
    expect(texels.data[4 * i]).toBe(7)
    expect(texels.data[4 * n]).toBe(0)
  })

  test('aSmallTableIsOneRow', () => {
    expect(labelLutTexels(new Uint8ClampedArray(8 * 4)).height).toBe(1)
  })
})
