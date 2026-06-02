import { describe, expect, test } from 'bun:test'
import {
  buildPyramid,
  classifyImageType,
  frameIndexForTile,
  jpegColorTransform,
  tileRangeForBbox,
  tilesAcross,
  tilesDown,
  type WsiInstanceMeta,
} from './dicomWsi.ts'

// Ground truth from `dcmdump` on the CPTAC-BRCA series 37cb2625: four VOLUME
// pyramid levels plus label/overview/thumbnail, all 240x240 tiles.
function meta(
  partial: Partial<WsiInstanceMeta> & {
    width: number
    height: number
    imageType: string
  },
): WsiInstanceMeta {
  return {
    file: partial.file ?? 'f.dcm',
    width: partial.width,
    height: partial.height,
    tileWidth: partial.tileWidth ?? 240,
    tileHeight: partial.tileHeight ?? 240,
    frames: partial.frames ?? 1,
    tiledFull: partial.tiledFull ?? true,
    encapsulated: partial.encapsulated ?? true,
    photometric: partial.photometric ?? 'RGB',
    imageType: partial.imageType,
    flavor: classifyImageType(partial.imageType),
    spacingMM: partial.spacingMM ?? [1, 1],
  }
}

const SERIES = [
  meta({
    width: 53783,
    height: 49534,
    imageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
    frames: 46575,
    file: 'l0.dcm',
  }),
  meta({
    width: 1680,
    height: 1547,
    imageType: 'DERIVED\\PRIMARY\\VOLUME\\RESAMPLED',
    frames: 49,
    file: 'l3.dcm',
  }),
  meta({
    width: 13445,
    height: 12383,
    imageType: 'DERIVED\\PRIMARY\\VOLUME\\RESAMPLED',
    frames: 2964,
    file: 'l1.dcm',
  }),
  meta({
    width: 3361,
    height: 3095,
    imageType: 'DERIVED\\PRIMARY\\VOLUME\\RESAMPLED',
    frames: 195,
    file: 'l2.dcm',
  }),
  meta({ width: 666, height: 716, imageType: 'DERIVED\\PRIMARY\\LABEL\\NONE' }),
  meta({
    width: 1600,
    height: 629,
    imageType: 'DERIVED\\PRIMARY\\OVERVIEW\\NONE',
  }),
  meta({
    width: 833,
    height: 768,
    imageType: 'DERIVED\\PRIMARY\\THUMBNAIL\\RESAMPLED',
  }),
]

describe('classifyImageType', () => {
  test('maps ImageType to flavor', () => {
    expect(classifyImageType('DERIVED\\PRIMARY\\VOLUME\\NONE')).toBe('volume')
    expect(classifyImageType('DERIVED\\PRIMARY\\LABEL\\NONE')).toBe('label')
    expect(classifyImageType('DERIVED\\PRIMARY\\OVERVIEW\\NONE')).toBe(
      'overview',
    )
    expect(classifyImageType('DERIVED\\PRIMARY\\THUMBNAIL\\RESAMPLED')).toBe(
      'thumbnail',
    )
    expect(classifyImageType('SOMETHING\\ELSE')).toBe('other')
  })
})

describe('jpegColorTransform', () => {
  test('RGB frames decode without the YCbCr transform', () => {
    expect(jpegColorTransform('RGB')).toBe(false)
  })
  test('YBR frames decode with the transform', () => {
    expect(jpegColorTransform('YBR_FULL_422')).toBe(true)
    expect(jpegColorTransform('YBR_ICT')).toBe(true)
  })
})

describe('buildPyramid', () => {
  test('keeps only VOLUME tiers, ordered highest-resolution first', () => {
    const levels = buildPyramid(SERIES)
    expect(levels.map((l) => l.level)).toEqual([0, 1, 2, 3])
    expect(levels.map((l) => l.width)).toEqual([53783, 13445, 3361, 1680])
    expect(levels.map((l) => l.height)).toEqual([49534, 12383, 3095, 1547])
  })

  test('drops label/overview/thumbnail', () => {
    const levels = buildPyramid(SERIES)
    expect(levels.length).toBe(4)
    expect(levels.every((l) => l.flavor === 'volume')).toBe(true)
  })
})

describe('TILED_FULL tile geometry', () => {
  // The product tilesAcross * tilesDown must equal NumberOfFrames for every
  // level — this is the invariant that proves the frame-index math is right.
  test.each(
    buildPyramid(SERIES),
  )('tile grid matches NumberOfFrames (level %#)', (level) => {
    expect(tilesAcross(level) * tilesDown(level)).toBe(level.frames)
  })

  test('frame index is column-fastest raster order', () => {
    const l3 = buildPyramid(SERIES)[3] // 1680x1547, 7x7 grid
    expect(tilesAcross(l3)).toBe(7)
    expect(tilesDown(l3)).toBe(7)
    expect(frameIndexForTile(l3, 0, 0)).toBe(0)
    expect(frameIndexForTile(l3, 6, 0)).toBe(6)
    expect(frameIndexForTile(l3, 0, 1)).toBe(7)
    expect(frameIndexForTile(l3, 6, 6)).toBe(48)
  })
})

describe('tileRangeForBbox', () => {
  const l3 = buildPyramid(SERIES)[3] // 1680x1547, tiles 240

  test('a 128-cube near the origin hits one tile', () => {
    const r = tileRangeForBbox(l3, 0, 0, 128, 128)
    expect(r).toEqual({ colStart: 0, colEnd: 1, rowStart: 0, rowEnd: 1 })
  })

  test('a bbox spanning a tile boundary hits two columns', () => {
    const r = tileRangeForBbox(l3, 200, 0, 300, 100)
    expect(r.colStart).toBe(0)
    expect(r.colEnd).toBe(2)
  })

  test('clamps to the level extent', () => {
    const r = tileRangeForBbox(l3, 1600, 1500, 9999, 9999)
    expect(r.colEnd).toBe(tilesAcross(l3))
    expect(r.rowEnd).toBe(tilesDown(l3))
  })
})
