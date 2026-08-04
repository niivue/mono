import { describe, expect, test } from 'bun:test'
import {
  decodeLzw,
  decodePackBits,
  parseTiff,
  readTiffImage,
  SAMPLE_FORMAT,
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
