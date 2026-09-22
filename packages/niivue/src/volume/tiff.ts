/**
 * Baseline TIFF container reader.
 *
 * Covers the subset that scientific imaging actually writes: classic TIFF and
 * BigTIFF, either byte order, strips or tiles, chunky or planar sample layout,
 * 8/16/32/64-bit integer and float samples, and the None / LZW / PackBits /
 * Deflate compressors. That is everything an OME-TIFF from Bio-Formats,
 * ImageJ, or the Allen Institute pipeline uses.
 *
 * Deliberately NOT supported (each throws a specific error rather than
 * returning wrong pixels): JPEG-in-TIFF, JPEG2000, sub-byte bit depths,
 * mixed bits-per-sample, and the floating-point predictor. Colour management
 * (palettes, CMYK, YCbCr) is out of scope too - this reads samples, not
 * displayable colour.
 *
 * The OME-XML metadata that turns a plane stack into a 5-D image lives in
 * `omeTiff.ts`; volume assembly lives in `tiffVolume.ts`.
 */

import { decompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { TypedVoxelArray } from '@/NVTypes'

/** TIFF tag numbers this reader consumes. */
export const TIFF_TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  imageDescription: 270,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  xResolution: 282,
  yResolution: 283,
  planarConfiguration: 284,
  resolutionUnit: 296,
  software: 305,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
} as const

/** Tags this reader consumes; corruption in any other tag is survivable. */
const CONSUMED_TAGS = new Set<number>(Object.values(TIFF_TAG))

/** TIFF `Compression` values this reader understands. */
const COMPRESSION = {
  none: 1,
  lzw: 5,
  deflateAdobe: 8,
  packBits: 32773,
  deflate: 32946,
} as const

/** TIFF `SampleFormat` values. */
export const SAMPLE_FORMAT = {
  uint: 1,
  int: 2,
  float: 3,
  undefined: 4,
} as const

/** One decoded IFD entry. Rationals are stored pre-divided. */
export interface TiffTagValue {
  type: number
  count: number
  values: number[]
  /** Present for ASCII tags, with trailing NUL padding removed. */
  ascii?: string
}

/** One image file directory: a single plane's tags. */
export interface TiffIfd {
  tags: Map<number, TiffTagValue>
}

/** A parsed TIFF container. `ifds` are in file order. */
export interface TiffFile {
  /**
   * The whole file. Typed on `ArrayBuffer` rather than `ArrayBufferLike` so
   * sample views can be built over it without a cast.
   */
  bytes: Uint8Array<ArrayBuffer>
  littleEndian: boolean
  isBigTiff: boolean
  ifds: TiffIfd[]
}

/** One decoded plane. `data` is sample-interleaved, row-major from the top. */
export interface TiffImage {
  width: number
  height: number
  samplesPerPixel: number
  bitsPerSample: number
  /** One of {@link SAMPLE_FORMAT}. */
  sampleFormat: number
  data: TypedVoxelArray
}

/** Byte width of each TIFF field type, indexed by type code. 0 = unknown. */
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
  16: 8, // LONG8 (BigTIFF)
  17: 8, // SLONG8 (BigTIFF)
  18: 8, // IFD8 (BigTIFF)
}

const ASCII_DECODER = new TextDecoder('utf-8')

/** Read a single value of `type` at `offset`. Rationals return num/den. */
function readTypedValue(
  view: DataView,
  offset: number,
  type: number,
  littleEndian: boolean,
): number {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return view.getUint8(offset)
    case 6:
      return view.getInt8(offset)
    case 3:
      return view.getUint16(offset, littleEndian)
    case 8:
      return view.getInt16(offset, littleEndian)
    case 4:
    case 13:
      return view.getUint32(offset, littleEndian)
    case 9:
      return view.getInt32(offset, littleEndian)
    case 11:
      return view.getFloat32(offset, littleEndian)
    case 12:
      return view.getFloat64(offset, littleEndian)
    case 5: {
      const den = view.getUint32(offset + 4, littleEndian)
      return den === 0 ? 0 : view.getUint32(offset, littleEndian) / den
    }
    case 10: {
      const den = view.getInt32(offset + 4, littleEndian)
      return den === 0 ? 0 : view.getInt32(offset, littleEndian) / den
    }
    case 16:
    case 18:
      return Number(view.getBigUint64(offset, littleEndian))
    case 17:
      return Number(view.getBigInt64(offset, littleEndian))
    default:
      throw new Error(`TIFF: unsupported field type ${type}`)
  }
}

