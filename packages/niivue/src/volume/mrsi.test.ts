import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import type { NIFTI1, NVImage } from '@/NVTypes'
import { isMrsiVolume, prepareMrsiVolume } from './mrsi'
import { extractVoxelFid } from './utils'

// A NIfTI-MRS ecode-44 header extension carrying SpectrometerFrequency +
// ResonantNucleus (the metadata that gates MRSI detection).
function mrsExtension(): { ecode: number; edata: ArrayBuffer } {
  const json = JSON.stringify({
    SpectrometerFrequency: [100],
    ResonantNucleus: ['1H'],
  })
  const bytes = new TextEncoder().encode(json)
  return { ecode: 44, edata: bytes.buffer as ArrayBuffer }
}

// Minimal NIfTI-1-shaped header for a 2x2x1 grid with 4 spectral points,
// complex64. Only the fields prepareMrsiVolume reads are populated. By default
// it carries a NIfTI-MRS ecode-44 extension so it is detected as MRSI.
function complexHeader(): NIFTI1 {
  const dims = [4, 2, 2, 1, 4, 1, 1, 1]
  const pixDims = [1, 2, 2, 2, 0.001, 0, 0, 0]
  // identity-ish affine (2 mm voxels)
  const affine = [
    [2, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ]
  return {
    dims,
    pixDims,
    affine,
    datatypeCode: NiiDataType.DT_COMPLEX64,
    numBitsPerVoxel: 64,
    scl_slope: 1,
    scl_inter: 0,
    extensions: [mrsExtension()],
  } as unknown as NIFTI1
}

describe('isMrsiVolume', () => {
  test('trueForSpatialComplex4DWithMrsMetadata', () => {
    expect(isMrsiVolume(complexHeader())).toBe(true)
  })

  test('falseForComplex4DWithoutMrsMetadata', () => {
    // A spatial complex 4D NIfTI with NO MRS header extension (e.g. complex
    // fMRI) must NOT be rewritten into a scalar MRSI map.
    const h = complexHeader()
    ;(h as unknown as { extensions: unknown[] }).extensions = []
    expect(isMrsiVolume(h)).toBe(false)
  })

  test('falseForNonSpatialComplex', () => {
    const h = complexHeader()
    h.dims = [4, 1, 1, 1, 4, 1, 1, 1]
    expect(isMrsiVolume(h)).toBe(false)
  })

  test('falseForRealVolume', () => {
    const h = complexHeader()
    h.datatypeCode = NiiDataType.DT_FLOAT32
    expect(isMrsiVolume(h)).toBe(false)
  })
})

describe('prepareMrsiVolume', () => {
  test('derivesScalarMapAndRetainsFID', () => {
    const nVox3D = 4
    const nPoints = 4
    // interleaved re/im in native frame-major order: complex(v,p) at 2*(v + p*nVox3D)
    const fid = new Float32Array(nVox3D * nPoints * 2)
    for (let v = 0; v < nVox3D; v++) {
      for (let p = 0; p < nPoints; p++) {
        const ci = 2 * (v + p * nVox3D)
        fid[ci] = v + 1 // re
        fid[ci + 1] = p // im
      }
    }
    // Strip the MRS extension so spectrometerFreq is null and the map uses the
    // first-point-magnitude fallback (deterministic, no FFT) for this assertion.
    const hdr = complexHeader()
    ;(hdr as unknown as { extensions: unknown[] }).extensions = []
    const prepped = prepareMrsiVolume(hdr, fid.buffer)
    // scalar map: one value per spatial voxel
    expect(prepped.img.length).toBe(nVox3D)
    // no spectrometer freq -> first-point magnitude = hypot(re@p0, im@p0=0) = v+1
    for (let v = 0; v < nVox3D; v++) {
      expect(prepped.img[v]).toBeCloseTo(v + 1, 5)
    }
    // header is now real float32, single 3D frame
    expect(prepped.hdr.datatypeCode).toBe(NiiDataType.DT_FLOAT32)
    expect(prepped.hdr.dims[4]).toBe(1)
    // retained metadata
    expect(prepped.mrsMeta.nPoints).toBe(nPoints)
    expect(prepped.mrsMeta.nTransients).toBe(1)
    expect(prepped.mrsMeta.dwell).toBeCloseTo(0.001, 6)
    expect(prepped.complexFID.length).toBe(fid.length)
  })
})

describe('extractVoxelFid', () => {
  test('pullsNativeFrameMajorSamples', () => {
    const nVox3D = 4
    const nPoints = 4
    const fid = new Float32Array(nVox3D * nPoints * 2)
    for (let v = 0; v < nVox3D; v++) {
      for (let p = 0; p < nPoints; p++) {
        const ci = 2 * (v + p * nVox3D)
        fid[ci] = 10 * v + p // re encodes (voxel, point)
        fid[ci + 1] = -p
      }
    }
    // Identity RAS mapping for a 2x2x1 grid.
    const vol = {
      complexFID: fid,
      mrsMeta: {
        spectrometerFreq: null,
        nucleus: '1H',
        dwell: 0.001,
        nPoints,
        nTransients: 1,
      },
      nVox3D,
      dimsRAS: [3, 2, 2, 1],
      img2RASstart: [0, 0, 0],
      img2RASstep: [1, 2, 4],
    } as unknown as NVImage

    // voxel (1,0,0) -> native index 1
    const out = extractVoxelFid(vol, 1, 0, 0)
    expect(out).not.toBeNull()
    const fidOut = out as Float32Array
    expect(fidOut.length).toBe(nPoints * 2)
    for (let p = 0; p < nPoints; p++) {
      expect(fidOut[2 * p]).toBeCloseTo(10 * 1 + p, 5)
      expect(fidOut[2 * p + 1]).toBeCloseTo(-p, 5)
    }

    // out of bounds -> null
    expect(extractVoxelFid(vol, 5, 0, 0)).toBeNull()
  })
})
