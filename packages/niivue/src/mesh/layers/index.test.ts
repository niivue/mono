import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addColormap, makeLabelLut } from '@/cmap/NVCmaps'
import { log } from '@/logger'
import type { LUT, NVMeshLayer } from '@/NVTypes'
import { applyLayerColormap, loadLayerFromUrl } from './index'

// A non-label FreeSurfer INT32 volume (version 1, not a label file name).
// Max and sum are its big-endian int32 values (see mgh.test.ts).
const MGZ = join(
  import.meta.dir,
  '../../../../dev-images/images/volumes/fs',
  'brainmask-int.mgz',
)

describe('loadLayerFromUrl', () => {
  // Issue #427: the volume-format layer path called mgh.read without a name,
  // and mgh's label check ran filename.includes on undefined. The raw INT32
  // buffer was also read as float32 bits instead of converted.
  test('readsAnMgzLayerThatIsNotALabelVolume', async () => {
    const file = new File([readFileSync(MGZ)], 'brainmask-int.mgz')
    const nVert = 256 * 256 * 256
    const layer = await loadLayerFromUrl(file, nVert)
    expect(layer.values.length).toBe(nVert)
    expect(layer.nFrame4D).toBe(1)
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    // An indexed loop: for...of over 16.7M values costs ~0.3 s.
    const values = layer.values
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v > max) max = v
      sum += v
    }
    expect(max).toBe(250)
    expect(sum).toBe(109423756)
  })
})

function layer(
  colormap: string,
  values: number[],
  colormapLabel: LUT | null = null,
): NVMeshLayer {
  const v = Float32Array.from(values)
  return {
    nFrame4D: 1,
    frame4D: 0,
    calMin: 0,
    calMax: 0,
    calMinNeg: NaN,
    calMaxNeg: NaN,
    opacity: 1,
    colormap,
    colormapNegative: '',
    isColormapInverted: false,
    colormapType: 1,
    isTransparentBelowCalMin: true,
    isAdditiveBlend: false,
    isColorbarVisible: true,
    colormapLabel,
    outlineWidth: 0,
    values: v,
    globalMin: Math.min(...values),
    globalMax: Math.max(...values),
  } as NVMeshLayer
}

describe('applyLayerColormap', () => {
  // Test-only colormaps, registered under names no other test uses (the
  // registry is page-wide and has no removal). The log is silenced only while
  // they register.
  beforeAll(() => {
    const logLevel = log.level
    log.setLogLevel('silent')
    addColormap('layerRamp', { R: [0, 255], G: [0, 255], B: [0, 255] })
    // IDs 0..3, with 0 (background) transparent.
    addColormap('layerAtlas', {
      R: [0, 255, 0, 0],
      G: [0, 0, 255, 0],
      B: [0, 0, 0, 255],
      A: [0, 255, 255, 255],
      labels: ['bg', 'a', 'b', 'c'],
    })
    log.setLogLevel(logLevel)
  })

  test('aLabelTableGivesALabelLut', () => {
    const l = applyLayerColormap(layer('layerAtlas', [0, 1, 2, 3]))
    expect(l.colormapLabel).not.toBeNull()
    const lut = l.colormapLabel as LUT
    expect([lut.min, lut.max]).toEqual([0, 3])
    // Label 0 is transparent; label 2 is opaque green.
    expect(lut.lut[3]).toBe(0)
    expect(Array.from(lut.lut.slice(8, 12))).toEqual([0, 255, 0, 255])
  })

  test('theGeneratedPaletteSpansEveryLayerValue', () => {
    // Float IDs past the palette's default 0..255, as in a 360-parcel layer.
    const l = applyLayerColormap(layer('Random', [0, 17, 359]))
    const lut = l.colormapLabel as LUT
    expect(lut.min).toBe(0)
    expect(lut.max).toBeGreaterThanOrEqual(359)
    expect(lut.lut[3]).toBe(0)
  })

  test('aNaNFirstVertexDoesNotShrinkTheGeneratedPalette', () => {
    // globalMin/globalMax start from values[0], so a NaN there makes both NaN.
    const l = applyLayerColormap(layer('Random', [Number.NaN, 0, 17, 359]))
    expect((l.colormapLabel as LUT).max).toBeGreaterThanOrEqual(359)
  })

  test('aContinuousColormapClearsTheLabelLut', () => {
    const fileLut = makeLabelLut({
      R: [0, 255],
      G: [0, 0],
      B: [0, 0],
      A: [0, 255],
      I: [0, 1],
    })
    const l = applyLayerColormap(layer('layerRamp', [0, 1], fileLut))
    expect(l.colormapLabel).toBeNull()
  })

  test('anUnknownColormapClearsTheLabelLut', () => {
    const l = applyLayerColormap(
      layer(
        'noSuchMap',
        [0, 1],
        makeLabelLut({ R: [0], G: [0], B: [0], A: [0], I: [0] }),
      ),
    )
    expect(l.colormapLabel).toBeNull()
  })
})