function readEntry(
  view: DataView,
  entryOffset: number,
  littleEndian: boolean,
  isBigTiff: boolean,
): { tag: number; value: TiffTagValue } {
  const tag = view.getUint16(entryOffset, littleEndian)
  const type = view.getUint16(entryOffset + 2, littleEndian)
  const count = isBigTiff
    ? Number(view.getBigUint64(entryOffset + 4, littleEndian))
    : view.getUint32(entryOffset + 4, littleEndian)
  const size = TYPE_SIZE[type]
  if (!size) {
    // An unknown private tag must not abort the parse - skip it.
    return { tag, value: { type, count, values: [] } }
  }
  const inlineSize = isBigTiff ? 8 : 4
  const valueFieldOffset = entryOffset + (isBigTiff ? 12 : 8)
  const totalBytes = size * count
  const dataOffset =
    totalBytes <= inlineSize
      ? valueFieldOffset
      : isBigTiff
        ? Number(view.getBigUint64(valueFieldOffset, littleEndian))
        : view.getUint32(valueFieldOffset, littleEndian)
  if (dataOffset + totalBytes > view.byteLength) {
    if (CONSUMED_TAGS.has(tag)) {
      throw new Error(`TIFF: tag ${tag} points past the end of the file`)
    }
    // A truncated private tag (maker notes, editor metadata) must not abort
    // the parse - nothing downstream reads it.
    log.warn(
      `TIFF: skipping tag ${tag}, its data points past the end of the file`,
    )
    return { tag, value: { type, count, values: [] } }
  }
  if (type === 2) {
    // The spec says ASCII, but ImageDescription in practice carries UTF-8:
    // OME-XML declares that encoding and writes micrometres as a literal 'um'
    // with a micro sign. Decoding byte-per-character would mangle it.
    const text = ASCII_DECODER.decode(
      new Uint8Array(view.buffer, view.byteOffset + dataOffset, count),
    )
    // ASCII fields are NUL terminated, and multi-string fields concatenate
    // NUL-separated runs. Callers want the text, not the terminators.
    return {
      tag,
      value: { type, count, values: [], ascii: text.replace(/\0+$/, '') },
    }
  }
  const values = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    values[i] = readTypedValue(view, dataOffset + i * size, type, littleEndian)
  }
  return { tag, value: { type, count, values } }
}

/**
 * Parse a TIFF header and every IFD in its chain.
 *
 * Only directory structure is read here - no pixel data is touched, so this is
 * cheap enough to run before deciding what to load.
 */
