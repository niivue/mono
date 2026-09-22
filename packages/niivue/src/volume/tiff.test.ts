import { describe, expect, test } from 'bun:test'
import {
  applyHorizontalPredictor,
  decodeLzw,
  decodePackBits,
  parseTiff,
  readTiffImage,
  SAMPLE_FORMAT,
  sampleArrayCtor,
  TIFF_TAG,
  tagString,
  tagValue,
  tiffImageDescription,
  tiffResolutionMm,
} from './tiff'
import {
  baseEntries,
  buildTiff,
  lzwLiteralOnly,
  packBitsLiterals,
} from './tiffBuilders'

describe('parseTiff', () => {
  test('reads a little-endian classic TIFF header and IFD', () => {
    const pixels = Uint8Array.of(1, 2, 3, 4, 5, 6)
    const buffer = buildTiff({
      entries: baseEntries(3, 2, 8),
      blocks: [pixels],
    })
    const tiff = parseTiff(buffer)
    expect(tiff.littleEndian).toBe(true)
    expect(tiff.isBigTiff).toBe(false)
    expect(tiff.ifds).toHaveLength(1)
    expect(tagValue(tiff.ifds[0], TIFF_TAG.imageWidth)).toBe(3)
    expect(tagValue(tiff.ifds[0], TIFF_TAG.imageLength)).toBe(2)
  })

  test('rejects a file that is not a TIFF', () => {
    const buffer = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    expect(() => parseTiff(buffer)).toThrow(/not a TIFF/)
  })

  test('rejects an unknown version', () => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0x4949, false)
    view.setUint16(2, 99, true)
    expect(() => parseTiff(bytes.buffer)).toThrow(/unexpected version 99/)
  })

  test('reads ASCII tags with the NUL terminator stripped', () => {
    const buffer = buildTiff({
      entries: baseEntries(2, 1, 8, [
        {
          tag: TIFF_TAG.imageDescription,
          type: 2,
          values: '<OME><Image/></OME>',
        },
      ]),
      blocks: [Uint8Array.of(9, 9)],
    })
    const tiff = parseTiff(buffer)
    expect(tiffImageDescription(tiff)).toBe('<OME><Image/></OME>')
    expect(tagString(tiff.ifds[0], TIFF_TAG.imageDescription)).not.toContain(
      '\0',
    )
  })

  /** Point `tag`'s out-of-line data offset past the end of the file. */
  function corruptTagOffset(buffer: ArrayBuffer, tag: number): void {
    const view = new DataView(buffer)
    const ifdAt = view.getUint32(4, true)
    const count = view.getUint16(ifdAt, true)
    for (let i = 0; i < count; i++) {
      const at = ifdAt + 2 + i * 12
      if (view.getUint16(at, true) === tag) {
        view.setUint32(at + 8, 0x7fffffff, true)
        return
      }
    }
    throw new Error(`test setup: tag ${tag} was not written`)
  }

  test('skips a truncated private tag instead of aborting the parse', async () => {
    // A MakerNote whose data lies past the end of the file, as left behind by
    // naive TIFF truncation/editing. Nothing downstream reads it, so the file
    // must still open.
    const MAKER_NOTE = 37500
    const pixels = Uint8Array.of(7, 8)
    const buffer = buildTiff({
      entries: baseEntries(2, 1, 8, [
        { tag: MAKER_NOTE, type: 1, values: [1, 2, 3, 4, 5, 6, 7, 8] },
      ]),
      blocks: [pixels],
    })
    corruptTagOffset(buffer, MAKER_NOTE)
    const tiff = parseTiff(buffer)
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([7, 8])
  })

  test('still rejects a truncated tag the reader depends on', () => {
    const buffer = buildTiff({
      entries: baseEntries(2, 1, 8, [
        {
          tag: TIFF_TAG.imageDescription,
          type: 2,
          values: '<OME><Image/></OME>',
        },
      ]),
      blocks: [Uint8Array.of(9, 9)],
    })
    corruptTagOffset(buffer, TIFF_TAG.imageDescription)
    expect(() => parseTiff(buffer)).toThrow(/points past the end/)
  })

  test('rejects a corrupt IFD entry count as a TIFF error, not a RangeError', () => {
    const bytes = new Uint8Array(16)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, 0x4949, false)
    view.setUint16(2, 42, true)
    view.setUint32(4, 8, true)
    view.setUint16(8, 5000, true)
    expect(() => parseTiff(bytes.buffer)).toThrow(/claims 5000 entries/)
  })
})

