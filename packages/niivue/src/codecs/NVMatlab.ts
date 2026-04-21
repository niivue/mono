import type { TypedNumberArray } from '@/NVTypes'
import { decompress } from './NVGz'

export async function readMatV4(
  buffer: ArrayBuffer,
  isReplaceDots: boolean = false,
): Promise<Record<string, TypedNumberArray>> {
  let len = buffer.byteLength
  if (len < 40) {
    throw new Error(`File too small to be MAT v4: bytes = ${buffer.byteLength}`)
  }
  let reader = new DataView(buffer)
  let magic = reader.getUint16(0, true)
  let _buffer = buffer
  if (magic === 35615 || magic === 8075) {
    const raw = await decompress(new Uint8Array(buffer))
    reader = new DataView(raw.buffer as ArrayBuffer)
    magic = reader.getUint16(0, true)
    _buffer = raw.buffer as ArrayBuffer
    len = _buffer.byteLength
  }
  const textDecoder = new TextDecoder('utf-8')
  const bytes = new Uint8Array(_buffer)
  let pos = 0
  const mat: Record<string, TypedNumberArray> = {}
  const getTensDigit = (v: number): number => Math.floor(v / 10) % 10
  const readArray = (
    tagDataType: number,
    tagBytesStart: number,
    tagBytesEnd: number,
  ): TypedNumberArray => {
    const byteArray = new Uint8Array(bytes.subarray(tagBytesStart, tagBytesEnd))
    if (tagDataType === 1) return new Float32Array(byteArray.buffer)
    if (tagDataType === 2) return new Int32Array(byteArray.buffer)
    if (tagDataType === 3) return new Int16Array(byteArray.buffer)
    if (tagDataType === 4) return new Uint16Array(byteArray.buffer)
    if (tagDataType === 5) return new Uint8Array(byteArray.buffer)
    return new Float64Array(byteArray.buffer)
  }
  const readTag = (): void => {
    const mtype = reader.getUint32(pos, true)
    const mrows = reader.getUint32(pos + 4, true)
    const ncols = reader.getUint32(pos + 8, true)
    const imagf = reader.getUint32(pos + 12, true)
    const namlen = reader.getUint32(pos + 16, true)
    pos += 20
    if (imagf !== 0) {
      throw new Error('Matlab V4 reader does not support imaginary numbers')
    }
    const tagArrayItems = mrows * ncols
    if (tagArrayItems < 1) {
      throw new Error('mrows * ncols must be greater than one')
    }
    const byteArray = new Uint8Array(bytes.subarray(pos, pos + namlen))
    let tagName = textDecoder.decode(byteArray).trim().replaceAll('\x00', '')
    if (isReplaceDots) {
      tagName = tagName.replaceAll('.', '_')
    }
    const tagDataType = getTensDigit(mtype)
    let tagBytesPerItem = 8
    if (tagDataType >= 1 && tagDataType <= 2) tagBytesPerItem = 4
    else if (tagDataType >= 3 && tagDataType <= 4) tagBytesPerItem = 2
    else if (tagDataType === 5) tagBytesPerItem = 1
    else if (tagDataType !== 0) throw new Error('impossible Matlab v4 datatype')
    pos += namlen
    if (mtype > 50) {
      throw new Error('Does not appear to be little-endian V4 Matlab file')
    }
    const posEnd = pos + tagArrayItems * tagBytesPerItem
    mat[tagName] = readArray(tagDataType, pos, posEnd)
    pos = posEnd
  }
  while (pos + 20 < len) {
    readTag()
  }
  return mat
}
