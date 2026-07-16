import { afterEach, describe, expect, it } from 'bun:test'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideTileSource,
} from './NVSlide'
import { NVSlide } from './NVSlide'

const TILE_W = 8
const TILE_H = 4
const DECODED_TILE_BYTES = TILE_W * TILE_H * 4

function makeManifest(tileCount: number): NVSlideManifest {
  const tiles: NVSlideTileManifest[] = []
  for (let x = 0; x < tileCount; x++) {
    tiles.push({ x, y: 0, width: TILE_W, height: TILE_H, frame: x + 1 })
  }
  return {
    id: 'test-slide',
    name: 'Test slide',
    width: TILE_W * tileCount,
    height: TILE_H,
    tileSize: TILE_W,
    dtype: 'uint8',
    channels: 'encoded-rgb',
    levels: [
      {
        index: 0,
        width: TILE_W * tileCount,
        height: TILE_H,
        downsample: 1,
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        columns: tileCount,
        rows: 1,
        codec: 'image/jpeg',
        tiles,
      },
    ],
  }
}

// A tile source that resolves each fetch on a timer and records how many
// fetches are outstanding at once.
class CountingSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  current = 0
  peak = 0
  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }
  bind(): void {}
  fetchTileBytes(
    _level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
  ): Promise<Uint8Array> {
    this.current++
    this.peak = Math.max(this.peak, this.current)
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.current--
        if (tile.frame === -1) reject(new Error('tile fetch failed'))
        else resolve(new Uint8Array(16))
      }, 1)
    })
  }
}

const fakeBitmap = () =>
  ({ width: TILE_W, height: TILE_H, close() {} }) as unknown as ImageBitmap

const originalJpegDecoder = NVSlide.tileDecoder('image/jpeg')

afterEach(() => {
  if (originalJpegDecoder) {
    NVSlide.registerTileDecoder('image/jpeg', originalJpegDecoder)
  }
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('NVSlide tile loading', () => {
  it('caps concurrent fetch+decode at maxConcurrentLoads and completes all tiles', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const tileCount = 30
    const source = new CountingSource(makeManifest(tileCount))
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    expect(slide.pendingCount).toBe(tileCount)
    await waitFor(() => slide.stats.completed === tileCount)
    expect(source.peak).toBeLessThanOrEqual(4)
    expect(slide.pendingCount).toBe(0)
    expect(slide.stats.failures).toBe(0)
    slide.dispose()
  })

  it('accounts the cache in decoded (RGBA) bytes, not encoded bytes', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const tileCount = 5
    const source = new CountingSource(makeManifest(tileCount))
    const slide = NVSlide.fromSource(source)
    const level = slide.manifest.levels[0]
    if (!level) throw new Error('manifest has no level')
    for (const tile of level.tiles) slide.requestTile(level, tile)
    await waitFor(() => slide.stats.completed === tileCount)
    // Encoded payload is 16 bytes/tile; decoded accounting must dominate.
    expect(slide.cacheBytes).toBe(tileCount * DECODED_TILE_BYTES)
    expect(slide.stats.decodedBytes).toBe(tileCount * DECODED_TILE_BYTES)
    slide.dispose()
  })

  it('drains the queue past failed tiles', async () => {
    NVSlide.registerTileDecoder('image/jpeg', async () => fakeBitmap())
    const manifest = makeManifest(10)
    const level0 = manifest.levels[0]
    if (!level0) throw new Error('manifest has no level')
    // Mark three tiles as failing (frame -1 makes CountingSource reject).
    for (const i of [2, 5, 7]) {
      const tile = level0.tiles[i]
      if (tile) tile.frame = -1
    }
    const source = new CountingSource(manifest)
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 2 })
    for (const tile of level0.tiles) slide.requestTile(level0, tile)
    await waitFor(() => slide.stats.completed + slide.stats.failures === 10)
    expect(slide.stats.completed).toBe(7)
    expect(slide.stats.failures).toBe(3)
    expect(slide.pendingCount).toBe(0)
    slide.dispose()
  })
})
