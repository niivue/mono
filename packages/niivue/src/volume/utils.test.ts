import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import type { NVImage, NIFTIHeader } from '@/NVTypes'
import {
  ensureValidNonZero,
  getTypedArrayConstructor,
  getBitsPerVoxel,
  calMinMax,
  createNiftiHeader,
  hdrToArrayBuffer,
  createNiftiArray,
  buildPaqdLut256,
  getVoxelValue,
  reorientDrawingToNative,
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
  test('returns348bytes', () => {
    const hdr = createNiftiHeader(
      [10, 10, 10],
      [1, 1, 1],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      NiiDataType.DT_UINT8,
    )
    const buf = hdrToArrayBuffer(hdr)
    expect(buf.length).toBe(348)
  })

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
