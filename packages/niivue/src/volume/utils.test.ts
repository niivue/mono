import { describe, expect, test } from 'bun:test'
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
  reorientDrawingToNative,
  temporalUnitScale,
  toTypedView,
  toTypedViewOrU8,
  volumeTR,
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
