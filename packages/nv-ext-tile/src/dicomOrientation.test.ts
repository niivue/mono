import { describe, expect, spyOn, test } from 'bun:test'
import { NVSlide, type SlideTileSource } from '@niivue/niivue'
import type { SlideIndexSlide } from './dicomIndex'
import { levelMaps } from './dicomOrientation'
import { manifestOf } from './dicomWsiSource'

// A 5x3 slide stored in 3x2 tiles (2x2 grid, padded right and bottom); stored
// pixel (c, r) holds c + 10 r, padding 255.
const W = 5
const H = 3
const TW = 3
const TH = 2
const slideWith = (cosines: number[]): SlideIndexSlide => ({
  study: 's',
  series: 's',
  frameOfReference: 'f',
  opticalPath: '1',
  focalPlane: 0,
  imageOrientationSlide: cosines,
  pixelSpacingMM: [0.25, 0.5],
  instances: [
    {
      id: 'i',
      file: 'a.dcm',
      size: 0,
      version: '0',
      transferSyntax: '1.2.840.10008.1.2.4.50',
      photometric: 'MONOCHROME2',
      bitsStored: 8,
    },
  ],
  levels: [
    {
      width: W,
      height: H,
      tileWidth: TW,
      tileHeight: TH,
      columns: 2,
      rows: 2,
      instances: [0],
      frames: {
        instance: new Uint32Array(4),
        frame: Uint32Array.from([1, 2, 3, 4]),
        offset: new Float64Array(4),
        length: new Uint32Array(4),
        tile: Int32Array.from([0, 1, 2, 3]),
      },
      duplicates: 0,
      holes: 0,
      sparse: false,
    },
  ],
})

// Raw 8-bit samples of each stored frame, cropped to what the decoder is told
// (a flipped axis keeps its padding).
function sourceOf(slide: SlideIndexSlide): SlideTileSource {
  const maps = levelMaps(slide)
  const manifest = manifestOf(slide, maps, { fileUrl: () => 'a.dcm' })
  for (const level of manifest.levels) level.codec = 'raw-gray'
  return {
    manifest,
    bind() {},
    async fetchTileBytes(level, tile) {
      const stored = (maps[0] as Int32Array)[tile.y * level.columns + tile.x]
      const sc = (stored as number) % 2
      const sr = Math.floor((stored as number) / 2)
      const [w, h] = level.tileOrientation?.transpose
        ? [tile.height, tile.width]
        : [tile.width, tile.height]
      const out = new Uint8Array(w * h)
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const c = sc * TW + i
          const r = sr * TH + j
          out[j * w + i] = c < W && r < H ? c + 10 * r : 255
        }
      return out
    },
  }
}

describe('ImageOrientationSlide', () => {
  test('each right-angle orientation shows the slide in the label-left frame; oblique shows as stored', async () => {
    // Displayed u = -slide Y, v = -slide X (dicomOrientation.ts); the first
    // row is what every corpus scanner writes.
    const table = [
      [0, -1, 0, -1, 0, 0],
      [0, 1, 0, -1, 0, 0],
      [0, -1, 0, 1, 0, 0],
      [0, 1, 0, 1, 0, 0],
      [-1, 0, 0, 0, -1, 0],
      [1, 0, 0, 0, -1, 0],
      [-1, 0, 0, 0, 1, 0],
      [1, 0, 0, 0, 1, 0],
    ]
    for (const cosines of table) {
      const [rx, ry, , cx, cy] = cosines as number[]
      // Stored (c, r) lands at c (-ry, -rx) + r (-cy, -cx), shifted to the origin.
      const at = (c: number, r: number) => [
        -c * (ry as number) - r * (cy as number),
        -c * (rx as number) - r * (cx as number),
      ]
      const corners = [at(0, 0), at(W - 1, 0), at(0, H - 1), at(W - 1, H - 1)]
      const u0 = Math.min(...corners.map(([u]) => u as number))
      const v0 = Math.min(...corners.map(([, v]) => v as number))
      const transposed = rx !== 0
      const [dw, dh] = transposed ? [H, W] : [W, H]
      const source = sourceOf(slideWith(cosines))
      const { manifest } = source
      expect([manifest.width, manifest.height]).toEqual([dw, dh])
      expect(manifest.pixelSpacingMM).toEqual(
        transposed ? [0.5, 0.25] : [0.25, 0.5],
      )
      const slide = NVSlide.fromSource(source)
      const shown: number[] = []
      const want: number[] = []
      for (let r = 0; r < H; r++)
        for (let c = 0; c < W; c++) {
          const [u, v] = at(c, r)
          const [s] = await slide.loadSampleAt(
            (u as number) - u0 + 0.5,
            (v as number) - v0 + 0.5,
          )
          shown.push(s?.stored ?? -1)
          want.push(c + 10 * r)
        }
      expect(shown).toEqual(want)
      slide.dispose()
    }
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const oblique = sourceOf(slideWith([0.6, -0.8, 0, -0.8, -0.6, 0]))
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    expect(oblique.manifest.levels[0]?.tileOrientation).toBeUndefined()
    expect([oblique.manifest.width, oblique.manifest.height]).toEqual([W, H])
  })
})
