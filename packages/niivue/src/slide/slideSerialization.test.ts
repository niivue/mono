import { describe, expect, test } from 'bun:test'
import { decode, encode } from 'cbor-x'

import { decodeRLE, encodeRLE } from '@/drawing/rle'

// Guards the wire contract NVDocument uses to round-trip a slide plane + its
// slide-space drawing (NVDocumentSlidePlane). Mirrors the shape here rather than
// importing NVDocument, which pulls a Vite-only `import.meta.glob` barrel that
// is unavailable under the bun test runner.

describe('slide plane document round-trip (CBOR + RLE)', () => {
  test('preserves the manifest reference, transform, level, and drawing raster', () => {
    const img = new Uint8Array(8 * 4)
    img[10] = 3
    img[11] = 3
    img[20] = 1

    const docSlide = {
      manifest: {
        id: 's',
        name: 'slide',
        width: 1536,
        height: 1024,
        dtype: 'uint8',
        channels: 'rgb',
        dataUrl: '/slide.bin',
        levels: [
          {
            index: 0,
            width: 1536,
            height: 1024,
            downsample: 1,
            columns: 6,
            rows: 4,
            tiles: [
              { x: 0, y: 0, width: 256, height: 256, offset: 0, length: 9 },
            ],
          },
        ],
      },
      manifestUrl: '/slide.json',
      pixelToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -90, 90, 18, 1],
      levelIndex: 2,
      drawingRLE: encodeRLE(img),
      drawingWidth: 8,
      drawingHeight: 4,
    }

    const round = decode(encode(docSlide))

    // Manifest reference (data URL + byte-range tiles) survives for refetch.
    expect(round.manifest.width).toBe(1536)
    expect(round.manifest.dataUrl).toBe('/slide.bin')
    expect(round.manifest.levels[0].tiles[0].length).toBe(9)
    expect(round.manifestUrl).toBe('/slide.json')
    // Registration transform + LOD pin survive.
    expect(Array.from(round.pixelToWorld)).toEqual(docSlide.pixelToWorld)
    expect(round.levelIndex).toBe(2)
    // Slide-space drawing decodes back to the exact raster.
    const decoded = decodeRLE(
      round.drawingRLE,
      round.drawingWidth * round.drawingHeight,
    )
    expect(Array.from(decoded)).toEqual(Array.from(img))
  })
})
