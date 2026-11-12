import { describe, expect, test } from 'bun:test'
import { ndpiGrid, ndpiJpeg, ndpiTileJpeg } from './ndpi'

// SOI, SOF0 (16 x 32, 3 components 1x1), DRI 2, SOS: a header only.
const header = Uint8Array.of(
  0xff,
  0xd8,
  0xff,
  0xc0,
  0,
  17,
  8,
  0,
  16,
  0,
  32,
  3,
  1,
  0x11,
  0,
  2,
  0x11,
  1,
  3,
  0x11,
  1,
  0xff,
  0xdd,
  0,
  4,
  0,
  2,
  0xff,
  0xda,
  0,
  12,
  3,
  1,
  0,
  2,
  0x11,
  3,
  0x11,
  0,
  63,
  0,
)

describe('ndpi', () => {
  test('reads the strip layout: 8 px MCUs, 2 intervals of 2 MCUs per row', () => {
    const j = ndpiJpeg(header, 32, 16)
    expect([
      j.width,
      j.height,
      j.mcuWidth,
      j.interval,
      j.perRow,
      j.mcuRows,
    ]).toEqual([32, 16, 8, 2, 2, 2])
    expect(j.header.length).toBe(header.length)
    expect(ndpiGrid(j, 16)).toEqual({
      across: 1,
      down: 2,
      tileWidth: 16,
      tileHeight: 16,
      columns: 2,
      rows: 1,
    })
  })

  test('takes the level size from the TIFF, not the 16-bit SOF fields', () => {
    // A 70016 x 16 level: its SOF width field wraps to 70016 - 65536 = 4480.
    const wide = header.slice()
    wide[9] = 4480 >> 8
    wide[10] = 4480 & 255
    const j = ndpiJpeg(wide, 70016, 16)
    expect([j.width, j.perRow, j.mcuRows]).toEqual([70016, 4376, 2])
    expect(ndpiGrid(j, 512).columns).toBe(Math.ceil(4376 / 32))
  })

  test('rejects progressive JPEG and intervals that do not tile a row', () => {
    const progressive = header.slice()
    progressive[3] = 0xc2
    expect(() => ndpiJpeg(progressive, 32, 16)).toThrow(/baseline/)
    const odd = header.slice()
    odd[26] = 3 // DRI 3 MCUs; 4 per row
    expect(() => ndpiJpeg(odd, 32, 16)).toThrow(/tile its rows/)
  })

  test('a tile wraps its intervals with renumbered RST markers and its own size', () => {
    const j = ndpiJpeg(header, 32, 16)
    // Column 1's intervals (strip intervals 1 and 3), each read to its end marker.
    const out = ndpiTileJpeg(j, 16, 16, [
      { bytes: Uint8Array.of(0xa1, 0xa2, 0xff, 0xd2), ends: [2] },
      { bytes: Uint8Array.of(0xb1, 0xff, 0xd9), ends: [1] },
    ])
    expect(Array.from(out.subarray(j.sof, j.sof + 4))).toEqual([0, 16, 0, 16])
    expect(Array.from(out.subarray(header.length))).toEqual([
      0xa1, 0xa2, 0xff, 0xd0, 0xb1, 0xff, 0xd9,
    ])
    expect(() =>
      ndpiTileJpeg(j, 16, 16, [
        { bytes: Uint8Array.of(1, 2, 3, 4), ends: [2] },
      ]),
    ).toThrow(/restart marker/)
  })
})
