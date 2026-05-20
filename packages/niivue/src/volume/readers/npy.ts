import * as nifti from 'nifti-reader-js'
import { Zip } from '@/codecs/NVZip'
import { NiiDataType } from '@/NVConstants'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'

export const extensions = ['npy', 'npz']
export const type = 'nii'

const TYPE_SIZE: Record<string, number> = {
  b1: 1,
  i1: 1,
  u1: 1,
  i2: 2,
  u2: 2,
  i4: 4,
  u4: 4,
  f4: 4,
  f8: 8,
}

const DATATYPE_CODE: Record<string, number> = {
  b1: NiiDataType.DT_UINT8,
  i1: NiiDataType.DT_INT8,
  u1: NiiDataType.DT_UINT8,
  i2: NiiDataType.DT_INT16,
  u2: NiiDataType.DT_UINT16,
  i4: NiiDataType.DT_INT32,
  u4: NiiDataType.DT_UINT32,
  f4: NiiDataType.DT_FLOAT32,
  f8: NiiDataType.DT_FLOAT64,
}

function parseDtype(dtype: string): {
  endian: string
  suffix: string
  bytesPerElement: number
  datatypeCode: number
} {
  if (dtype.length < 2) {
    throw new Error(`Invalid NPY dtype: ${dtype}`)
  }
  const endian = dtype[0]
  if (!['<', '>', '|', '='].includes(endian)) {
    throw new Error(`Invalid NPY dtype endian prefix: ${dtype}`)
  }
  const suffix = dtype.slice(1)
  const bytesPerElement = TYPE_SIZE[suffix]
  const datatypeCode = DATATYPE_CODE[suffix]
  if (bytesPerElement === undefined || datatypeCode === undefined) {
    throw new Error(`Unsupported NPY dtype: ${dtype}`)
  }
  return { endian, suffix, bytesPerElement, datatypeCode }
}

function byteSwapInPlace(buffer: ArrayBuffer, bytesPerElement: number): void {
  if (bytesPerElement <= 1) return
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += bytesPerElement) {
    for (let j = 0, k = bytesPerElement - 1; j < k; j++, k--) {
      const tmp = bytes[i + j]
      bytes[i + j] = bytes[i + k]
      bytes[i + k] = tmp
    }
  }
}

function readNPYBuffer(buffer: ArrayBuffer): {
  hdr: NIFTI1 | NIFTI2
  img: ArrayBuffer | TypedVoxelArray
} {
  const dv = new DataView(buffer)
  const magicBytes = [
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3),
    dv.getUint8(4),
    dv.getUint8(5),
  ]
  const expectedMagic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]
  if (!magicBytes.every((byte, i) => byte === expectedMagic[i])) {
    throw new Error('Not a valid NPY file: Magic number mismatch')
  }

  const majorVersion = dv.getUint8(6)
  const minorVersion = dv.getUint8(7)

  let headerLen: number
  let headerStart: number
  let headerEncoding: string
  if (majorVersion === 1) {
    headerLen = dv.getUint16(8, true)
    headerStart = 10
    headerEncoding = 'latin1'
  } else if (majorVersion === 2 || majorVersion === 3) {
    headerLen = dv.getUint32(8, true)
    headerStart = 12
    headerEncoding = majorVersion === 3 ? 'utf-8' : 'latin1'
  } else {
    throw new Error(`Unsupported NPY version: ${majorVersion}.${minorVersion}`)
  }

  const dataStart = headerStart + headerLen
  if (dataStart > buffer.byteLength) {
    throw new Error('Invalid NPY file: Header length exceeds buffer size')
  }

  const headerText = new TextDecoder(headerEncoding).decode(
    buffer.slice(headerStart, dataStart),
  )

  const shapeMatch = headerText.match(/'shape': \((.*?)\)/)
  if (!shapeMatch) throw new Error('Invalid NPY header: Shape not found')
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
  if (shape.length === 0 || shape.some((v) => !Number.isInteger(v) || v <= 0)) {
    throw new Error(`Invalid NPY header: invalid shape (${shapeMatch[1]})`)
  }
  if (shape.length < 2 || shape.length > 4) {
    throw new Error(
      `Unsupported NPY shape: expected 2D, 3D, or 4D array, got (${shape.join(', ')})`,
    )
  }

  const dtypeMatch = headerText.match(/'descr': '([^']+)'/)
  if (!dtypeMatch) throw new Error('Invalid NPY header: Data type not found')
  const dtype = dtypeMatch[1]
  const { endian, bytesPerElement, datatypeCode } = parseDtype(dtype)

  const hostLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
  const sourceLittleEndian =
    endian === '<' || endian === '|' || (endian === '=' && hostLittleEndian)

  const numElements = shape.reduce((a, b) => a * b, 1)
  const expectedBytes = numElements * bytesPerElement
  if (buffer.byteLength - dataStart < expectedBytes) {
    throw new Error(
      'Invalid NPY file: not enough data bytes for specified shape and data type',
    )
  }

  const dataBuffer = buffer.slice(dataStart, dataStart + expectedBytes)
  if (sourceLittleEndian !== hostLittleEndian) {
    byteSwapInPlace(dataBuffer, bytesPerElement)
  }

  const width = shape[shape.length - 1]
  const height = shape.length > 1 ? shape[shape.length - 2] : 1
  const slices = shape.length > 2 ? shape[shape.length - 3] : 1
  const timepoints = shape.length === 4 ? shape[0] : 1

  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.dims = [shape.length, width, height, slices, timepoints, 1, 1, 1]
  hdr.pixDims = [1, 1, 1, 1, 1, 1, 1, 1]
  hdr.affine = [
    [hdr.pixDims[1], 0, 0, -(hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [0, -hdr.pixDims[2], 0, (hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, 0, -hdr.pixDims[3], (hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ]
  hdr.numBitsPerVoxel = bytesPerElement * 8
  hdr.datatypeCode = datatypeCode
  hdr.littleEndian = hostLittleEndian
  return { hdr, img: dataBuffer }
}

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const dv = new DataView(buffer)
  const magicBytes = [
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3),
  ]
  const zipMagic = [0x50, 0x4b, 0x03, 0x04]
  const isZip = magicBytes.every((byte, i) => byte === zipMagic[i])
  if (!isZip) {
    return readNPYBuffer(buffer)
  }
  const zip = new Zip(buffer)
  for (let i = 0; i < zip.entries.length; i++) {
    const entry = zip.entries[i]
    if (entry.fileName.toLowerCase().endsWith('.npy')) {
      const data = await entry.extract?.()
      if (!data) {
        throw new Error('Failed to extract .npy entry from NPZ archive')
      }
      return readNPYBuffer(data.buffer as ArrayBuffer)
    }
  }
  throw new Error('NPZ archive contains no .npy entries')
}