export function parseTiff(buffer: ArrayBuffer): TiffFile {
  if (buffer.byteLength < 8) {
    throw new Error(`TIFF: file too small (${buffer.byteLength} bytes)`)
  }
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const order = view.getUint16(0, false)
  if (order !== 0x4949 && order !== 0x4d4d) {
    throw new Error('TIFF: not a TIFF file (bad byte-order mark)')
  }
  const littleEndian = order === 0x4949
  const magic = view.getUint16(2, littleEndian)
  if (magic !== 42 && magic !== 43) {
    throw new Error(`TIFF: unexpected version ${magic}, expected 42 or 43`)
  }
  const isBigTiff = magic === 43
  let nextIfd: number
  if (isBigTiff) {
    const offsetSize = view.getUint16(4, littleEndian)
    if (offsetSize !== 8) {
      throw new Error(
        `TIFF: BigTIFF offset size ${offsetSize} is not supported`,
      )
    }
    nextIfd = Number(view.getBigUint64(8, littleEndian))
  } else {
    nextIfd = view.getUint32(4, littleEndian)
  }

  const ifds: TiffIfd[] = []
  const seen = new Set<number>()
  while (nextIfd > 0 && nextIfd < buffer.byteLength) {
    // A corrupt file can point an IFD at itself; without this it loops forever.
    if (seen.has(nextIfd)) {
      throw new Error(`TIFF: IFD chain loops at offset ${nextIfd}`)
    }
    seen.add(nextIfd)
    const entryCount = isBigTiff
      ? Number(view.getBigUint64(nextIfd, littleEndian))
      : view.getUint16(nextIfd, littleEndian)
    const entrySize = isBigTiff ? 20 : 12
    const headerSize = isBigTiff ? 8 : 2
    // The +4/+8 covers the next-IFD link after the entries.
    const ifdEnd =
      nextIfd + headerSize + entryCount * entrySize + (isBigTiff ? 8 : 4)
    if (ifdEnd > buffer.byteLength) {
      throw new Error(
        `TIFF: IFD at offset ${nextIfd} claims ${entryCount} entries but runs past the end of the file`,
      )
    }
    const tags = new Map<number, TiffTagValue>()
    for (let i = 0; i < entryCount; i++) {
      const { tag, value } = readEntry(
        view,
        nextIfd + headerSize + i * entrySize,
        littleEndian,
        isBigTiff,
      )
      tags.set(tag, value)
    }
    ifds.push({ tags })
    const linkOffset = nextIfd + headerSize + entryCount * entrySize
    nextIfd = isBigTiff
      ? Number(view.getBigUint64(linkOffset, littleEndian))
      : view.getUint32(linkOffset, littleEndian)
  }
  if (ifds.length === 0) {
    throw new Error('TIFF: no image file directories found')
  }
  return { bytes, littleEndian, isBigTiff, ifds }
}

/** First numeric value of a tag, or `undefined` when absent. */
export function tagValue(ifd: TiffIfd, tag: number): number | undefined {
  const entry = ifd.tags.get(tag)
  return entry && entry.values.length > 0 ? entry.values[0] : undefined
}

/** All numeric values of a tag, or `undefined` when absent. */
export function tagValues(ifd: TiffIfd, tag: number): number[] | undefined {
  const entry = ifd.tags.get(tag)
  return entry && entry.values.length > 0 ? entry.values : undefined
}

/** ASCII payload of a tag, or `undefined` when absent or non-ASCII. */
export function tagString(ifd: TiffIfd, tag: number): string | undefined {
  return ifd.tags.get(tag)?.ascii
}

/**
 * The `ImageDescription` of the first IFD, which is where OME-TIFF stores its
 * OME-XML and where ImageJ stores its `ImageJ=` key/value block.
 */
export function tiffImageDescription(tiff: TiffFile): string | undefined {
  return tagString(tiff.ifds[0], TIFF_TAG.imageDescription)
}