describe('readTiffImage', () => {
  test('decodes 8-bit uncompressed strips', async () => {
    const pixels = Uint8Array.of(10, 20, 30, 40, 50, 60)
    const tiff = parseTiff(
      buildTiff({ entries: baseEntries(3, 2, 8), blocks: [pixels] }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(image.width).toBe(3)
    expect(image.height).toBe(2)
    expect(image.samplesPerPixel).toBe(1)
    expect(Array.from(image.data)).toEqual([10, 20, 30, 40, 50, 60])
  })

  test('decodes multiple strips into one plane', async () => {
    const tiff = parseTiff(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [2] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [3] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [2] },
        ],
        blocks: [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6)],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('rejects a StripByteCounts list shorter than StripOffsets', async () => {
    // Divert the builder's automatic byte-count entry to an unused private tag
    // so the real StripByteCounts can carry fewer entries than StripOffsets.
    // Decoding must throw, not silently leave the second row blank.
    const tiff = parseTiff(
      buildTiff({
        entries: [
          { tag: TIFF_TAG.imageWidth, type: 3, values: [4] },
          { tag: TIFF_TAG.imageLength, type: 3, values: [2] },
          { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
          { tag: TIFF_TAG.compression, type: 3, values: [1] },
          { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
          { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [1] },
          { tag: TIFF_TAG.stripByteCounts, type: 4, values: [4] },
        ],
        blocks: [Uint8Array.of(10, 11, 12, 13), Uint8Array.of(14, 15, 16, 17)],
        countTag: 0xfffe,
      }),
    )
    await expect(readTiffImage(tiff, 0)).rejects.toThrow(
      /lists 1 blocks, expected 2/,
    )
  })

  test('decodes 16-bit samples in both byte orders identically', async () => {
    const values = [1, 258, 65535, 4]
    const makeBuffer = (le: boolean): ArrayBuffer => {
      const bytes = new Uint8Array(values.length * 2)
      const view = new DataView(bytes.buffer)
      values.forEach((value, i) => {
        view.setUint16(i * 2, value, le)
      })
      return buildTiff({
        entries: baseEntries(2, 2, 16),
        blocks: [bytes],
        littleEndian: le,
      })
    }
    const little = await readTiffImage(parseTiff(makeBuffer(true)), 0)
    const big = await readTiffImage(parseTiff(makeBuffer(false)), 0)
    expect(Array.from(little.data)).toEqual(values)
    expect(Array.from(big.data)).toEqual(values)
    expect(little.data).toBeInstanceOf(Uint16Array)
  })

  test('decodes float32 samples', async () => {
    const values = [0.5, -1.25, 1e6, 0]
    const bytes = new Uint8Array(16)
    const view = new DataView(bytes.buffer)
    values.forEach((value, i) => {
      view.setFloat32(i * 4, value, true)
    })
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(2, 2, 32, [
          {
            tag: TIFF_TAG.sampleFormat,
            type: 3,
            values: [SAMPLE_FORMAT.float],
          },
        ]),
        blocks: [bytes],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(image.data).toBeInstanceOf(Float32Array)
    expect(Array.from(image.data)).toEqual(values)
  })

  test('decodes signed 16-bit samples', async () => {
    const values = [-32768, -1, 0, 32767]
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    values.forEach((value, i) => {
      view.setInt16(i * 2, value, true)
    })
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(4, 1, 16, [
          { tag: TIFF_TAG.sampleFormat, type: 3, values: [SAMPLE_FORMAT.int] },
        ]),
        blocks: [bytes],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(image.data).toBeInstanceOf(Int16Array)
    expect(Array.from(image.data)).toEqual(values)
  })

  test('decodes PackBits strips', async () => {
    const pixels = Uint8Array.from({ length: 12 }, (_unused, i) => i * 7)
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(4, 3, 8, [
          { tag: TIFF_TAG.compression, type: 3, values: [32773] },
        ]).filter(
          (entry, i, all) =>
            // Drop the default compression entry the helper added first.
            !(entry.tag === TIFF_TAG.compression && all.indexOf(entry) !== i),
        ),
        blocks: [packBitsLiterals(pixels)],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual(Array.from(pixels))
  })

  test('decodes LZW strips', async () => {
    const pixels = Uint8Array.from(
      { length: 40 },
      (_unused, i) => (i * 13) % 256,
    )
    const entries = baseEntries(8, 5, 8)
    entries[3] = { tag: TIFF_TAG.compression, type: 3, values: [5] }
    const tiff = parseTiff(
      buildTiff({ entries, blocks: [lzwLiteralOnly(pixels)] }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual(Array.from(pixels))
  })

  test('undoes the horizontal predictor', async () => {
    // Rows [10, 11, 13] and [20, 22, 25] stored as first-order differences.
    const stored = Uint8Array.of(10, 1, 2, 20, 2, 3)
    const entries = baseEntries(3, 2, 8, [
      { tag: TIFF_TAG.predictor, type: 3, values: [2] },
    ])
    const tiff = parseTiff(buildTiff({ entries, blocks: [stored] }))
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([10, 11, 13, 20, 22, 25])
  })

  test('assembles padded tiles and drops the padding', async () => {
    // A 3x3 image in 2x2 tiles: four tiles, each padded to 4 samples.
    const tile = (values: number[]): Uint8Array => Uint8Array.from(values)
    const entries = [
      { tag: TIFF_TAG.imageWidth, type: 3, values: [3] },
      { tag: TIFF_TAG.imageLength, type: 3, values: [3] },
      { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8] },
      { tag: TIFF_TAG.compression, type: 3, values: [1] },
      { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [1] },
      { tag: TIFF_TAG.tileWidth, type: 3, values: [2] },
      { tag: TIFF_TAG.tileLength, type: 3, values: [2] },
    ]
    const tiff = parseTiff(
      buildTiff({
        entries,
        offsetTag: TIFF_TAG.tileOffsets,
        countTag: TIFF_TAG.tileByteCounts,
        blocks: [
          tile([1, 2, 4, 5]), // top-left
          tile([3, 0, 6, 0]), // top-right, one padding column
          tile([7, 8, 0, 0]), // bottom-left, one padding row
          tile([9, 0, 0, 0]), // bottom-right corner
        ],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('interleaves planar-configuration-2 samples', async () => {
    const entries = [
      { tag: TIFF_TAG.imageWidth, type: 3, values: [2] },
      { tag: TIFF_TAG.imageLength, type: 3, values: [1] },
      { tag: TIFF_TAG.bitsPerSample, type: 3, values: [8, 8, 8] },
      { tag: TIFF_TAG.compression, type: 3, values: [1] },
      { tag: TIFF_TAG.samplesPerPixel, type: 3, values: [3] },
      { tag: TIFF_TAG.rowsPerStrip, type: 3, values: [1] },
      { tag: TIFF_TAG.planarConfiguration, type: 3, values: [2] },
    ]
    const tiff = parseTiff(
      buildTiff({
        entries,
        blocks: [
          Uint8Array.of(1, 2), // red
          Uint8Array.of(3, 4), // green
          Uint8Array.of(5, 6), // blue
        ],
      }),
    )
    const image = await readTiffImage(tiff, 0)
    expect(image.samplesPerPixel).toBe(3)
    expect(Array.from(image.data)).toEqual([1, 3, 5, 2, 4, 6])
  })

  test('reads a BigTIFF container', async () => {
    const pixels = Uint8Array.of(11, 22, 33, 44)
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(2, 2, 8),
        blocks: [pixels],
        bigTiff: true,
      }),
    )
    expect(tiff.isBigTiff).toBe(true)
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([11, 22, 33, 44])
  })

  test('names the unsupported compressor in the error', async () => {
    const entries = baseEntries(2, 1, 8)
    entries[3] = { tag: TIFF_TAG.compression, type: 3, values: [7] }
    const tiff = parseTiff(
      buildTiff({ entries, blocks: [Uint8Array.of(0, 0)] }),
    )
    expect(readTiffImage(tiff, 0)).rejects.toThrow(/JPEG-compressed/)
  })

  test('rejects sub-byte bit depths rather than returning wrong pixels', async () => {
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(8, 1, 1),
        blocks: [Uint8Array.of(0xaa)],
      }),
    )
    expect(readTiffImage(tiff, 0)).rejects.toThrow(/sub-byte packing/)
  })
})

describe('decodePackBits', () => {
  test('expands repeat runs', () => {
    // -3 => repeat the next byte 4 times; 1 => copy the next 2 bytes.
    const input = Uint8Array.of(0xfd, 0x41, 0x01, 0x42, 0x43)
    expect(Array.from(decodePackBits(input, 6))).toEqual([
      0x41, 0x41, 0x41, 0x41, 0x42, 0x43,
    ])
  })

  test('ignores the -128 no-op byte', () => {
    const input = Uint8Array.of(0x80, 0x01, 0x09, 0x08)
    expect(Array.from(decodePackBits(input, 2))).toEqual([9, 8])
  })

  test('never writes past the expected length', () => {
    const input = Uint8Array.of(0xfd, 0x41)
    expect(decodePackBits(input, 2)).toHaveLength(2)
  })
})

describe('decodeLzw', () => {
  test('round-trips a literal-only stream', () => {
    const data = Uint8Array.from({ length: 64 }, (_unused, i) => i * 3)
    expect(Array.from(decodeLzw(lzwLiteralOnly(data), data.length))).toEqual(
      Array.from(data),
    )
  })

  test('expands a back-reference to a code it just defined', () => {
    // Codes: clear, 'A', 'A', 258 (= "AA"), EOI -> "AAAA".
    const bits: number[] = []
    for (const code of [256, 65, 65, 258, 257]) {
      for (let i = 8; i >= 0; i--) {
        bits.push((code >> i) & 1)
      }
    }
    while (bits.length % 8 !== 0) bits.push(0)
    const input = new Uint8Array(bits.length / 8)
    bits.forEach((bit, i) => {
      if (bit) input[i >> 3] |= 1 << (7 - (i & 7))
    })
    expect(Array.from(decodeLzw(input, 4))).toEqual([65, 65, 65, 65])
  })

  test('round-trips a literal stream long enough to widen the code three times', () => {
    // 2000 literals grow the decoder's table past 511, 1023 and 2047, so the
    // builder must widen its writes at the same early-change points or the
    // stream desyncs after ~253 bytes.
    const data = Uint8Array.from(
      { length: 2000 },
      (_unused, i) => (i * 7) & 0xff,
    )
    expect(Array.from(decodeLzw(lzwLiteralOnly(data), data.length))).toEqual(
      Array.from(data),
    )
  })
})

describe('tiffResolutionMm', () => {
  test('converts dots-per-inch to millimetres', () => {
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(1, 1, 8, [
          { tag: TIFF_TAG.xResolution, type: 5, values: [254] },
          { tag: TIFF_TAG.yResolution, type: 5, values: [127] },
          { tag: TIFF_TAG.resolutionUnit, type: 3, values: [2] },
        ]),
        blocks: [Uint8Array.of(1)],
      }),
    )
    const resolution = tiffResolutionMm(tiff.ifds[0])
    expect(resolution?.x).toBeCloseTo(0.1, 6)
    expect(resolution?.y).toBeCloseTo(0.2, 6)
  })

  test('returns undefined when the unit carries no physical length', () => {
    const tiff = parseTiff(
      buildTiff({
        entries: baseEntries(1, 1, 8, [
          { tag: TIFF_TAG.xResolution, type: 5, values: [72] },
          { tag: TIFF_TAG.yResolution, type: 5, values: [72] },
          { tag: TIFF_TAG.resolutionUnit, type: 3, values: [1] },
        ]),
        blocks: [Uint8Array.of(1)],
      }),
    )
    expect(tiffResolutionMm(tiff.ifds[0])).toBeUndefined()
  })
})

/** Pack `values` as fixed-width samples, wrapping negatives per TIFF. */
function sampleBytes(
  values: number[],
  bitsPerSample: number,
  littleEndian: boolean,
): Uint8Array {
  const bytes = bitsPerSample >> 3
  const out = new Uint8Array(values.length * bytes)
  const view = new DataView(out.buffer)
  values.forEach((value, i) => {
    if (bytes === 1) {
      out[i] = value & 0xff
    } else if (bytes === 2) {
      view.setUint16(i * 2, value & 0xffff, littleEndian)
    } else {
      view.setUint32(i * 4, value >>> 0, littleEndian)
    }
  })
  return out
}

/** Read fixed-width unsigned samples back out of a block. */
function readSampleValues(
  block: Uint8Array,
  bitsPerSample: number,
  littleEndian: boolean,
): number[] {
  const bytes = bitsPerSample >> 3
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
  const out: number[] = []
  for (let at = 0; at < block.byteLength; at += bytes) {
    if (bytes === 1) {
      out.push(block[at])
    } else if (bytes === 2) {
      out.push(view.getUint16(at, littleEndian))
    } else {
      out.push(view.getUint32(at, littleEndian))
    }
  }
  return out
}

describe('applyHorizontalPredictor', () => {
  // Each case stores per-row first-order differences and expects the
  // reconstructed samples; every arithmetic branch (byte, 16-bit, 32-bit)
  // is covered in both byte orders where the width makes them differ.
  const cases: Array<{
    name: string
    bits: number
    samplesPerPixel: number
    littleEndian: boolean
    stored: number[][]
    expected: number[][]
  }> = [
    {
      name: '8-bit rows, wrapping at 256',
      bits: 8,
      samplesPerPixel: 1,
      littleEndian: true,
      stored: [
        [10, 1, 2],
        [250, 10, 3],
      ],
      expected: [
        [10, 11, 13],
        [250, 4, 7],
      ],
    },
    {
      name: '8-bit RGB adds within each channel',
      bits: 8,
      samplesPerPixel: 3,
      littleEndian: true,
      stored: [[10, 20, 30, 1, 2, 3]],
      expected: [[10, 20, 30, 11, 22, 33]],
    },
    {
      name: '16-bit little-endian rows, wrapping at 65536',
      bits: 16,
      samplesPerPixel: 1,
      littleEndian: true,
      stored: [
        [1000, 10, 20],
        [65530, 10, 2],
      ],
      expected: [
        [1000, 1010, 1030],
        [65530, 4, 6],
      ],
    },
    {
      name: '16-bit big-endian rows',
      bits: 16,
      samplesPerPixel: 1,
      littleEndian: false,
      stored: [
        [1000, 10, 20],
        [65530, 10, 2],
      ],
      expected: [
        [1000, 1010, 1030],
        [65530, 4, 6],
      ],
    },
    {
      name: '16-bit RGB adds within each channel',
      bits: 16,
      samplesPerPixel: 3,
      littleEndian: true,
      stored: [[100, 200, 300, 5, 65530, 7]],
      expected: [[100, 200, 300, 105, 194, 307]],
    },
    {
      name: '32-bit rows, wrapping at 2^32',
      bits: 32,
      samplesPerPixel: 1,
      littleEndian: true,
      stored: [[100000, 10, 4294967286]],
      expected: [[100000, 100010, 100000]],
    },
  ]

  for (const c of cases) {
    test(c.name, () => {
      const block = sampleBytes(c.stored.flat(), c.bits, c.littleEndian)
      applyHorizontalPredictor(
        block,
        c.stored.length,
        c.stored[0].length / c.samplesPerPixel,
        c.samplesPerPixel,
        c.bits,
        c.littleEndian,
      )
      expect(readSampleValues(block, c.bits, c.littleEndian)).toEqual(
        c.expected.flat(),
      )
    })
  }

  test('rejects 64-bit samples', () => {
    expect(() =>
      applyHorizontalPredictor(new Uint8Array(16), 1, 2, 1, 64, true),
    ).toThrow(/64-bit/)
  })

  test('is applied to 16-bit strips by readTiffImage', async () => {
    // The dominant fluorescence OME-TIFF shape: 16-bit samples with the
    // predictor tag. Stored differences must come back as absolute values.
    const stored = sampleBytes([1000, 10, 20, 2000, 65526, 65531], 16, true)
    const entries = baseEntries(3, 2, 16, [
      { tag: TIFF_TAG.predictor, type: 3, values: [2] },
    ])
    const tiff = parseTiff(buildTiff({ entries, blocks: [stored] }))
    const image = await readTiffImage(tiff, 0)
    expect(Array.from(image.data)).toEqual([1000, 1010, 1030, 2000, 1990, 1985])
  })
})

describe('sampleArrayCtor', () => {
  const cases: Array<{
    bits: number
    format: number
    formatName: string
    ctor: ReturnType<typeof sampleArrayCtor>
    ctorName: string
  }> = [
    {
      bits: 8,
      format: SAMPLE_FORMAT.uint,
      formatName: 'uint',
      ctor: Uint8Array,
      ctorName: 'Uint8Array',
    },
    {
      bits: 16,
      format: SAMPLE_FORMAT.uint,
      formatName: 'uint',
      ctor: Uint16Array,
      ctorName: 'Uint16Array',
    },
    {
      bits: 32,
      format: SAMPLE_FORMAT.uint,
      formatName: 'uint',
      ctor: Uint32Array,
      ctorName: 'Uint32Array',
    },
    {
      bits: 8,
      format: SAMPLE_FORMAT.int,
      formatName: 'int',
      ctor: Int8Array,
      ctorName: 'Int8Array',
    },
    {
      bits: 16,
      format: SAMPLE_FORMAT.int,
      formatName: 'int',
      ctor: Int16Array,
      ctorName: 'Int16Array',
    },
    {
      bits: 32,
      format: SAMPLE_FORMAT.int,
      formatName: 'int',
      ctor: Int32Array,
      ctorName: 'Int32Array',
    },
    {
      bits: 32,
      format: SAMPLE_FORMAT.float,
      formatName: 'float',
      ctor: Float32Array,
      ctorName: 'Float32Array',
    },
    {
      bits: 64,
      format: SAMPLE_FORMAT.float,
      formatName: 'float',
      ctor: Float64Array,
      ctorName: 'Float64Array',
    },
  ]

  for (const c of cases) {
    test(`${c.bits}-bit ${c.formatName} maps to ${c.ctorName}`, () => {
      expect(sampleArrayCtor(c.bits, c.format)).toBe(c.ctor)
    })
  }

  test('rejects unsupported widths per format', () => {
    expect(() => sampleArrayCtor(16, SAMPLE_FORMAT.float)).toThrow(
      /16-bit float samples/,
    )
    expect(() => sampleArrayCtor(64, SAMPLE_FORMAT.int)).toThrow(
      /64-bit signed samples/,
    )
    expect(() => sampleArrayCtor(64, SAMPLE_FORMAT.uint)).toThrow(
      /64-bit samples/,
    )
  })
})
