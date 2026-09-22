/**
 * Byte-level TIFF builders for the TIFF test suites.
 *
 * Real fixtures would need Git LFS and would not let a test target one decoder
 * path at a time, so the tests synthesize containers instead. This lives in its
 * own module rather than in `tiff.test.ts` so that importing the builder does
 * not re-run that file's test cases.
 *
 * Test-only: nothing in the library imports it, so it is never bundled.
 */

import { TIFF_TAG } from './tiff'

/** One IFD entry to write. `values` are field values, not bytes. */
export interface Entry {
  tag: number
  type: number
  values: number[] | string
}

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  11: 4,
  12: 8,
  16: 8,
}

/** Build a minimal single-IFD TIFF around `pixels`. */
export function buildTiff(options: {
  entries: Entry[]
  blocks: Uint8Array[]
  littleEndian?: boolean
  bigTiff?: boolean
  /** Tag receiving each block's offset, and the tag receiving its length. */
  offsetTag?: number
  countTag?: number
}): ArrayBuffer {
  const le = options.littleEndian ?? true
  const big = options.bigTiff ?? false
  const offsetTag = options.offsetTag ?? TIFF_TAG.stripOffsets
  const countTag = options.countTag ?? TIFF_TAG.stripByteCounts

  const headerSize = big ? 16 : 8
  // Layout: header, block data, then the IFD (so block offsets are known).
  const blockOffsets: number[] = []
  let cursor = headerSize
  for (const block of options.blocks) {
    blockOffsets.push(cursor)
    cursor += block.length
  }
  const ifdOffset = cursor

  const entries: Entry[] = [
    ...options.entries,
    { tag: offsetTag, type: big ? 16 : 4, values: blockOffsets },
    {
      tag: countTag,
      type: big ? 16 : 4,
      values: options.blocks.map((b) => b.length),
    },
  ].sort((a, b) => a.tag - b.tag)

  const entrySize = big ? 20 : 12
  const inlineSize = big ? 8 : 4
  const ifdHeaderSize = big ? 8 : 2
  const ifdSize = ifdHeaderSize + entries.length * entrySize + (big ? 8 : 4)

  // Overflowing values land after the IFD.
  let overflowCursor = ifdOffset + ifdSize
  const overflow: { offset: number; bytes: Uint8Array }[] = []
  const encodeValues = (entry: Entry): Uint8Array => {
    if (typeof entry.values === 'string') {
      const text = `${entry.values}\0`
      return new Uint8Array(
        Array.from(text, (character) => character.charCodeAt(0)),
      )
    }
    const size = TYPE_SIZE[entry.type]
    const bytes = new Uint8Array(entry.values.length * size)
    const view = new DataView(bytes.buffer)
    entry.values.forEach((value, i) => {
      const at = i * size
      if (entry.type === 1) view.setUint8(at, value)
      else if (entry.type === 3) view.setUint16(at, value, le)
      else if (entry.type === 4) view.setUint32(at, value, le)
      else if (entry.type === 11) view.setFloat32(at, value, le)
      else if (entry.type === 12) view.setFloat64(at, value, le)
      else if (entry.type === 16) view.setBigUint64(at, BigInt(value), le)
      else if (entry.type === 5) {
        // Encode a rational as value/1000 so fractions survive.
        view.setUint32(at, Math.round(value * 1000), le)
        view.setUint32(at + 4, 1000, le)
      } else throw new Error(`test builder: unhandled type ${entry.type}`)
    })
    return bytes
  }

  const encoded = entries.map((entry) => {
    const bytes = encodeValues(entry)
    const count =
      typeof entry.values === 'string' ? bytes.length : entry.values.length
    if (bytes.length > inlineSize) {
      const offset = overflowCursor
      overflow.push({ offset, bytes })
      overflowCursor += bytes.length + (bytes.length % 2)
      return { entry, count, bytes, offset }
    }
    return { entry, count, bytes, offset: null }
  })

  const total = overflowCursor
  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  const out = new Uint8Array(buffer)

  view.setUint16(0, le ? 0x4949 : 0x4d4d, false)
  view.setUint16(2, big ? 43 : 42, le)
  if (big) {
    view.setUint16(4, 8, le)
    view.setUint16(6, 0, le)
    view.setBigUint64(8, BigInt(ifdOffset), le)
  } else {
    view.setUint32(4, ifdOffset, le)
  }

  options.blocks.forEach((block, i) => {
    out.set(block, blockOffsets[i])
  })

  if (big) {
    view.setBigUint64(ifdOffset, BigInt(entries.length), le)
  } else {
    view.setUint16(ifdOffset, entries.length, le)
  }
  encoded.forEach(({ entry, count, bytes, offset }, i) => {
    const at = ifdOffset + ifdHeaderSize + i * entrySize
    view.setUint16(at, entry.tag, le)
    view.setUint16(at + 2, entry.type, le)
    if (big) {
      view.setBigUint64(at + 4, BigInt(count), le)
    } else {
      view.setUint32(at + 4, count, le)
    }
    const valueField = at + (big ? 12 : 8)
    if (offset === null) {
      out.set(bytes, valueField)
    } else if (big) {
      view.setBigUint64(valueField, BigInt(offset), le)
    } else {
      view.setUint32(valueField, offset, le)
    }
  })
  const linkAt = ifdOffset + ifdHeaderSize + entries.length * entrySize
  if (big) {
    view.setBigUint64(linkAt, 0n, le)
  } else {
    view.setUint32(linkAt, 0, le)
  }
  for (const { offset, bytes } of overflow) {
    out.set(bytes, offset)
  }
  return buffer
}

