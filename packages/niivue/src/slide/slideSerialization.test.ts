import { describe, expect, spyOn, test } from 'bun:test'
import { decode, encode } from 'cbor-x'

import { decodeRLE, encodeRLE } from '@/drawing/rle'
import NiiVue from '@/index'
import { log } from '@/logger'
import { documentFile, parseJsonDocument } from '@/testing/headless'

// Guards the wire contract NVDocument uses to round-trip a slide plane + its
// slide-space drawing (NVDocumentSlidePlane). Mirrors the shape here, so the
// contract is pinned independently of NVDocument's own encoder.

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
      vectorShapes: [
        {
          kind: 'polygon',
          points: [
            [10, 20],
            [300, 20],
            [300, 240],
          ],
          color: '#e62d37',
          strokeWidth: 6,
        },
      ],
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
    // Vector annotations survive (kind, points, color).
    expect(round.vectorShapes).toHaveLength(1)
    expect(round.vectorShapes[0].kind).toBe('polygon')
    expect(round.vectorShapes[0].color).toBe('#e62d37')
    expect(round.vectorShapes[0].points).toEqual([
      [10, 20],
      [300, 20],
      [300, 240],
    ])
  })
})

describe('slide channels in a document', () => {
  const tile = 8
  const slidePlane = (extra: Record<string, unknown>) => ({
    manifest: {
      id: 's',
      name: 's',
      width: tile,
      height: tile,
      tileSize: tile,
      dtype: 'uint16',
      channels: 'planar',
      channelInfo: [
        { name: 'a', rgb: [255, 0, 0], active: true },
        { name: 'b', active: false },
      ],
      levels: [
        {
          index: 0,
          width: tile,
          height: tile,
          downsample: 1,
          columns: 1,
          rows: 1,
          tiles: [{ x: 0, y: 0, width: tile, height: tile }],
        },
      ],
    },
    pixelToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    ...extra,
  })

  // Load a document holding `sp`, then save it again as JSON.
  async function roundTrip(sp: Record<string, unknown>) {
    const nv = new NiiVue({ backend: 'webgl2' })
    const doc = parseJsonDocument(nv.serializeDocument({ format: 'json' }))
    doc.slidePlane = sp
    // The manifest names no tile bytes, so the slide logs failed tile fetches.
    const tileErrors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await nv.loadDocument(documentFile(JSON.stringify(doc), 'channels.nvd'))
      const out = parseJsonDocument(nv.serializeDocument({ format: 'json' }))
      return out.slidePlane as Record<string, unknown>
    } finally {
      tileErrors.mockRestore()
    }
  }

  test('restores and saves changed channels and blend, NaN windows included', async () => {
    const nan = { $num: 'NaN' } // the document JSON's non-finite tag
    const channels = [
      { name: 'a', colormap: 'gray', calMin: 10, calMax: 90, visible: true },
      { name: 'b', colormap: 'blue', calMin: nan, calMax: nan, visible: true },
    ]
    const sp = await roundTrip(
      slidePlane({ channels, channelBlend: 'additive' }),
    )
    expect(sp.channels).toEqual(channels)
    expect(sp.channelBlend).toBe('additive')
  })

  test('omits default channels and blend, so older documents load unchanged', async () => {
    const sp = await roundTrip(slidePlane({}))
    expect(sp.channels).toBeUndefined()
    expect(sp.channelBlend).toBeUndefined()
    expect(sp.colorManagement).toBeUndefined()
  })

  test('restores and saves colour management turned off', async () => {
    const sp = await roundTrip(slidePlane({ colorManagement: false }))
    expect(sp.colorManagement).toBe(false)
  })

  // The manifest alone, as a VolumeSliceSource plane saves it (levels state no
  // codec): the plane, its channels and its drawing restore, with one warning.
  test('restores a codec-less channelInfo plane and its drawing', async () => {
    const img = new Uint8Array(tile * tile).fill(3)
    const rle = encodeRLE(img)
    const channels = [
      { name: 'a', colormap: 'gray', calMin: 10, calMax: 90, visible: true },
      { name: 'b', colormap: 'blue', calMin: 1, calMax: 2, visible: false },
    ]
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const sp = await roundTrip(
        slidePlane({
          channels,
          drawingRLE: {
            $ta: 'Uint8Array',
            b64: Buffer.from(rle).toString('base64'),
          },
          drawingWidth: tile,
          drawingHeight: tile,
        }),
      )
      expect(sp.channels).toEqual(channels)
      // The saved JSON keeps the drawing tagged, as it was loaded.
      const { b64 } = sp.drawingRLE as { b64: string }
      expect(decodeRLE(Buffer.from(b64, 'base64'), tile * tile)).toEqual(img)
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/without its sample source/),
      ])
    } finally {
      warn.mockRestore()
    }
  })

  test('omits the blend an RGB slide is fixed to', async () => {
    const sp = slidePlane({})
    delete (sp.manifest as { channelInfo?: unknown }).channelInfo
    const out = await roundTrip(sp)
    expect(out.channels).toBeUndefined()
    expect(out.channelBlend).toBeUndefined()
  })
})
