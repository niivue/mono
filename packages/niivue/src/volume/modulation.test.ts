import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import type { NIFTIHeader, NVImage } from '@/NVTypes'
import { computeModulationData, computeModulationWeights } from './modulation'

function makeHeader(overrides: Partial<NIFTIHeader> = {}): NIFTIHeader {
  return {
    littleEndian: true,
    dim_info: 0,
    dims: [3, 2, 2, 2, 1, 1, 1, 1],
    pixDims: [1, 1, 1, 1, 1, 0, 0, 0],
    intent_p1: 0,
    intent_p2: 0,
    intent_p3: 0,
    intent_code: 0,
    datatypeCode: NiiDataType.DT_FLOAT32,
    numBitsPerVoxel: 32,
    slice_start: 0,
    vox_offset: 352,
    scl_slope: 1,
    scl_inter: 0,
    slice_end: 0,
    slice_code: 0,
    xyzt_units: 10,
    cal_max: 0,
    cal_min: 0,
    slice_duration: 0,
    toffset: 0,
    description: '',
    aux_file: '',
    qform_code: 0,
    sform_code: 1,
    quatern_b: 0,
    quatern_c: 0,
    quatern_d: 0,
    qoffset_x: 0,
    qoffset_y: 0,
    qoffset_z: 0,
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    intent_name: '',
    magic: 'n+1',
    ...overrides,
  }
}

function makeVolume(overrides: Partial<NVImage> = {}): NVImage {
  return {
    name: 'test',
    id: 'vol1',
    hdr: makeHeader(),
    img: new Float32Array(8),
    dims: [3, 2, 2, 2],
    nVox3D: 8,
    extentsMin: [0, 0, 0],
    extentsMax: [2, 2, 2],
    calMin: 0,
    calMax: 1,
    robustMin: 0,
    robustMax: 1,
    globalMin: 0,
    globalMax: 1,
    dimsRAS: [3, 2, 2, 2],
    img2RASstep: [1, 2, 4],
    img2RASstart: [0, 0, 0],
    permRAS: [1, 2, 3],
    ...overrides,
  } as NVImage
}

describe('computeModulationData', () => {
  test('noModulationImage_setsNull', () => {
    const vol = makeVolume({ modulationImage: '' })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })

  test('undefinedModulationImage_setsNull', () => {
    const vol = makeVolume({ modulationImage: undefined })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })

  test('validModulation_producesNormalizedValues', () => {
    // Modulation source: values 0..7, calMin=0, calMax=7
    const modImg = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const modVol = makeVolume({
      id: 'mod1',
      img: modImg,
      calMin: 0,
      calMax: 7,
      frame4D: 0,
    })
    // Target vol references modVol. computeModulationData only serves RGB/RGBA
    // (V1) targets, so the target must carry an RGBA datatype (2304).
    const targetVol = makeVolume({
      id: 'target',
      modulationImage: 'mod1',
      hdr: makeHeader({ datatypeCode: 2304 }),
    })
    computeModulationData([targetVol, modVol])
    expect(targetVol._modulationData).not.toBeNull()
    const data = targetVol._modulationData ?? new Float32Array(0)
    expect(data.length).toBe(8)
    // First voxel: (0 - 0) / 7 = 0
    expect(data[0]).toBeCloseTo(0, 5)
    // Last voxel: (7 - 0) / 7 = 1
    expect(data[7]).toBeCloseTo(1, 5)
    // Mid voxel: (3 - 0) / 7 ≈ 0.4286
    expect(data[3]).toBeCloseTo(3 / 7, 4)
  })

  test('modulationImageNotFound_setsNull', () => {
    const vol = makeVolume({ modulationImage: 'nonexistent' })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })
})

