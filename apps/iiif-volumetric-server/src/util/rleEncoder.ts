// Run-length encoding for uint8 label/mask volumes. The wire format is a
// flat stream of (run_length: uint32 LE, value: uint8) tuples — five bytes
// per run.

import type { Affine4x4, Shape3, Vec3 } from '../adapters/volumeHandle.ts'
import { dtypeNameToNiftiCode, makeNifti1Header } from './niftiEncoder.ts'

const MAX_RUN = 0xffffffff
export const NIFTI_RLE_MEDIA_TYPE = 'application/x.nifti-rle'

export function encodeRle(data: Uint8Array | Buffer): Buffer {
  if (!data || data.length === 0) return Buffer.alloc(0)
  const cap = data.length * 5
  const out = Buffer.allocUnsafe(cap)
  let outPos = 0
  let runValue = data[0] as number
  let runLen = 1
  const flush = (): void => {
    let remaining = runLen
    while (remaining > MAX_RUN) {
      out.writeUInt32LE(MAX_RUN, outPos)
      out.writeUInt8(runValue, outPos + 4)
      outPos += 5
      remaining -= MAX_RUN
    }
    out.writeUInt32LE(remaining, outPos)
    out.writeUInt8(runValue, outPos + 4)
    outPos += 5
  }
  for (let i = 1; i < data.length; i++) {
    const v = data[i] as number
    if (v === runValue) {
      runLen++
    } else {
      flush()
      runValue = v
      runLen = 1
    }
  }
  flush()
  return out.subarray(0, outPos)
}

export function decodeRle(buf: Buffer, voxelCount: number): Uint8Array {
  const out = new Uint8Array(voxelCount)
  let written = 0
  let p = 0
  while (p + 5 <= buf.length && written < voxelCount) {
    const run = buf.readUInt32LE(p)
    const value = buf.readUInt8(p + 4)
    const end = Math.min(written + run, voxelCount)
    out.fill(value, written, end)
    written = end
    p += 5
  }
  return out
}

export interface EncodeNiftiRleOpts {
  data: Uint8Array
  shape: Shape3
  spacing: Vec3
  dtype: 'uint8'
  affine?: Affine4x4 | null
  sclSlope?: number
  sclInter?: number
}

export function encodeNiftiRle(opts: EncodeNiftiRleOpts): Buffer {
  const { data, shape, spacing, dtype, affine, sclSlope, sclInter } = opts
  if (dtype !== 'uint8') {
    throw new Error(`RLE encoder requires uint8 voxels, got ${dtype as string}`)
  }
  const body = encodeRle(data)
  const header = makeNifti1Header({
    dims: shape,
    pixDims: spacing,
    datatypeCode: dtypeNameToNiftiCode(dtype),
    bitsPerVoxel: 8,
    affine,
    sclSlope,
    sclInter,
  })
  const out = Buffer.alloc(352 + body.length)
  Buffer.from(header).copy(out, 0)
  body.copy(out, 352)
  return out
}

export function decodeNiftiRle(buf: Buffer, voxelCount: number): Uint8Array {
  if (buf.length < 352)
    throw new Error('RLE NIfTI buffer is shorter than 352-byte header')
  return decodeRle(buf.subarray(352), voxelCount)
}