/** Decode TIFF LZW (MSB-first codes, early code-width change). */
export function decodeLzw(
  input: Uint8Array,
  expectedLength: number,
): Uint8Array {
  const CLEAR = 256
  const EOI = 257
  const out = new Uint8Array(expectedLength)
  let outPos = 0
  let dictionary: Uint8Array[] = []
  let nextCode = 258
  let codeLength = 9

  const reset = (): void => {
    dictionary = new Array<Uint8Array>(4096)
    for (let i = 0; i < 256; i++) {
      dictionary[i] = Uint8Array.of(i)
    }
    nextCode = 258
    codeLength = 9
  }
  reset()

  let pos = 0
  let bitBuf = 0
  let bitCount = 0
  const readCode = (): number => {
    while (bitCount < codeLength) {
      if (pos >= input.length) {
        return EOI
      }
      bitBuf = (bitBuf << 8) | input[pos++]
      bitCount += 8
    }
    bitCount -= codeLength
    const code = (bitBuf >>> bitCount) & ((1 << codeLength) - 1)
    bitBuf &= (1 << bitCount) - 1
    return code
  }

  const emit = (entry: Uint8Array): void => {
    const room = out.length - outPos
    if (room <= 0) {
      return
    }
    if (entry.length <= room) {
      out.set(entry, outPos)
      outPos += entry.length
    } else {
      out.set(entry.subarray(0, room), outPos)
      outPos = out.length
    }
  }

  let oldCode = -1
  for (;;) {
    const code = readCode()
    if (code === EOI) {
      break
    }
    if (code === CLEAR) {
      reset()
      oldCode = -1
      continue
    }
    let entry: Uint8Array
    const known = dictionary[code]
    if (known) {
      entry = known
      if (oldCode >= 0 && nextCode < 4096) {
        const prev = dictionary[oldCode]
        const added = new Uint8Array(prev.length + 1)
        added.set(prev, 0)
        added[prev.length] = entry[0]
        dictionary[nextCode++] = added
      }
    } else {
      if (oldCode < 0) {
        throw new Error('TIFF: LZW stream starts with an undefined code')
      }
      const prev = dictionary[oldCode]
      entry = new Uint8Array(prev.length + 1)
      entry.set(prev, 0)
      entry[prev.length] = prev[0]
      if (nextCode < 4096) {
        dictionary[nextCode++] = entry
      }
    }
    emit(entry)
    oldCode = code
    // TIFF widens one code EARLIER than plain LZW; getting this wrong decodes
    // the first few hundred bytes correctly and then garbage.
    if (nextCode === 511) {
      codeLength = 10
    } else if (nextCode === 1023) {
      codeLength = 11
    } else if (nextCode === 2047) {
      codeLength = 12
    }
    if (outPos >= out.length) {
      break
    }
  }
  return out
}

/** Decode Apple PackBits run-length encoding. */
export function decodePackBits(
  input: Uint8Array,
  expectedLength: number,
): Uint8Array {
  const out = new Uint8Array(expectedLength)
  let outPos = 0
  let pos = 0
  while (pos < input.length && outPos < out.length) {
    const header = (input[pos++] << 24) >> 24
    if (header === -128) {
      continue // no-op byte
    }
    if (header >= 0) {
      const run = header + 1
      for (
        let i = 0;
        i < run && outPos < out.length && pos < input.length;
        i++
      ) {
        out[outPos++] = input[pos++]
      }
    } else {
      if (pos >= input.length) {
        break
      }
      const byte = input[pos++]
      const run = 1 - header
      for (let i = 0; i < run && outPos < out.length; i++) {
        out[outPos++] = byte
      }
    }
  }
  return out
}

async function decompressBlock(
  block: Uint8Array,
  compression: number,
  expectedLength: number,
): Promise<Uint8Array> {
  switch (compression) {
    case COMPRESSION.none:
      return block
    case COMPRESSION.lzw:
      return decodeLzw(block, expectedLength)
    case COMPRESSION.packBits:
      return decodePackBits(block, expectedLength)
    case COMPRESSION.deflate:
    case COMPRESSION.deflateAdobe:
      return decompress(block)
    case 6:
    case 7:
      throw new Error(
        'TIFF: JPEG-compressed TIFF is not supported; re-export with LZW, Deflate or no compression',
      )
    default:
      throw new Error(`TIFF: unsupported compression ${compression}`)
  }
}

/**
 * Undo horizontal differencing in place.
 *
 * The predictor runs per row over the block's own width, before the block is
 * placed into the destination, so `rowSamples` counts padding columns in a
 * tile.
 */
