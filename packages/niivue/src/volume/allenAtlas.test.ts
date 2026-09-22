import { describe, expect, test } from 'bun:test'

import {
  allenAtlasSpacing,
  allenAtlasVolumeDims,
  deinterleaveAllenAtlasPlane,
  findAllenAtlasChannel,
  parseAllenAtlasInfo,
} from './allenAtlas'

/** Shaped like the live IMSC sidecar, shrunk to a 2x2 grid of 2x2 tiles. */
const SIDECAR = {
  width: 4,
  height: 3,
  channels: 4,
  channel_names: ['DNA', 'ACTB', 'FBL', 'LMNB1'],
  rows: 2,
  cols: 2,
  tiles: 3,
  tile_width: 2,
  tile_height: 2,
  atlas_width: 4,
  atlas_height: 4,
  pixel_size_x: 1,
  pixel_size_y: 1,
  pixel_size_z: 2.9,
  images: [
    { name: 'a_0.png', channels: [0, 1, 2] },
    { name: 'a_1.png', channels: [3] },
  ],
}

describe('parseAllenAtlasInfo', () => {
  test('reads the live sidecar shape', () => {
    const info = parseAllenAtlasInfo(SIDECAR)
    expect(info.channels).toBe(4)
    expect(info.tiles).toBe(3)
    expect(info.channelNames).toEqual(['DNA', 'ACTB', 'FBL', 'LMNB1'])
    expect(info.pixelSize).toEqual([1, 1, 2.9])
    expect(info.spacingUnit).toBe('um')
    expect(info.times).toBe(1)
    expect(info.images).toHaveLength(2)
  })

  test('derives atlas dims when the sidecar omits them', () => {
    const { atlas_width: _w, atlas_height: _h, ...rest } = SIDECAR
    const info = parseAllenAtlasInfo(rest)
    expect(info.atlasWidth).toBe(4)
    expect(info.atlasHeight).toBe(4)
  })

  test('rejects an atlas size that contradicts the tile grid', () => {
    expect(() => parseAllenAtlasInfo({ ...SIDECAR, atlas_width: 5 })).toThrow(
      /does not match/,
    )
  })

  test('rejects more tiles than the grid holds', () => {
    expect(() => parseAllenAtlasInfo({ ...SIDECAR, tiles: 5 })).toThrow(
      /do not fit/,
    )
  })

  test('rejects a channel index past the declared count', () => {
    expect(() =>
      parseAllenAtlasInfo({
        ...SIDECAR,
        images: [{ name: 'a_0.png', channels: [0, 9] }],
      }),
    ).toThrow(/past the declared/)
  })

  const badInts: Array<[string, number]> = [
    ['fractional', 2.5],
    ['zero', 0],
    ['negative', -3],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ]
  for (const field of ['channels', 'tiles', 'tile_width', 'times', 'width']) {
    for (const [label, value] of badInts) {
      test(`rejects a ${label} '${field}'`, () => {
        expect(() =>
          parseAllenAtlasInfo({ ...SIDECAR, [field]: value }),
        ).toThrow(/positive integer/)
      })
    }
  }

  test('keeps channel colours positional across an invalid entry', () => {
    const info = parseAllenAtlasInfo({
      ...SIDECAR,
      channel_colors: [[255, 0, 0], 'nope', [0, 0, 255], [1, 2]],
    })
    expect(info.channelColors).toEqual([[255, 0, 0], null, [0, 0, 255], null])
  })

  test('treats malformed or out-of-range colour components as absent', () => {
    const info = parseAllenAtlasInfo({
      ...SIDECAR,
      channel_colors: [
        [255, 'x', 0],
        [0, -1, 0],
        [0, 256, 0],
        [Number.NaN, 0, 0],
        [0, Number.POSITIVE_INFINITY, 0],
        [12, 34, 56],
      ],
    })
    expect(info.channelColors).toEqual([
      null,
      null,
      null,
      null,
      null,
      [12, 34, 56],
    ])
  })

  test('yields no channel colours when the sidecar omits them', () => {
    expect(parseAllenAtlasInfo(SIDECAR).channelColors).toEqual([])
  })

  test('names channels when the sidecar omits channel_names', () => {
    const { channel_names: _n, ...rest } = SIDECAR
    expect(parseAllenAtlasInfo(rest).channelNames).toEqual([
      'Channel 0',
      'Channel 1',
      'Channel 2',
      'Channel 3',
    ])
  })
})

