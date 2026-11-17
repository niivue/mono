import { describe, expect, spyOn, test } from 'bun:test'
import { log } from '@/logger'
import { calculateRAS, vox2mm } from '@/math/NVTransforms'
import { NiiDataType } from '@/NVConstants'
import type { NIFTIHeader, NVImage } from '@/NVTypes'
import {
  buildPaqdLut256,
  calMinMax,
  createNiftiArray,
  createNiftiHeader,
  ensureValidNonZero,
  extractVoxelFid,
  framesInImage,
  getBitsPerVoxel,
  getTypedArrayConstructor,
  getVoxelValue,
  hdrToArrayBuffer,
  isSameGrid,
  remapDrawingToRAS,
  reorientDrawingToNative,
  reorientDrawingToRAS,
  residentPickSampler,
  robustDisplayWindow,
  robustMinMax,
  temporalUnitScale,
  toTypedView,
  toTypedViewOrU8,
  volumeTR,
  voxelSizeMM,
  warnMixedUnits,
} from './utils'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalHeader(overrides: Partial<NIFTIHeader> = {}): NIFTIHeader {
  return {
    littleEndian: true,
    dim_info: 0,
    dims: [3, 4, 4, 4, 1, 1, 1, 1],
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

function makeMinimalVolume(overrides: Partial<NVImage> = {}): NVImage {
  return {
    name: 'test',
    hdr: makeMinimalHeader(),
    img: new Float32Array(64),
    dims: [3, 4, 4, 4],
    nVox3D: 64,
    extentsMin: [0, 0, 0] as unknown as import('gl-matrix').vec3,
    extentsMax: [4, 4, 4] as unknown as import('gl-matrix').vec3,
    calMin: 0,
    calMax: 1,
    robustMin: 0,
    robustMax: 1,
    globalMin: 0,
    globalMax: 1,
    dimsRAS: [3, 4, 4, 4],
    img2RASstep: [1, 4, 16],
    img2RASstart: [0, 0, 0],
    permRAS: [1, 2, 3],
    ...overrides,
  } as NVImage
}

// ---------------------------------------------------------------------------
// temporalUnitScale / volumeTR
// ---------------------------------------------------------------------------
describe('temporalUnitScale', () => {
  test('seconds_code8_returns1', () => {
    expect(temporalUnitScale(8)).toBe(1)
  })
  test('milliseconds_code16_returns1e-3', () => {
    expect(temporalUnitScale(16)).toBe(1e-3)
  })
  test('microseconds_code24_returns1e-6', () => {
    expect(temporalUnitScale(24)).toBe(1e-6)
  })
  test('spatialBitsIgnored_combinedUnits', () => {
    // xyzt_units = mm(2) | sec(8) = 10 -> seconds
    expect(temporalUnitScale(10)).toBe(1)
    // mm(2) | msec(16) = 18 -> milliseconds
    expect(temporalUnitScale(18)).toBe(1e-3)
  })
  test('unspecified_returns1', () => {
    expect(temporalUnitScale(0)).toBe(1)
  })
})

describe('volumeTR', () => {
  test('secondsHeader_returnsPixdim4', () => {
    const vol = makeMinimalVolume({
      hdr: makeMinimalHeader({
        pixDims: [1, 1, 1, 1, 2.01, 0, 0, 0],
        xyzt_units: 10, // mm | sec
      }),
    })
    expect(volumeTR(vol)).toBeCloseTo(2.01, 5)
  })
  test('millisecondsHeader_scaledToSeconds', () => {
    const vol = makeMinimalVolume({
      hdr: makeMinimalHeader({
        pixDims: [1, 1, 1, 1, 2010, 0, 0, 0],
        xyzt_units: 2 | 16, // mm | msec
      }),
    })
    expect(volumeTR(vol)).toBeCloseTo(2.01, 5)
  })
  test('microsecondsHeader_scaledToSeconds', () => {
    const vol = makeMinimalVolume({
      hdr: makeMinimalHeader({
        pixDims: [1, 1, 1, 1, 2_010_000, 0, 0, 0],
        xyzt_units: 2 | 24, // mm | usec
      }),
    })
    expect(volumeTR(vol)).toBeCloseTo(2.01, 5)
  })
  test('unsetPixdim_returns1', () => {
    const vol = makeMinimalVolume({
      hdr: makeMinimalHeader({ pixDims: [1, 1, 1, 1, 0, 0, 0, 0] }),
    })
    expect(volumeTR(vol)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// ensureValidNonZero
// ---------------------------------------------------------------------------
describe('ensureValidNonZero', () => {
  test('0_returns1', () => {
    expect(ensureValidNonZero(0)).toBe(1)
  })

  test('Infinity_returns1', () => {
    expect(ensureValidNonZero(Infinity)).toBe(1)
  })

  test('NegInfinity_returns1', () => {
    expect(ensureValidNonZero(-Infinity)).toBe(1)
  })

  test('NaN_returns1', () => {
    expect(ensureValidNonZero(NaN)).toBe(1)
  })

  test('42_returns42', () => {
    expect(ensureValidNonZero(42)).toBe(42)
  })

  test('negative_returnsItself', () => {
    expect(ensureValidNonZero(-3.5)).toBe(-3.5)
  })
})

// ---------------------------------------------------------------------------
// getTypedArrayConstructor
// ---------------------------------------------------------------------------
describe('getTypedArrayConstructor', () => {
  test('DT_FLOAT32_returnsFloat32Array', () => {
    expect(getTypedArrayConstructor(NiiDataType.DT_FLOAT32)).toBe(Float32Array)
  })

  test('DT_UINT8_returnsUint8Array', () => {
    expect(getTypedArrayConstructor(NiiDataType.DT_UINT8)).toBe(Uint8Array)
  })

  test('DT_INT16_returnsInt16Array', () => {
    expect(getTypedArrayConstructor(NiiDataType.DT_INT16)).toBe(Int16Array)
  })

  test('unknownCode_returnsNull', () => {
    expect(getTypedArrayConstructor(9999)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getBitsPerVoxel
// ---------------------------------------------------------------------------
describe('getBitsPerVoxel', () => {
  test('DT_UINT8_returns8', () => {
    expect(getBitsPerVoxel(NiiDataType.DT_UINT8)).toBe(8)
  })

  test('DT_FLOAT64_returns64', () => {
    expect(getBitsPerVoxel(NiiDataType.DT_FLOAT64)).toBe(64)
  })

  test('DT_RGB24_returns24', () => {
    expect(getBitsPerVoxel(NiiDataType.DT_RGB24)).toBe(24)
  })

  test('unknownCode_returns0', () => {
    expect(getBitsPerVoxel(9999)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// calMinMax
// ---------------------------------------------------------------------------
describe('calMinMax', () => {
  test('uniformData_returnsEqualMinMax', () => {
    const hdr = makeMinimalHeader({ dims: [3, 2, 2, 2, 1, 1, 1, 1] })
    const img = new Float32Array(8).fill(5)
    const [rMin, rMax, gMin, gMax] = calMinMax(hdr, img)
    expect(gMin).toBe(5)
    expect(gMax).toBe(5)
    expect(rMin).toBe(5)
    expect(rMax).toBe(5)
  })

  test('rampData_returnsCorrectRange', () => {
    const hdr = makeMinimalHeader({
      dims: [3, 10, 10, 10, 1, 1, 1, 1],
    })
    const img = new Float32Array(1000)
    for (let i = 0; i < 1000; i++) img[i] = i
    const [_rMin, _rMax, gMin, gMax] = calMinMax(hdr, img)
    expect(gMin).toBe(0)
    expect(gMax).toBe(999)
  })

  test('calMinCalMaxSet_usesHeaderValues', () => {
    const hdr = makeMinimalHeader({
      dims: [3, 10, 10, 10, 1, 1, 1, 1],
      cal_min: 100,
      cal_max: 900,
    })
    const img = new Float32Array(1000)
    for (let i = 0; i < 1000; i++) img[i] = i
    const [rMin, rMax] = calMinMax(hdr, img)
    expect(rMin).toBe(100)
    expect(rMax).toBe(900)
  })

  test('sclSlope_appliedToRange', () => {
    const hdr = makeMinimalHeader({
      dims: [3, 2, 2, 2, 1, 1, 1, 1],
      scl_slope: 2,
      scl_inter: 10,
    })
    const img = new Float32Array(8).fill(5)
    const [_rMin, _rMax, gMin, gMax] = calMinMax(hdr, img)
    // 5 * 2 + 10 = 20
    expect(gMin).toBe(20)
    expect(gMax).toBe(20)
  })
})

describe('robustMinMax', () => {
  test('matchesCalMinMaxOnTheSameSamples', () => {
    const hdr = makeMinimalHeader({ dims: [3, 10, 10, 10, 1, 1, 1, 1] })
    const img = Float32Array.from({ length: 1000 }, (_, i) => (i % 7) * i)
    img[3] = Number.NaN
    expect(robustMinMax(img)).toEqual(calMinMax(hdr, img))
  })

  test('nullWithoutFiniteValues', () => {
    expect(robustMinMax(Float32Array.from([Number.NaN]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createNiftiHeader
// ---------------------------------------------------------------------------
describe('createNiftiHeader', () => {
  test('setsCorrectDims', () => {
    const hdr = createNiftiHeader(
      [64, 64, 32],
      [1, 1, 2],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
      NiiDataType.DT_FLOAT32,
    )
    expect(hdr.dims[1]).toBe(64)
    expect(hdr.dims[2]).toBe(64)
    expect(hdr.dims[3]).toBe(32)
    expect(hdr.pixDims[1]).toBe(1)
    expect(hdr.pixDims[3]).toBe(2)
    expect(hdr.datatypeCode).toBe(NiiDataType.DT_FLOAT32)
  })
})

// ---------------------------------------------------------------------------
// hdrToArrayBuffer
// ---------------------------------------------------------------------------
describe('hdrToArrayBuffer', () => {
  test('sizeof_hdr_field_is348', () => {
    const hdr = createNiftiHeader(
      [10, 10, 10],
      [1, 1, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      NiiDataType.DT_UINT8,
    )
    const buf = hdrToArrayBuffer(hdr)
    const view = new DataView(buf.buffer)
    expect(view.getInt32(0, true)).toBe(348)
  })
})

// ---------------------------------------------------------------------------
// createNiftiArray
// ---------------------------------------------------------------------------
describe('createNiftiArray', () => {
  test('headerOnly_returnsHeaderBytes', () => {
    const arr = createNiftiArray([4, 4, 4], [1, 1, 1])
    // No image data → just header (348 bytes)
    expect(arr.length).toBe(348)
  })

  test('withData_includesHeaderAndImage', () => {
    const img = new Uint8Array(64).fill(42)
    const arr = createNiftiArray(
      [4, 4, 4],
      [1, 1, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      NiiDataType.DT_UINT8,
      img,
    )
    // 352 (vox_offset) + 64 image bytes
    expect(arr.length).toBe(352 + 64)
    // Image data starts at offset 352
    expect(arr[352]).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// buildPaqdLut256
// ---------------------------------------------------------------------------
describe('buildPaqdLut256', () => {
  test('mapsColorsCorrectly', () => {
    // 2 entries starting at index 5
    const lut = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128])
    const result = buildPaqdLut256(lut, 5)
    expect(result.length).toBe(256 * 4)
    // Index 5 → red
    expect(result[5 * 4]).toBe(255)
    expect(result[5 * 4 + 1]).toBe(0)
    expect(result[5 * 4 + 2]).toBe(0)
    expect(result[5 * 4 + 3]).toBe(255)
    // Index 6 → green
    expect(result[6 * 4]).toBe(0)
    expect(result[6 * 4 + 1]).toBe(255)
    expect(result[6 * 4 + 3]).toBe(128)
  })

  test('outOfRangeIndex_staysTransparent', () => {
    const lut = new Uint8ClampedArray([255, 0, 0, 255])
    const result = buildPaqdLut256(lut, 0)
    // Index 1 was never written
    expect(result[1 * 4]).toBe(0)
    expect(result[1 * 4 + 3]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getVoxelValue
// ---------------------------------------------------------------------------
describe('getVoxelValue', () => {
  test('validCoord_returnsScaledValue', () => {
    const img = new Float32Array(64)
    img[0] = 10
    const vol = makeMinimalVolume({
      img,
      hdr: makeMinimalHeader({ scl_slope: 2, scl_inter: 5 }),
    })
    const val = getVoxelValue(vol, 0, 0, 0)
    // 10 * 2 + 5 = 25
    expect(val).toBe(25)
  })

  test('outOfBounds_returnsZero', () => {
    const vol = makeMinimalVolume()
    expect(getVoxelValue(vol, -1, 0, 0)).toBe(0)
    expect(getVoxelValue(vol, 0, 99, 0)).toBe(0)
    expect(getVoxelValue(vol, 0, 0, 99)).toBe(0)
  })

  test('nullImg_returnsZero', () => {
    const vol = makeMinimalVolume({ img: null })
    expect(getVoxelValue(vol, 0, 0, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// reorientDrawingToNative
// ---------------------------------------------------------------------------
describe('reorientDrawingToNative', () => {
  test('identityPerm_returnsUnchanged', () => {
    const drawing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const vol = makeMinimalVolume({ permRAS: [1, 2, 3] })
    const result = reorientDrawingToNative(vol, drawing)
    expect(result).toBe(drawing) // same reference
  })

  test('noPerm_returnsUnchanged', () => {
    const drawing = new Uint8Array([1, 2, 3, 4])
    const vol = makeMinimalVolume({ permRAS: undefined })
    const result = reorientDrawingToNative(vol, drawing)
    expect(result).toBe(drawing)
  })
})

// ---------------------------------------------------------------------------
// reorientDrawingToRAS
// ---------------------------------------------------------------------------
// Sagittal-style acquisition: native i -> anterior, j -> superior, k -> left.
// The permutation reorders axes of unequal length (6x5x4 native, 4x6x5 RAS).
const SAGITTAL_AFFINE = [
  [0, 0, -2, 10],
  [2, 0, 0, -5],
  [0, 2, 0, 3],
  [0, 0, 0, 1],
]

function makeOrientedVolume(dims: number[], affine: number[][]): NVImage {
  const vol = {
    name: 'background',
    hdr: makeMinimalHeader({ dims: [3, ...dims, 1, 1, 1, 1], affine }),
  } as NVImage
  calculateRAS(vol)
  return vol
}

function distinctBytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i % 255) + 1)
}

describe('reorientDrawingToRAS', () => {
  test('permutedUnequalAxes_placesNativeVoxelAtItsRASPosition', () => {
    const back = makeOrientedVolume([6, 5, 4], SAGITTAL_AFFINE)
    expect(back.permRAS).toEqual([-3, 1, 2])
    expect(back.dimsRAS).toEqual([3, 4, 6, 5])
    const native = new Uint8Array(6 * 5 * 4)
    // native (i=1, j=2, k=0) is RAS (x=3, y=1, z=2): x = 3 - k is flipped
    native[1 + 2 * 6 + 0 * 6 * 5] = 7

    const ras = reorientDrawingToRAS(back, native)

    expect(ras[3 + 1 * 4 + 2 * 4 * 6]).toBe(7)
  })

  test('permutedUnequalAxes_roundTripWithReorientDrawingToNative', () => {
    const back = makeOrientedVolume([6, 5, 4], SAGITTAL_AFFINE)
    const native = distinctBytes(6 * 5 * 4)

    const ras = reorientDrawingToRAS(back, native)

    expect(reorientDrawingToNative(back, ras)).toEqual(native)
  })

  test('flipOnly_roundTripWithReorientDrawingToNative', () => {
    const back = makeOrientedVolume(
      [6, 5, 4],
      [
        [-2, 0, 0, 10],
        [0, 2, 0, -5],
        [0, 0, -2, 3],
        [0, 0, 0, 1],
      ],
    )
    const native = distinctBytes(6 * 5 * 4)

    const ras = reorientDrawingToRAS(back, native)

    expect(reorientDrawingToNative(back, ras)).toEqual(native)
  })
})

describe('remapDrawingToRAS', () => {
  // Axial source grid of spacing `step` mm (x running right to left), origin
  // `o`, on the sagittal 2 mm background: permuted, flipped and offset.
  function remap(step: number, o: number[], srcDims: number[]) {
    const back = makeOrientedVolume([6, 5, 4], SAGITTAL_AFFINE)
    const [sx, sy, sz] = srcDims
    const src = distinctBytes(sx * sy * sz)
    const affine = [
      [-step, 0, 0, o[0]],
      [0, step, 0, o[1]],
      [0, 0, step, o[2]],
      [0, 0, 0, 1],
    ]
    const ras = remapDrawingToRAS(back, src, [3, sx, sy, sz], affine)
    return { back, src, ras }
  }

  test('permutedFlippedOffsetGrid_eachVoxelLandsOnItsMM_outsideIsZero', () => {
    const o = [10, -3, 5]
    const { back, src, ras } = remap(2, o, [3, 6, 3])
    if (typeof ras === 'string') throw new Error(ras)
    // Oracle: each background RAS voxel's own mm (matRAS, from calculateRAS)
    // names the source voxel at that mm.
    const [, nx, ny, nz] = back.dimsRAS as number[]
    const matRAS = back.matRAS as NonNullable<NVImage['matRAS']>
    let hits = 0
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const mm = vox2mm(null, [x, y, z], matRAS)
          const i = Math.round((o[0] - mm[0]) / 2)
          const [j, k] = [1, 2].map((a) => Math.round((mm[a] - o[a]) / 2))
          const isIn = i >= 0 && i < 3 && j >= 0 && j < 6 && k >= 0 && k < 3
          const want = isIn ? src[i + j * 3 + k * 18] : 0
          hits += want ? 1 : 0
          expect(ras[x + y * nx + z * nx * ny]).toBe(want)
        }
    // Partly off the background, which also overhangs it.
    expect(hits).toBeGreaterThan(0)
    expect(hits).toBeLessThan(3 * 6 * 3)
  })

  test('halfVoxelShift_refused', () => {
    expect(remap(2, [11, -3, 5], [3, 6, 3]).ras).toBe('non-integer shift')
  })

  test('driftThatCancelsAcrossTheGrid_judgedAtItsWorstVoxel', () => {
    // Along y the source spacing is 3.2e-4 short and its origin compensates:
    // -8e-4 voxel at one end, +8e-4 at the other, though the summed parts
    // (1.6e-3 + 8e-4) exceed the tolerance. 1.5x the drift is refused.
    const back = makeOrientedVolume([6, 5, 4], SAGITTAL_AFFINE)
    const src = distinctBytes(3 * 6 * 3)
    const at = (k: number) => {
      const e = 3.2e-4 * k
      return [
        [-2, 0, 0, 10],
        [0, 2 / (1 + e), 0, -5 + (2.5 * e * 2) / (1 + e)],
        [0, 0, 2, 5],
        [0, 0, 0, 1],
      ]
    }
    const exact = remapDrawingToRAS(back, src, [3, 3, 6, 3], at(0))
    expect(remapDrawingToRAS(back, src, [3, 3, 6, 3], at(1))).toEqual(exact)
    expect(remapDrawingToRAS(back, src, [3, 3, 6, 3], at(1.5))).toBe('scale')
  })

  test('scaledSlicesOnOneVoxelBackgroundAxis_refused', () => {
    // 2x2x1 unit background, 2x2x2 drawing at 0.5 mm in z: its second slice
    // lies between background centres and must not be dropped silently.
    const back = makeOrientedVolume(
      [2, 2, 1],
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    )
    const affine = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 0.5, 0],
      [0, 0, 0, 1],
    ]
    const src = new Uint8Array(8).fill(1)
    expect(remapDrawingToRAS(back, src, [3, 2, 2, 2], affine)).toBe('scale')
  })

  test('oneSliceOfOtherThickness_placedByItsCentre', () => {
    const back = makeOrientedVolume([6, 5, 4], SAGITTAL_AFFINE)
    const src = distinctBytes(3 * 6)
    const thick = (z: number) => [
      [-2, 0, 0, 10],
      [0, 2, 0, -3],
      [0, 0, 6, z],
      [0, 0, 0, 1],
    ]
    const ras = remapDrawingToRAS(back, src, [3, 3, 6, 1], thick(5))
    expect(ras).toEqual(remap(2, [10, -3, 5], [3, 6, 1]).ras)
    expect(remapDrawingToRAS(back, src, [3, 3, 6, 1], thick(6))).toBe(
      'non-integer shift',
    )
  })
})

describe('isSameGrid', () => {
  test('measuredInBackgroundVoxels_shearedGridShiftRefused', () => {
    // 9e-4 mm on the second row is 0.9 voxel through this shear: remapDrawingToRAS
    // calls it a non-integer shift, so the index copy must not take it.
    const back = [
      [1, 1, 0, 0],
      [0, 0.001, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]
    const moved = back.map((row) => [...row])
    moved[1][3] = 0.0009
    const dims = [3, 4, 4, 4]
    expect(isSameGrid(back, back, dims)).toBe(true)
    expect(isSameGrid(moved, back, dims)).toBe(false)
    // A float32 round trip of the same affine still matches.
    const f32 = back.map((row) => [...Float32Array.from(row)])
    expect(isSameGrid(f32, back, dims)).toBe(true)
  })
})

describe('toTypedView', () => {
  test('arrayBuffer_int16_returnsInt16Array', () => {
    const buf = new Int16Array([10, -3, 32000]).buffer
    const view = toTypedView(buf, NiiDataType.DT_INT16)
    expect(view).toBeInstanceOf(Int16Array)
    expect(Array.from(view as Int16Array)).toEqual([10, -3, 32000])
  })

  test('arrayBuffer_rgb24_returnsNull', () => {
    const buf = new Uint8Array([255, 0, 0, 0, 255, 0]).buffer
    expect(toTypedView(buf, NiiDataType.DT_RGB24)).toBeNull()
  })

  test('alreadyTypedArray_returnsAsIs', () => {
    const arr = new Float32Array([1.5, 2.5])
    expect(toTypedView(arr, NiiDataType.DT_FLOAT32)).toBe(arr)
  })
})

describe('toTypedViewOrU8', () => {
  test('arrayBuffer_int16_returnsInt16Array', () => {
    const buf = new Int16Array([1, 2, 3]).buffer
    const view = toTypedViewOrU8(buf, NiiDataType.DT_INT16)
    expect(view).toBeInstanceOf(Int16Array)
    expect(Array.from(view)).toEqual([1, 2, 3])
  })

  test('arrayBuffer_rgb24_fallsBackToUint8Array', () => {
    const bytes = new Uint8Array([255, 0, 128, 64, 32, 16])
    const view = toTypedViewOrU8(bytes.buffer, NiiDataType.DT_RGB24)
    expect(view).toBeInstanceOf(Uint8Array)
    expect(Array.from(view)).toEqual([255, 0, 128, 64, 32, 16])
  })

  test('alreadyTypedArray_returnsAsIs', () => {
    const arr = new Uint8Array([7, 8, 9])
    expect(toTypedViewOrU8(arr, NiiDataType.DT_UINT8)).toBe(arr)
  })
})

describe('framesInImage', () => {
  const nVox3D = 4 * 4 * 4 // 64
  const bpv = 4 // float32

  test('exact_multiple_returnsFrameCount', () => {
    expect(framesInImage(64 * 4 * 5, nVox3D, bpv)).toBe(5)
  })

  test('capped_buffer_reportsFewerThanHeader', () => {
    // Buffer holds only 3 whole frames even if the header advertised more.
    expect(framesInImage(64 * 4 * 3, nVox3D, bpv)).toBe(3)
  })

  test('partial_trailing_frame_floored', () => {
    expect(framesInImage(64 * 4 * 3 + 10, nVox3D, bpv)).toBe(3)
  })

  test('never_below_one', () => {
    expect(framesInImage(0, nVox3D, bpv)).toBe(1)
    expect(framesInImage(10, nVox3D, bpv)).toBe(1)
  })

  test('degenerate_frame_size_returnsOne', () => {
    expect(framesInImage(1000, 0, bpv)).toBe(1)
  })
})

describe('extractVoxelFid', () => {
  // A 2x1x1 MRSI grid, nPoints=2, nTransients=2. The native complex buffer is
  // point-major within transient blocks: index 2*(v + p*nVox + t*nVox*nPoints).
  // We encode re = v*100 + p*10 + t and im = re + 0.5 so each sample is unique.
  const nVox = 2
  const nPoints = 2
  const nTransients = 2
  const fid = new Float32Array(nVox * nPoints * nTransients * 2)
  for (let v = 0; v < nVox; v++) {
    for (let t = 0; t < nTransients; t++) {
      for (let p = 0; p < nPoints; p++) {
        const ci = 2 * (v + p * nVox + t * nVox * nPoints)
        const re = v * 100 + p * 10 + t
        fid[ci] = re
        fid[ci + 1] = re + 0.5
      }
    }
  }
  const vol = {
    complexFID: fid,
    mrsMeta: { nPoints, nTransients },
    nVox3D: nVox,
    dimsRAS: [3, nVox, 1, 1],
    // Identity native order: native = ix + iy*nVox + iz*nVox (start 0, step x=1).
    img2RASstart: [0, 0, 0],
    img2RASstep: [1, nVox, nVox],
  } as unknown as NVImage

  test('returns all transients in transient-major (SVS) layout', () => {
    const out = extractVoxelFid(vol, 1, 0, 0) // voxel v=1
    expect(out).not.toBeNull()
    // Length covers every transient, not just the first.
    expect(out?.length).toBe(nPoints * nTransients * 2)
    // SVS layout: out[2*(t*nPoints+p)] = re(v=1,p,t) = 100 + p*10 + t.
    for (let t = 0; t < nTransients; t++) {
      for (let p = 0; p < nPoints; p++) {
        const k = 2 * (t * nPoints + p)
        const re = 100 + p * 10 + t
        expect(out?.[k]).toBeCloseTo(re, 5)
        expect(out?.[k + 1]).toBeCloseTo(re + 0.5, 5)
      }
    }
  })

  test('single-transient volume reduces to one transient block', () => {
    const single = { ...vol, mrsMeta: { nPoints, nTransients: 1 } } as NVImage
    const out = extractVoxelFid(single, 1, 0, 0)
    expect(out?.length).toBe(nPoints * 2)
    // t=0 only: re(v=1,p,0) = 100 + p*10.
    expect(out?.[0]).toBeCloseTo(100, 5)
    expect(out?.[2]).toBeCloseTo(110, 5)
  })
})

// ---------------------------------------------------------------------------
// robustDisplayWindow
// ---------------------------------------------------------------------------
describe('robustDisplayWindow', () => {
  /** A ramp 0..255 with a handful of bright outliers at the top. */
  const rampWithOutliers = (): { hdr: NIFTIHeader; img: Uint8Array } => {
    const dim = 16
    const n = dim * dim * dim
    const img = new Uint8Array(n)
    for (let i = 0; i < n; i++) img[i] = Math.floor((i / n) * 200)
    for (let i = n - 8; i < n; i++) img[i] = 255
    const hdr = createNiftiHeader(
      [dim, dim, dim],
      [1, 1, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      NiiDataType.DT_UINT8,
    )
    return { hdr, img }
  }

  test('ignores a placeholder header window that calMinMax would adopt', () => {
    const { hdr, img } = rampWithOutliers()
    // What createStreamingNVImage stamps on a streamed volume before any voxel
    // has been read: the default display window, not file metadata.
    hdr.cal_min = 0
    hdr.cal_max = 1

    // calMinMax honours it, which is the bug this helper exists to avoid.
    expect(calMinMax(hdr, img).slice(0, 2)).toEqual([0, 1])

    const [lo, hi] = robustDisplayWindow(hdr, img)
    expect(hi).toBeGreaterThan(1)
    expect(hi).toBeGreaterThan(lo)
  })

  test('restores the header window it borrowed', () => {
    const { hdr, img } = rampWithOutliers()
    hdr.cal_min = 0
    hdr.cal_max = 1
    robustDisplayWindow(hdr, img)
    expect(hdr.cal_min).toBe(0)
    expect(hdr.cal_max).toBe(1)
  })

  test('restores the header window even when the image is all non-finite', () => {
    const dim = 4
    const img = new Float32Array(dim * dim * dim).fill(Number.NaN)
    const hdr = createNiftiHeader(
      [dim, dim, dim],
      [1, 1, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      NiiDataType.DT_FLOAT32,
    )
    hdr.cal_min = 5
    hdr.cal_max = 9
    expect(() => robustDisplayWindow(hdr, img)).toThrow()
    expect(hdr.cal_min).toBe(5)
    expect(hdr.cal_max).toBe(9)
  })

  test('is not skewed inward by NaN padding', () => {
    // Two volumes with the SAME finite data: one packed, one padded out to 4x
    // the size with NaN, which is what a DANDI float OCT store looks like
    // outside the imaged cylinder. The percentile target is a fraction of the
    // voxels the histogram holds, so the padding must not change the window.
    const finite = 4096
    const value = (i: number) => (i / finite) * 200
    const packed = new Float32Array(finite)
    for (let i = 0; i < finite; i++) packed[i] = value(i)
    const padded = new Float32Array(finite * 4).fill(Number.NaN)
    for (let i = 0; i < finite; i++) padded[i * 4] = value(i)

    const floatHdr = (dims: [number, number, number]): NIFTIHeader =>
      createNiftiHeader(
        dims,
        [1, 1, 1],
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        NiiDataType.DT_FLOAT32,
      )
    const packedWin = robustDisplayWindow(floatHdr([16, 16, 16]), packed).slice(
      0,
      2,
    )
    const paddedWin = robustDisplayWindow(floatHdr([16, 16, 64]), padded).slice(
      0,
      2,
    )
    // Same bin resolution over the same value range, so this is exact, not close.
    expect(paddedWin).toEqual(packedWin)
  })

  test('reports global min/max alongside the robust pair', () => {
    const { hdr, img } = rampWithOutliers()
    const [lo, hi, globalMin, globalMax] = robustDisplayWindow(hdr, img)
    expect(globalMin).toBe(0)
    expect(globalMax).toBe(255)
    // The outliers pull globalMax past the robust high.
    expect(hi).toBeLessThan(globalMax)
    expect(lo).toBeGreaterThanOrEqual(globalMin)
  })
})

describe('voxelSizeMM', () => {
  test('scales micrometer spacing to mm', () => {
    const hdr = { xyzt_units: 11 } // um + sec
    expect(voxelSizeMM({ pixDimsRAS: [3, 1000, 500, 2], hdr })).toEqual([
      1, 0.5, 0.002,
    ])
  })
  test('keeps mm spacing and is null without RAS dims', () => {
    const hdr = { xyzt_units: 10 }
    expect(voxelSizeMM({ pixDimsRAS: [3, 2, 2, 3], hdr })).toEqual([2, 2, 3])
    expect(voxelSizeMM({ hdr })).toBeNull()
  })
})

describe('warnMixedUnits', () => {
  test('warns only for volumes whose units differ from the base', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const mm = { name: 'mm', hdr: { xyzt_units: 10 } }
    const um = { name: 'um', hdr: { xyzt_units: 11 } }
    warnMixedUnits(mm, [mm, um])
    warnMixedUnits(undefined, [um])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("'um' is in um")
    warn.mockRestore()
  })
})

describe('residentPickSampler', () => {
  // 4x2x1 voxels, 2 mm, origin (-4, 0, 0); voxel x holds 10x + y.
  const vol = {
    img: Float32Array.from([0, 10, 20, 30, 1, 11, 21, 31]),
    dimsRAS: [3, 4, 2, 1],
    nVox3D: 8,
    img2RASstep: [1, 4, 8],
    img2RASstart: [0, 0, 0],
    matRAS: Float32Array.from([
      2, 0, 0, -4, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
    ]),
    calMin: 5,
    hdr: { scl_slope: 1, scl_inter: 0 },
  } as unknown as NVImage

  test('reads the voxel under a mm point above the window floor', () => {
    const s = residentPickSampler(vol)
    expect(s?.(0, 2, 0)).toBe(21 - 5)
    expect(s?.(-4, 0, 0)).toBe(0) // value 0 is under calMin
    expect(s?.(100, 0, 0)).toBe(0) // outside the volume
    // Outside stays 0 under a negative window, not 0 - calMin.
    expect(
      residentPickSampler({ ...vol, calMin: -500 } as NVImage)?.(100, 0, 0),
    ).toBe(0)
  })

  test('reads native storage at the shown frame', () => {
    // Same grid stored x-flipped as Uint16, frame 1 holding 100 + value.
    const f0 = [30, 20, 10, 0, 31, 21, 11, 1]
    const s = residentPickSampler({
      ...vol,
      img: Uint16Array.from([...f0, ...f0.map((v) => v + 100)]),
      img2RASstart: [3, 0, 0],
      img2RASstep: [-1, 4, 8],
      frame4D: 1,
      hdr: { scl_slope: 1, scl_inter: 0, datatypeCode: 512 },
    } as unknown as NVImage)
    expect(s?.(0, 2, 0)).toBe(121 - 5)
  })

  test('an RGBA voxel is visible by its alpha, not its color', () => {
    // Frame 1 (bytes 32+): voxel 0 transparent red, voxel 1 opaque green.
    const rgba = new Uint8Array(64)
    rgba.set([255, 0, 0, 0, 0, 255, 0, 255], 32)
    const s = residentPickSampler({
      ...vol,
      img: rgba,
      frame4D: 1,
      hdr: { scl_slope: 1, scl_inter: 0, datatypeCode: 2304 },
    } as unknown as NVImage)
    expect(s?.(-4, 0, 0)).toBe(0)
    expect(s?.(-2, 0, 0)).toBe(255)
  })

  test('is null without CPU voxels', () => {
    expect(residentPickSampler({ ...vol, img: null } as NVImage)).toBeNull()
  })
})
