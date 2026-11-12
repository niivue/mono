import { describe, expect, spyOn, test } from 'bun:test'
import { log } from '@/logger'
import {
  NVSlide,
  type NVSlideLevelManifest,
  type NVSlideManifest,
  type NVSlidePlacedPiece,
} from '@/slide/NVSlide'
import { slidePlaneTiles } from '@/slide/slidePlane'
import type { SlideTileSource } from '@/slide/slideSource'

// PL2 through NVSlide: 3 frames of 16 px, a 4 px overlap at seam 1|2 split at
// its midpoint (frame 1 keeps 0-13, frame 2 starts at its col 2), so the placed
// width is 44. Sample (tile t, col c) holds 20 t + c.
const PIECES: NVSlidePlacedPiece[] = [
  { tile: 0, sx: 0, sy: 0, sw: 14, sh: 16, dx: 0, dy: 0 },
  { tile: 1, sx: 2, sy: 0, sw: 14, sh: 16, dx: 14, dy: 0 },
  { tile: 2, sx: 0, sy: 0, sw: 16, sh: 16, dx: 28, dy: 0 },
]

function placedSlide(pieces = PIECES): NVSlide {
  const level: NVSlideLevelManifest = {
    ...{ index: 0, width: 48, height: 16, downsample: 1, columns: 3, rows: 1 },
    ...{ tileWidth: 16, tileHeight: 16 },
    tiles: [0, 1, 2].map((x) => ({ x, y: 0, width: 16, height: 16 })),
    placement: { width: 44, height: 16, pieces },
  }
  const manifest: NVSlideManifest = {
    ...{ id: 'placed', name: 'placed', width: 44, height: 16 },
    ...{ dtype: 'uint8', channels: 'gray', levels: [level] },
    channelInfo: [{ name: 'c0', active: true }],
  }
  const source: SlideTileSource = {
    manifest,
    bind: () => {},
    fetchTileBytes: () => Promise.reject(new Error('samples only')),
    fetchTileSamples: async (_level, tile) => {
      const samples = new Uint8Array(256)
      for (let i = 0; i < 256; i++) samples[i] = 20 * tile.x + (i % 16)
      return { samples, width: 16, height: 16, bitsStored: 8, planes: 1 }
    },
  }
  return NVSlide.fromSource(source)
}

const screen = { widthCss: 44, heightCss: 16, devicePixelRatio: 1 }
const view = { centerX: 22, centerY: 8, scale: 1 }

describe('placed tiles through NVSlide (SRC-20)', () => {
  test('the 2D walk draws each piece cropped at its placed origin', () => {
    const slide = placedSlide()
    slide.setViewport(view)
    const { tiles } = slide.visibleTiles(screen)
    expect(
      tiles.map((t) => [t.tile.x, t.screenX, t.screenWidth, t.src?.x]),
    ).toEqual([
      [0, 0, 14, 0],
      [1, 14, 14, 2],
      [2, 28, 16, 0],
    ])
    slide.dispose()
  })

  test('readout follows the placement (PL2): x 13 is frame 1 col 13, x 14 frame 2 col 2', async () => {
    const slide = placedSlide()
    const at = async (x: number) =>
      (await slide.loadSampleAt(x, 4))[0]?.stored ?? null
    expect(await at(13)).toBe(13)
    expect(await at(14)).toBe(22)
    expect(await at(43)).toBe(55)
    slide.dispose()
  })

  test('the 3D plane places the same quads as the 2D walk (PL9)', () => {
    const slide = placedSlide()
    slide.setViewport(view)
    const flat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const quads = slidePlaneTiles(slide, level, flat)
    const tiles = slide.visibleTiles(screen).tiles
    expect(quads.map((q) => [q.corners[0][0], q.corners[3][0]])).toEqual(
      tiles.map((t) => [t.screenX, t.screenX + t.screenWidth]),
    )
    expect(quads.map((q) => q.src)).toEqual(tiles.map((t) => t.src))
    slide.dispose()
  })

  test('an invalid placement warns and draws the grid', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const bad = [...PIECES, { ...PIECES[0], tile: 9 } as NVSlidePlacedPiece]
    const slide = placedSlide(bad)
    slide.setViewport({ centerX: 22, centerY: 8, scale: 1 })
    const { tiles } = slide.visibleTiles(screen)
    expect(tiles.every((t) => t.src === undefined)).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    slide.dispose()
  })
})
