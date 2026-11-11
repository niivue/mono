import { expect } from '@playwright/test'
import { test } from './sharedPage'

// Bun has no OffscreenCanvas: the 1x1 readback of a bitmap-only RGB tile runs
// here on a real one. Edge tile (3 x 2 of a 4 x 4 grid) checks the offset.
test('slide sampleAt reads an RGB bitmap tile back one pixel', async ({
  page,
}) => {
  const result = await page.evaluate(`(async () => {
    const { NVSlide } = await import('/src/index.ts')
    const tile = (x, y, width, height) => ({ x, y, width, height })
    const manifest = {
      id: 'rgb', name: 'rgb', width: 7, height: 6, dtype: 'uint8', channels: 'rgba',
      levels: [{ index: 0, width: 7, height: 6, downsample: 1, tileWidth: 4, tileHeight: 4,
        columns: 2, rows: 2, codec: 'raw-rgba',
        tiles: [tile(0, 0, 4, 4), tile(1, 0, 3, 4), tile(0, 1, 4, 2), tile(1, 1, 3, 2)] }],
    }
    const slide = NVSlide.fromSource({
      manifest,
      bind() {},
      fetchTileBytes: async (_level, t) => {
        const bytes = new Uint8Array(t.width * t.height * 4)
        for (let i = 0; i < t.width * t.height; i++)
          bytes.set([10 * t.x + i, 100 + 10 * t.y + i, 200, 255], 4 * i)
        return bytes
      },
    })
    const loaded = await slide.loadSampleAt(6, 5) // tile (1, 1), pixel (2, 1): i = 5
    const again = slide.sampleAt(6, 5)
    slide.dispose()
    return { loaded, again }
  })()`)
  const expected = [
    ['red', 15],
    ['green', 115],
    ['blue', 200],
  ].map(([name, value], channel) => ({
    channel,
    name,
    value,
    stored: value,
    level: 0,
    exact: true,
  }))
  expect(result).toEqual({ loaded: expected, again: expected })
})