describe('allenAtlasSpacing', () => {
  test('scales XY by the atlas downsample ratio and leaves Z alone', () => {
    const info = parseAllenAtlasInfo(SIDECAR)
    // 4 original px stored in 2 tile px -> each stored voxel spans 2 originals.
    expect(allenAtlasSpacing(info)).toEqual([2, 1.5, 2.9])
    expect(allenAtlasVolumeDims(info)).toEqual([2, 2, 3])
  })

  test('is a no-op when tiles hold the full-resolution slice', () => {
    const info = parseAllenAtlasInfo({
      ...SIDECAR,
      width: 2,
      height: 2,
      pixel_size_x: 0.5,
      pixel_size_y: 0.25,
    })
    expect(allenAtlasSpacing(info)).toEqual([0.5, 0.25, 2.9])
  })
})

describe('deinterleaveAllenAtlasPlane', () => {
  const info = parseAllenAtlasInfo(SIDECAR)

  /**
   * Paint a 4x4 RGBA atlas where R encodes the tile index, G the pixel's
   * position within its tile, and B a constant, so a wrong tile origin or a
   * wrong plane is visible in the output rather than plausible.
   */
  function paintAtlas(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let t = 0; t < 4; t++) {
      const tileX = (t % 2) * 2
      const tileY = Math.floor(t / 2) * 2
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          const i = ((tileY + y) * 4 + tileX + x) * 4
          data[i] = 10 * (t + 1)
          data[i + 1] = y * 2 + x
          data[i + 2] = 200
          data[i + 3] = 255
        }
      }
    }
    return data
  }

  test('walks tiles row-major and emits z-major voxels', () => {
    const out = deinterleaveAllenAtlasPlane(paintAtlas(), info, 0)
    expect(out).toHaveLength(2 * 2 * 3)
    // Tile 0 fills the first slice, tile 1 the second, tile 2 the third; the
    // unused 4th tile is dropped because `tiles` is 3.
    expect(Array.from(out.slice(0, 4))).toEqual([10, 10, 10, 10])
    expect(Array.from(out.slice(4, 8))).toEqual([20, 20, 20, 20])
    expect(Array.from(out.slice(8, 12))).toEqual([30, 30, 30, 30])
  })

  test('preserves in-tile pixel order on the green plane', () => {
    const out = deinterleaveAllenAtlasPlane(paintAtlas(), info, 1)
    expect(Array.from(out.slice(0, 4))).toEqual([0, 1, 2, 3])
  })

  test('reads a different channel from each colour plane', () => {
    const blue = deinterleaveAllenAtlasPlane(paintAtlas(), info, 2)
    expect(new Set(blue)).toEqual(new Set([200]))
  })

  test('rejects a plane outside RGBA and a wrongly sized buffer', () => {
    expect(() => deinterleaveAllenAtlasPlane(paintAtlas(), info, 4)).toThrow(
      /out of range/,
    )
    expect(() =>
      deinterleaveAllenAtlasPlane(new Uint8Array(8), info, 0),
    ).toThrow(/expected 64/)
  })
})

describe('findAllenAtlasChannel', () => {
  const info = parseAllenAtlasInfo(SIDECAR)

  test('maps a channel to its atlas file and colour plane', () => {
    expect(findAllenAtlasChannel(info, 0)).toEqual({
      image: info.images[0],
      plane: 0,
    })
    expect(findAllenAtlasChannel(info, 2)).toEqual({
      image: info.images[0],
      plane: 2,
    })
    // The trailing atlas carries a single channel in its red plane.
    expect(findAllenAtlasChannel(info, 3)).toEqual({
      image: info.images[1],
      plane: 0,
    })
  })

  test('returns undefined for an unmapped channel', () => {
    expect(findAllenAtlasChannel(info, 99)).toBeUndefined()
  })
})