export function applyHorizontalPredictor(
  block: Uint8Array,
  rows: number,
  rowSamples: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  littleEndian: boolean,
): void {
  const bytesPerSample = bitsPerSample >> 3
  const rowBytes = rowSamples * samplesPerPixel * bytesPerSample
  if (bytesPerSample === 1) {
    for (let row = 0; row < rows; row++) {
      const base = row * rowBytes
      for (let i = samplesPerPixel; i < rowBytes; i++) {
        block[base + i] =
          (block[base + i] + block[base + i - samplesPerPixel]) & 0xff
      }
    }
    return
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  const stride = samplesPerPixel * bytesPerSample
  for (let row = 0; row < rows; row++) {
    const base = row * rowBytes
    for (let i = stride; i < rowBytes; i += bytesPerSample) {
      const here = base + i
      const prev = here - stride
      if (bytesPerSample === 2) {
        view.setUint16(
          here,
          (view.getUint16(here, littleEndian) +
            view.getUint16(prev, littleEndian)) &
            0xffff,
          littleEndian,
        )
      } else if (bytesPerSample === 4) {
        view.setUint32(
          here,
          (view.getUint32(here, littleEndian) +
            view.getUint32(prev, littleEndian)) >>>
            0,
          littleEndian,
        )
      } else {
        throw new Error(
          `TIFF: horizontal predictor is undefined for ${bitsPerSample}-bit samples`,
        )
      }
    }
  }
}

type TypedArrayCtor = {
  new (length: number): TypedVoxelArray
  new (buffer: ArrayBuffer, byteOffset: number, length: number): TypedVoxelArray
  BYTES_PER_ELEMENT: number
}

/** The typed-array constructor for a TIFF sample description. */
export function sampleArrayCtor(
  bitsPerSample: number,
  sampleFormat: number,
): TypedArrayCtor {
  if (sampleFormat === SAMPLE_FORMAT.float) {
    if (bitsPerSample === 32) return Float32Array
    if (bitsPerSample === 64) return Float64Array
    throw new Error(
      `TIFF: ${bitsPerSample}-bit float samples are not supported`,
    )
  }
  if (sampleFormat === SAMPLE_FORMAT.int) {
    if (bitsPerSample === 8) return Int8Array
    if (bitsPerSample === 16) return Int16Array
    if (bitsPerSample === 32) return Int32Array
    throw new Error(
      `TIFF: ${bitsPerSample}-bit signed samples are not supported`,
    )
  }
  if (bitsPerSample === 8) return Uint8Array
  if (bitsPerSample === 16) return Uint16Array
  if (bitsPerSample === 32) return Uint32Array
  throw new Error(`TIFF: ${bitsPerSample}-bit samples are not supported`)
}

/** Reinterpret raw sample bytes as the typed array the samples describe. */
function viewSamples(
  raw: Uint8Array<ArrayBuffer>,
  count: number,
  bitsPerSample: number,
  sampleFormat: number,
  littleEndian: boolean,
): TypedVoxelArray {
  const Ctor = sampleArrayCtor(bitsPerSample, sampleFormat)
  const bytesPerSample = bitsPerSample >> 3
  if (bytesPerSample === 1) {
    return new Ctor(raw.buffer, raw.byteOffset, count)
  }
  if (littleEndian) {
    // `slice` yields a fresh ArrayBuffer at offset 0, so the typed view is
    // always correctly aligned even when `raw` is a mid-buffer subarray.
    const copy = raw.slice(0, count * bytesPerSample)
    return new Ctor(copy.buffer, 0, count)
  }
  const out = new Ctor(count)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  for (let i = 0; i < count; i++) {
    const at = i * bytesPerSample
    if (sampleFormat === SAMPLE_FORMAT.float) {
      out[i] =
        bytesPerSample === 4
          ? view.getFloat32(at, false)
          : view.getFloat64(at, false)
    } else if (sampleFormat === SAMPLE_FORMAT.int) {
      out[i] =
        bytesPerSample === 2
          ? view.getInt16(at, false)
          : view.getInt32(at, false)
    } else {
      out[i] =
        bytesPerSample === 2
          ? view.getUint16(at, false)
          : view.getUint32(at, false)
    }
  }
  return out
}

/**
 * Decode one IFD into an interleaved sample array.
 *
 * Strips and tiles are handled by the same loop: a strip is just a full-width
 * tile whose height is `RowsPerStrip`.
 */
export async function readTiffImage(
  tiff: TiffFile,
  index: number,
): Promise<TiffImage> {
  const ifd = tiff.ifds[index]
  if (!ifd) {
    throw new Error(
      `TIFF: no IFD at index ${index} (file has ${tiff.ifds.length})`,
    )
  }
  const width = tagValue(ifd, TIFF_TAG.imageWidth)
  const height = tagValue(ifd, TIFF_TAG.imageLength)
  if (!width || !height) {
    throw new Error(`TIFF: IFD ${index} has no image dimensions`)
  }
  const samplesPerPixel = tagValue(ifd, TIFF_TAG.samplesPerPixel) ?? 1
  const bitsList = tagValues(ifd, TIFF_TAG.bitsPerSample) ?? [1]
  const bitsPerSample = bitsList[0]
  if (bitsList.some((b) => b !== bitsPerSample)) {
    throw new Error(
      `TIFF: mixed bits-per-sample ${bitsList.join(',')} is not supported`,
    )
  }
  if (bitsPerSample % 8 !== 0) {
    throw new Error(
      `TIFF: ${bitsPerSample}-bit samples are not supported (sub-byte packing)`,
    )
  }
  const sampleFormat =
    (tagValues(ifd, TIFF_TAG.sampleFormat) ?? [SAMPLE_FORMAT.uint])[0] ||
    SAMPLE_FORMAT.uint
  const compression = tagValue(ifd, TIFF_TAG.compression) ?? COMPRESSION.none
  const predictor = tagValue(ifd, TIFF_TAG.predictor) ?? 1
  if (predictor === 3) {
    throw new Error('TIFF: the floating-point predictor (3) is not supported')
  }
  if (predictor !== 1 && predictor !== 2) {
    throw new Error(`TIFF: unsupported predictor ${predictor}`)
  }
  const planar = tagValue(ifd, TIFF_TAG.planarConfiguration) ?? 1
  const bytesPerSample = bitsPerSample >> 3
  // Planar storage keeps one sample per block; chunky interleaves all of them.
  const samplesPerBlock = planar === 2 ? 1 : samplesPerPixel
  const planeCount = planar === 2 ? samplesPerPixel : 1

  const tileWidth = tagValue(ifd, TIFF_TAG.tileWidth)
  const tileLength = tagValue(ifd, TIFF_TAG.tileLength)
  const isTiled = tileWidth !== undefined && tileLength !== undefined
  const blockWidth = isTiled ? tileWidth : width
  const blockHeight = isTiled
    ? tileLength
    : (tagValue(ifd, TIFF_TAG.rowsPerStrip) ?? height)
  if (!blockWidth || !blockHeight) {
    throw new Error(`TIFF: IFD ${index} declares a zero-sized block`)
  }
  const offsets = tagValues(
    ifd,
    isTiled ? TIFF_TAG.tileOffsets : TIFF_TAG.stripOffsets,
  )
  const byteCounts = tagValues(
    ifd,
    isTiled ? TIFF_TAG.tileByteCounts : TIFF_TAG.stripByteCounts,
  )
  if (!offsets || !byteCounts) {
    throw new Error(
      `TIFF: IFD ${index} has no ${isTiled ? 'tile' : 'strip'} offsets`,
    )
  }

  const across = Math.ceil(width / blockWidth)
  const down = Math.ceil(height / blockHeight)
  const blocksPerPlane = across * down
  const destBytes = width * height * samplesPerPixel * bytesPerSample
  const dest = new Uint8Array(destBytes)
  const destPixelStride = samplesPerPixel * bytesPerSample
  const destRowBytes = width * destPixelStride
  // A strip is clipped to the image; a tile is padded out to its full size.
  const blockRowBytes = blockWidth * samplesPerBlock * bytesPerSample

  for (let plane = 0; plane < planeCount; plane++) {
    for (let block = 0; block < blocksPerPlane; block++) {
      const flat = plane * blocksPerPlane + block
      if (flat >= offsets.length || flat >= byteCounts.length) {
        throw new Error(
          `TIFF: IFD ${index} lists ${Math.min(offsets.length, byteCounts.length)} blocks, expected ${planeCount * blocksPerPlane}`,
        )
      }
      const x0 = (block % across) * blockWidth
      const y0 = Math.floor(block / across) * blockHeight
      const rows = isTiled ? blockHeight : Math.min(blockHeight, height - y0)
      const copyRows = Math.min(rows, height - y0)
      const copyCols = Math.min(blockWidth, width - x0)
      if (copyRows <= 0 || copyCols <= 0) {
        continue
      }
      const start = offsets[flat]
      const length = byteCounts[flat]
      if (start + length > tiff.bytes.length) {
        throw new Error(
          `TIFF: block ${flat} of IFD ${index} runs past the file end`,
        )
      }
      const raw = tiff.bytes.subarray(start, start + length)
      const expected = rows * blockRowBytes
      let decoded = await decompressBlock(raw, compression, expected)
      if (decoded.length < expected) {
        // A truncated final block is common in the wild; pad rather than throw
        // so the rest of the plane still renders.
        const padded = new Uint8Array(expected)
        padded.set(decoded.subarray(0, Math.min(decoded.length, expected)))
        decoded = padded
      }
      if (predictor === 2) {
        // Predictor mutates the block, so never mutate the source buffer.
        if (decoded === raw) {
          decoded = raw.slice()
        }
        applyHorizontalPredictor(
          decoded,
          rows,
          blockWidth,
          samplesPerBlock,
          bitsPerSample,
          tiff.littleEndian,
        )
      }
      for (let row = 0; row < copyRows; row++) {
        const srcRow = row * blockRowBytes
        const destRow = (y0 + row) * destRowBytes + x0 * destPixelStride
        if (planar === 2) {
          for (let col = 0; col < copyCols; col++) {
            const from = srcRow + col * bytesPerSample
            const to = destRow + col * destPixelStride + plane * bytesPerSample
            for (let b = 0; b < bytesPerSample; b++) {
              dest[to + b] = decoded[from + b]
            }
          }
        } else {
          const runBytes = copyCols * destPixelStride
          dest.set(decoded.subarray(srcRow, srcRow + runBytes), destRow)
        }
      }
    }
  }

  return {
    width,
    height,
    samplesPerPixel,
    bitsPerSample,
    sampleFormat,
    data: viewSamples(
      dest,
      width * height * samplesPerPixel,
      bitsPerSample,
      sampleFormat,
      tiff.littleEndian,
    ),
  }
}

/**
 * Voxel spacing implied by the `XResolution`/`YResolution` tags, in mm.
 *
 * `ResolutionUnit` 2 is inches and 3 is centimetres; anything else (including
 * the "no unit" value 1) yields `undefined` because the numbers are then just
 * an aspect ratio, not a physical size.
 */
export function tiffResolutionMm(
  ifd: TiffIfd,
): { x: number; y: number } | undefined {
  const unit = tagValue(ifd, TIFF_TAG.resolutionUnit) ?? 2
  const perUnitMm = unit === 2 ? 25.4 : unit === 3 ? 10 : 0
  if (perUnitMm === 0) {
    return undefined
  }
  const xRes = tagValue(ifd, TIFF_TAG.xResolution)
  const yRes = tagValue(ifd, TIFF_TAG.yResolution)
  if (!xRes || !yRes) {
    return undefined
  }
  return { x: perUnitMm / xRes, y: perUnitMm / yRes }
}