describe('computeModulationWeights', () => {
  test('noModulationImage_setsNull', () => {
    const vol = makeVolume({ modulationImage: '' })
    computeModulationWeights([vol])
    expect(vol._modulationWeight).toBeNull()
    expect(vol._modulationWeightKey).toBeUndefined()
  })

  test('validModulation_producesNativeOrderWindowedWeights', () => {
    // Modulation source 0..7, windowed by calMin=0/calMax=7 -> 0..1.
    const modImg = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const modVol = makeVolume({ id: 'mod1', img: modImg, calMin: 0, calMax: 7 })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const w = targetVol._modulationWeight
    expect(w).not.toBeNull()
    expect(w?.length).toBe(8)
    // Native order (no RAS reorder), so weight[i] tracks modImg[i] directly.
    expect(w?.[0]).toBeCloseTo(0, 5)
    expect(w?.[3]).toBeCloseTo(3 / 7, 5)
    expect(w?.[7]).toBeCloseTo(1, 5)
  })

  test('windowClamps_outsideRangeTo0and1', () => {
    const modImg = new Float32Array([-5, 0, 1, 2, 3, 4, 10, 20])
    const modVol = makeVolume({ id: 'mod1', img: modImg, calMin: 0, calMax: 4 })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const w = targetVol._modulationWeight ?? new Float32Array(0)
    expect(w[0]).toBe(0) // below calMin clamps to 0
    expect(w[6]).toBe(1) // above calMax clamps to 1
    expect(w[3]).toBeCloseTo(2 / 4, 5)
  })

  test('modulateAlphaExponent_appliesPow', () => {
    const modImg = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const modVol = makeVolume({ id: 'mod1', img: modImg, calMin: 0, calMax: 7 })
    const targetVol = makeVolume({
      id: 'target',
      modulationImage: 'mod1',
      modulateAlpha: 2,
    })
    computeModulationWeights([targetVol, modVol])
    const w = targetVol._modulationWeight ?? new Float32Array(0)
    // weight = (i/7)^2
    expect(w[3]).toBeCloseTo((3 / 7) ** 2, 5)
    expect(w[7]).toBeCloseTo(1, 5)
  })

  test('cachesByKey_skipsRecompute', () => {
    const modImg = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const modVol = makeVolume({ id: 'mod1', img: modImg, calMin: 0, calMax: 7 })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const first = targetVol._modulationWeight
    computeModulationWeights([targetVol, modVol])
    expect(targetVol._modulationWeight).toBe(first) // same reference (cached)
  })

  test('modulationImageNotFound_setsNull', () => {
    const vol = makeVolume({ modulationImage: 'nonexistent' })
    computeModulationWeights([vol])
    expect(vol._modulationWeight).toBeNull()
  })

  test('sameLengthBufferSwap_recomputes (audit P2 cache key)', () => {
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      calMin: 0,
      calMax: 7,
    })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const first = targetVol._modulationWeight
    // Replace the modulator data with a DIFFERENT same-length buffer.
    modVol.img = new Float32Array([7, 6, 5, 4, 3, 2, 1, 0])
    computeModulationWeights([targetVol, modVol])
    const second = targetVol._modulationWeight ?? new Float32Array(0)
    expect(second).not.toBe(first) // recomputed (buffer identity in key)
    expect(second[0]).toBeCloseTo(1, 5) // reflects the new data, not stale
  })

  test('nanWindow_yieldsFiniteWeights (audit P3 NaN guard)', () => {
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      calMin: Number.NaN,
      calMax: Number.NaN,
    })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const w = targetVol._modulationWeight ?? new Float32Array(0)
    expect(w.every((x) => Number.isFinite(x))).toBe(true)
    expect(w[0]).toBe(1) // NaN window -> fully visible, not NaN
  })

  test('nanVoxel_finiteWindow_yieldsZeroNotNaN (audit2 P2 NaN voxel)', () => {
    // Finite window, but some voxels are NaN (processed/masked float overlay).
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, Number.NaN, 2, 3, Number.NaN, 5, 6, 7]),
      calMin: 0,
      calMax: 7,
    })
    const targetVol = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationWeights([targetVol, modVol])
    const w = targetVol._modulationWeight ?? new Float32Array(0)
    expect(w.every((x) => Number.isFinite(x))).toBe(true)
    expect(w[1]).toBe(0) // NaN voxel -> 0 (transparent), not NaN
    expect(w[4]).toBe(0)
    expect(w[7]).toBeCloseTo(1, 5) // finite voxels still correct
  })

  test('labelTarget_skipped (audit2 P3 label gating)', () => {
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      calMin: 0,
      calMax: 7,
    })
    // Label/atlas target: colormap prepass ignores modulation, so no weight.
    const labelTarget = makeVolume({
      id: 'target',
      modulationImage: 'mod1',
      colormapLabel: {
        lut: new Uint8ClampedArray([0, 0, 0, 0]),
        min: 0,
        max: 0,
      },
    })
    computeModulationWeights([labelTarget, modVol])
    expect(labelTarget._modulationWeight).toBeNull()
  })

  test('rgbaTarget_skippedByWeightsPath (audit P3 datatype gating)', () => {
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      calMin: 0,
      calMax: 7,
    })
    // RGBA target (datatypeCode 2304) uses the CPU _modulationData path instead.
    const rgbaTarget = makeVolume({
      id: 'target',
      modulationImage: 'mod1',
      hdr: makeHeader({ datatypeCode: 2304 }),
    })
    computeModulationWeights([rgbaTarget, modVol])
    expect(rgbaTarget._modulationWeight).toBeNull()
  })

  test('scalarTarget_skippedByDataPath (audit P3 datatype gating)', () => {
    const modVol = makeVolume({
      id: 'mod1',
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      calMin: 0,
      calMax: 7,
    })
    // Scalar (float32) target uses the GPU _modulationWeight path, not _modulationData.
    const scalarTarget = makeVolume({ id: 'target', modulationImage: 'mod1' })
    computeModulationData([scalarTarget, modVol])
    expect(scalarTarget._modulationData).toBeNull()
  })
})