export function baseEntries(
  width: number,
  height: number,
  bits: number,
  extra: Entry[] = [],
): Entry[] {
  return [
    { tag: TIFF_TAG.imageWidth, type: 3, values: [width] },
    { tag: TIFF_TAG.imageLength, type: 3, values: [height] },
    { tag: TIFF_TAG.bitsPerSample, type: 3, values: [bits] },
    { tag: TIFF_TAG.compression, type: 3, values: [1] },
    { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
    { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [height] },
    ...extra,
  ]
}

/** Encode `data` as a single PackBits literal run per 128 bytes. */
export function packBitsLiterals(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 128) {
    const run = data.subarray(i, Math.min(i + 128, data.length))
    out.push(run.length - 1, ...run)
  }
  return Uint8Array.from(out)
}

/** Encode `data` as TIFF LZW using literal codes only (still exercises bit packing). */
export function lzwLiteralOnly(data: Uint8Array): Uint8Array {
  const bits: number[] = []
  const push = (code: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) {
      bits.push((code >> i) & 1)
    }
  }
  // Mirror the decoder's table growth: it adds one entry per literal after the
  // first, and widens the code EARLY at 511/1023/2047. Writing everything at
  // 9 bits desyncs the stream after ~253 literals.
  let nextCode = 258
  let codeLength = 9
  push(256, codeLength) // clear
  data.forEach((byte, i) => {
    push(byte, codeLength)
    if (i > 0 && nextCode < 4096) {
      nextCode++
    }
    if (nextCode === 511) {
      codeLength = 10
    } else if (nextCode === 1023) {
      codeLength = 11
    } else if (nextCode === 2047) {
      codeLength = 12
    }
  })
  push(257, codeLength) // end of information
  while (bits.length % 8 !== 0) {
    bits.push(0)
  }
  const out = new Uint8Array(bits.length / 8)
  bits.forEach((bit, i) => {
    if (bit) out[i >> 3] |= 1 << (7 - (i & 7))
  })
  return out
}

/**
 * Build a multi-IFD TIFF by concatenating single-IFD files and relinking them.
 *
 * Each plane is one IFD filled with its own plane index, so a test can tell
 * which IFDs a reader selected just by looking at the voxels. `buildTiff`
 * writes one IFD; chaining its output here keeps that builder simple while
 * still exercising a reader's IFD walk.
 */
export function buildMultiIfd(
  planes: number,
  description: string | undefined,
  width: number,
  height: number,
): ArrayBuffer {
  const parts: Uint8Array[] = []
  const ifdOffsets: number[] = []
  let cursor = 8 // room for the shared header

  for (let i = 0; i < planes; i++) {
    const extra: Entry[] = []
    if (i === 0 && description !== undefined) {
      extra.push({
        tag: TIFF_TAG.imageDescription,
        type: 2,
        values: description,
      })
    }
    const single = new Uint8Array(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [width] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [height] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [height] },
          ...extra,
        ],
        blocks: [new Uint8Array(width * height).fill(i)],
      }),
    )
    const view = new DataView(single.buffer)
    const localIfd = view.getUint32(4, true)
    // Drop the per-part header and rebase every absolute offset onto `cursor`.
    const body = single.subarray(8)
    const shift = cursor - 8
    if (shift !== 0) {
      rebaseIfd(body, localIfd - 8, shift)
    }
    ifdOffsets.push(localIfd + shift)
    parts.push(body)
    cursor += body.length
  }

  const total = new Uint8Array(cursor)
  const view = new DataView(total.buffer)
  view.setUint16(0, 0x4949, false)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifdOffsets[0], true)
  let at = 8
  for (const part of parts) {
    total.set(part, at)
    at += part.length
  }
  // Chain the IFDs together.
  for (let i = 0; i < ifdOffsets.length; i++) {
    const count = view.getUint16(ifdOffsets[i], true)
    const linkAt = ifdOffsets[i] + 2 + count * 12
    view.setUint32(
      linkAt,
      i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0,
      true,
    )
  }
  return total.buffer
}

/** Add `shift` to every offset an IFD stores, in a header-stripped body. */
function rebaseIfd(body: Uint8Array, ifdAt: number, shift: number): void {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const count = view.getUint16(ifdAt, true)
  for (let i = 0; i < count; i++) {
    const at = ifdAt + 2 + i * 12
    const type = view.getUint16(at + 2, true)
    const n = view.getUint32(at + 4, true)
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1
    const bytes = n * size
    if (bytes > 4) {
      view.setUint32(at + 8, view.getUint32(at + 8, true) + shift, true)
    } else if (type === 4 || type === 16) {
      // Inline strip offsets and byte counts: only offsets need rebasing.
      const tag = view.getUint16(at, true)
      if (tag === TIFF_TAG.stripOffsets || tag === TIFF_TAG.tileOffsets) {
        for (let v = 0; v < n; v++) {
          const vat = at + 8 + v * 4
          view.setUint32(vat, view.getUint32(vat, true) + shift, true)
        }
      }
    }
  }
}
