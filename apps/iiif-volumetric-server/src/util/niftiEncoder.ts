import zlib from 'node:zlib'
import nifti from 'nifti-reader-js'
import type { Affine4x4, Dtype, Shape3, Vec3, VoxelArray } from '../adapters/volumeHandle.ts'

const HAS_ZSTD = typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync === 'function'
const ENCODING_PREFERENCE = ['zstd', 'br', 'gzip', 'identity'] as const
export type ContentEncoding = (typeof ENCODING_PREFERENCE)[number]

export interface EncodeNiftiOpts {
  data: VoxelArray
  shape: Shape3
  spacing: Vec3
  dtype: Dtype
  affine?: Affine4x4 | null
  sclSlope?: number
  sclInter?: number
}

export function encodeNifti(opts: EncodeNiftiOpts): Buffer {
  return zlib.gzipSync(encodeNiftiRaw(opts))
}

export function negotiateEncoding(
  acceptEncoding: string | undefined | null,
): ContentEncoding {
  if (!acceptEncoding) return 'gzip'
  const tokens = parseAcceptEncoding(String(acceptEncoding))
  const wildcardQ = tokens.get('*')
  for (const enc of ENCODING_PREFERENCE) {
    if (enc === 'zstd' && !HAS_ZSTD) continue
    const q = tokens.has(enc) ? tokens.get(enc) : wildcardQ
    if (q !== undefined && q > 0) return enc
  }
  return 'identity'
}

function parseAcceptEncoding(header: string): Map<string, number> {
  const tokens = new Map<string, number>()
  for (const part of header.split(',')) {
    const segments = part
      .trim()
      .split(';')
      .map((s) => s.trim())
    const name = segments[0]?.toLowerCase()
    if (!name) continue
    let q = 1
    for (let i = 1; i < segments.length; i++) {
      const m = /^q=([0-9.]+)$/i.exec(segments[i] ?? '')
      if (m) q = Number.parseFloat(m[1] ?? '0')
    }
    tokens.set(name, q)
  }
  return tokens
}

export function compressBuffer(buf: Buffer, encoding: ContentEncoding): Buffer {
  switch (encoding) {
    case 'zstd':
      if (!HAS_ZSTD) throw new Error('zstd encoding requested but not supported')
      return (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(buf)
    case 'br':
      return zlib.brotliCompressSync(buf)
    case 'gzip':
      return zlib.gzipSync(buf)
    case 'identity':
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    default: {
      const exhaustive: never = encoding
      throw new Error(`Unsupported encoding: ${String(exhaustive)}`)
    }
  }
}

export function encodeNiftiRaw(opts: EncodeNiftiOpts): Buffer {
  const { data, shape, spacing, dtype, affine, sclSlope, sclInter } = opts
  const colorBytes = dtype === 'rgb24' ? 3 : dtype === 'rgba32' ? 4 : 0
  const elemBytes =
    colorBytes ||
    dtypeByteSize(dtype) ||
    (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ||
    1
  const header = makeNifti1Header({
    dims: shape,
    pixDims: spacing,
    datatypeCode: dtypeNameToNiftiCode(dtype),
    bitsPerVoxel: elemBytes * 8,
    affine,
    sclSlope,
    sclInter,
  })
  const fileBuf = Buffer.alloc(352 + data.byteLength)
  Buffer.from(header).copy(fileBuf, 0)
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(fileBuf, 352)
  return fileBuf
}

export interface MakeHeaderOpts {
  dims: Shape3
  pixDims: Vec3
  datatypeCode: number
  bitsPerVoxel: number
  affine?: Affine4x4 | null
  sclSlope?: number
  sclInter?: number
}

export function makeNifti1Header(opts: MakeHeaderOpts): ArrayBuffer {
  const { dims, pixDims, datatypeCode, bitsPerVoxel, affine, sclSlope, sclInter } = opts
  const buf = new ArrayBuffer(352)
  const view = new DataView(buf)
  view.setInt32(0, 348, true)
  view.setInt16(40, 3, true)
  view.setInt16(42, dims[0], true)
  view.setInt16(44, dims[1], true)
  view.setInt16(46, dims[2], true)
  view.setInt16(48, 1, true)
  view.setInt16(50, 1, true)
  view.setInt16(52, 1, true)
  view.setInt16(54, 1, true)
  view.setInt16(70, datatypeCode, true)
  view.setInt16(72, bitsPerVoxel, true)
  view.setFloat32(76, 1, true)
  view.setFloat32(80, pixDims[0] || 1, true)
  view.setFloat32(84, pixDims[1] || 1, true)
  view.setFloat32(88, pixDims[2] || 1, true)
  view.setFloat32(108, 352, true)

  if (affine && affine.length === 4) {
    view.setInt16(254, 1, true)
    view.setFloat32(280, affine[0][0], true)
    view.setFloat32(284, affine[0][1], true)
    view.setFloat32(288, affine[0][2], true)
    view.setFloat32(292, affine[0][3], true)
    view.setFloat32(296, affine[1][0], true)
    view.setFloat32(300, affine[1][1], true)
    view.setFloat32(304, affine[1][2], true)
    view.setFloat32(308, affine[1][3], true)
    view.setFloat32(312, affine[2][0], true)
    view.setFloat32(316, affine[2][1], true)
    view.setFloat32(320, affine[2][2], true)
    view.setFloat32(324, affine[2][3], true)
  }

  view.setFloat32(112, sclSlope ?? 0, true)
  view.setFloat32(116, sclInter ?? 0, true)

  const magic = new Uint8Array(buf, 344, 4)
  magic[0] = 0x6e
  magic[1] = 0x2b
  magic[2] = 0x31
  magic[3] = 0x00
  return buf
}

export function dtypeNameToNiftiCode(name: Dtype): number {
  switch (name) {
    case 'uint8':
      return nifti.NIFTI1.TYPE_UINT8
    case 'int8':
      return nifti.NIFTI1.TYPE_INT8
    case 'int16':
      return nifti.NIFTI1.TYPE_INT16
    case 'uint16':
      return nifti.NIFTI1.TYPE_UINT16
    case 'int32':
      return nifti.NIFTI1.TYPE_INT32
    case 'uint32':
      return nifti.NIFTI1.TYPE_UINT32
    case 'float32':
      return nifti.NIFTI1.TYPE_FLOAT32
    case 'float64':
      return nifti.NIFTI1.TYPE_FLOAT64
    case 'rgb24':
      return 128
    case 'rgba32':
      return 2304
    default: {
      const exhaustive: never = name
      throw new Error(`Cannot map dtype to NIfTI datatype: ${String(exhaustive)}`)
    }
  }
}

export function dtypeByteSize(name: Dtype): number {
  switch (name) {
    case 'uint8':
    case 'int8':
      return 1
    case 'int16':
    case 'uint16':
      return 2
    case 'int32':
    case 'uint32':
    case 'float32':
      return 4
    case 'float64':
      return 8
    case 'rgb24':
      return 3
    case 'rgba32':
      return 4
    default: {
      const exhaustive: never = name
      throw new Error(`Unknown dtype: ${String(exhaustive)}`)
    }
  }
}
