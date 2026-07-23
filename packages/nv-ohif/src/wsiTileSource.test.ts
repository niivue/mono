import { afterEach, describe, expect, it } from 'bun:test'
import type { OhifDisplaySet } from './ohif-types'
import {
  buildWsiManifest,
  DicomWsiTileSource,
  wsiVolumeLevels,
} from './wsiTileSource'

const JPEG = '1.2.840.10008.1.2.4.50'
const JP2 = '1.2.840.10008.1.2.4.90'
const BASE = 'https://dicom.example.com/studies/S/series/Se/instances'

function frameId(sop: string): string {
  return `wadors:${BASE}/${sop}/frames/1`
}

// A DICOM-WSI (SM) display set: a fine + coarse VOLUME level plus LABEL/OVERVIEW
// side images, deliberately supplied coarse-first to exercise the finest-first sort.
function smDisplaySet(): OhifDisplaySet {
  return {
    displaySetInstanceUID: 'ds-wsi',
    SeriesDescription: 'Slide 1',
    Modality: 'SM',
    instances: [
      {
        ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
        TotalPixelMatrixColumns: 500,
        TotalPixelMatrixRows: 250,
        Columns: 512,
        Rows: 512,
        TransferSyntaxUID: JPEG,
      },
      {
        ImageType: 'DERIVED\\PRIMARY\\LABEL\\NONE',
        TotalPixelMatrixColumns: 400,
        TotalPixelMatrixRows: 200,
        Columns: 400,
        Rows: 200,
        TransferSyntaxUID: JPEG,
      },
      {
        ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
        TotalPixelMatrixColumns: 2000,
        TotalPixelMatrixRows: 1000,
        Columns: 512,
        Rows: 512,
        TransferSyntaxUID: JPEG,
      },
      {
        ImageType: 'DERIVED\\PRIMARY\\OVERVIEW\\NONE',
        TotalPixelMatrixColumns: 300,
        TotalPixelMatrixRows: 150,
        Columns: 300,
        Rows: 150,
        TransferSyntaxUID: JPEG,
      },
    ],
    imageIds: [
      frameId('coarse'),
      frameId('label'),
      frameId('fine'),
      frameId('overview'),
    ],
  }
}

describe('wsiVolumeLevels', () => {
  it('keeps only VOLUME instances, finest first', () => {
    const levels = wsiVolumeLevels(smDisplaySet())
    expect(levels.map((l) => l.matrixColumns)).toEqual([2000, 500])
    expect(levels.map((l) => l.frameBaseUrl)).toEqual([
      `${BASE}/fine/frames`,
      `${BASE}/coarse/frames`,
    ])
  })

  it('reads the per-instance imageId when the display set snapshot is empty', () => {
    // Simulates the SOP-class handler running before imageIds were assigned:
    // ds.imageIds is empty, but each instance carries its own imageId.
    const ds: OhifDisplaySet = {
      instances: [
        {
          imageId: 'wadors:https://h/instances/fine/frames/1',
          ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
          TotalPixelMatrixColumns: 2000,
          TotalPixelMatrixRows: 1000,
          Columns: 512,
          Rows: 512,
          TransferSyntaxUID: JPEG,
        },
      ],
      imageIds: [],
    }
    const levels = wsiVolumeLevels(ds)
    expect(levels).toHaveLength(1)
    expect(levels[0]?.frameBaseUrl).toBe('https://h/instances/fine/frames')
  })

  it('strips a trailing query from the frame imageId', () => {
    const ds: OhifDisplaySet = {
      instances: [
        {
          imageId: 'wadors:https://h/instances/fine/frames/1?token=abc',
          ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
          TotalPixelMatrixColumns: 2000,
          TotalPixelMatrixRows: 1000,
          Columns: 512,
          Rows: 512,
          TransferSyntaxUID: JPEG,
        },
      ],
      imageIds: [],
    }
    // Base must not keep '/1?token=abc' (which would corrupt '.../frames/{n}').
    expect(wsiVolumeLevels(ds)[0]?.frameBaseUrl).toBe(
      'https://h/instances/fine/frames',
    )
  })

  it('falls back to a tiled-matrix test when ImageType is absent', () => {
    const ds: OhifDisplaySet = {
      instances: [
        // Genuinely tiled: matrix wider than a tile -> kept.
        {
          TotalPixelMatrixColumns: 2000,
          TotalPixelMatrixRows: 1000,
          Columns: 512,
          Rows: 512,
        },
        // Single-tile side image: matrix equals tile -> dropped.
        {
          TotalPixelMatrixColumns: 256,
          TotalPixelMatrixRows: 256,
          Columns: 256,
          Rows: 256,
        },
      ],
      imageIds: [frameId('a'), frameId('b')],
    }
    const levels = wsiVolumeLevels(ds)
    expect(levels).toHaveLength(1)
    expect(levels[0]?.matrixColumns).toBe(2000)
  })
})

describe('buildWsiManifest', () => {
  it('returns null when there are no VOLUME levels', () => {
    const ds: OhifDisplaySet = {
      instances: [
        {
          ImageType: 'DERIVED\\PRIMARY\\LABEL\\NONE',
          TotalPixelMatrixColumns: 100,
          TotalPixelMatrixRows: 100,
          Columns: 100,
          Rows: 100,
        },
      ],
      imageIds: [frameId('label')],
    }
    expect(buildWsiManifest(ds)).toBeNull()
  })

  it('builds a finest-first pyramid with a row-major tile grid', () => {
    const built = buildWsiManifest(smDisplaySet())
    if (!built) throw new Error('expected a manifest')
    const { manifest, levelBaseUrls, allJpeg } = built

    expect(allJpeg).toBe(true)
    expect(manifest.width).toBe(2000)
    expect(manifest.height).toBe(1000)
    expect(manifest.channels).toBe('encoded-rgb')
    expect(manifest.displayYAxis).toBe('up')
    expect(manifest.levels).toHaveLength(2)

    const [fine, coarse] = manifest.levels
    // Level 0 (finest): 2000x1000 in 512 tiles -> 4 columns x 2 rows = 8 tiles.
    expect(fine?.index).toBe(0)
    expect(fine?.downsample).toBe(1)
    expect(fine?.columns).toBe(4)
    expect(fine?.rows).toBe(2)
    expect(fine?.tiles).toHaveLength(8)
    // Level 1 (coarse): 500x250 -> 1x1, downsample 2000/500 = 4.
    expect(coarse?.index).toBe(1)
    expect(coarse?.downsample).toBe(4)
    expect(coarse?.tiles).toHaveLength(1)

    expect(levelBaseUrls).toEqual([
      `${BASE}/fine/frames`,
      `${BASE}/coarse/frames`,
    ])
    // No spacing metadata on this display set -> ruler falls back to pixels.
    expect(manifest.pixelSpacingMM).toBeUndefined()
  })

  // A single-VOLUME-level SM display set (2000x1000) whose finest instance
  // carries the given extra metadata, for spacing derivation.
  function oneLevelWith(extra: Record<string, unknown>): OhifDisplaySet {
    return {
      displaySetInstanceUID: 'ds-spacing',
      Modality: 'SM',
      instances: [
        {
          ImageType: 'DERIVED\\PRIMARY\\VOLUME\\NONE',
          TotalPixelMatrixColumns: 2000,
          TotalPixelMatrixRows: 1000,
          Columns: 512,
          Rows: 512,
          TransferSyntaxUID: JPEG,
          ...extra,
        },
      ],
      imageIds: [frameId('fine')],
    }
  }

  it('derives pixelSpacingMM from PixelMeasuresSequence (row/col swapped to x,y)', () => {
    const built = buildWsiManifest(
      oneLevelWith({
        SharedFunctionalGroupsSequence: [
          { PixelMeasuresSequence: [{ PixelSpacing: [0.002, 0.001] }] },
        ],
      }),
    )
    // DICOM PixelSpacing is [rowSpacing (dy), colSpacing (dx)] -> NVSlide [dx, dy].
    expect(built?.manifest.pixelSpacingMM).toEqual([0.001, 0.002])
  })

  it('derives pixelSpacingMM from PerFrameFunctionalGroupsSequence', () => {
    const built = buildWsiManifest(
      oneLevelWith({
        PerFrameFunctionalGroupsSequence: [
          { PixelMeasuresSequence: [{ PixelSpacing: [0.002, 0.001] }] },
        ],
      }),
    )
    expect(built?.manifest.pixelSpacingMM).toEqual([0.001, 0.002])
  })

  it('falls back to ImagedVolumeWidth/Height over the pixel matrix', () => {
    const built = buildWsiManifest(
      oneLevelWith({ ImagedVolumeWidth: 4, ImagedVolumeHeight: 1 }),
    )
    // 4 mm / 2000 cols = 0.002 (dx); 1 mm / 1000 rows = 0.001 (dy).
    expect(built?.manifest.pixelSpacingMM).toEqual([0.002, 0.001])
  })

  it('accepts numeric-string PixelSpacing values', () => {
    const built = buildWsiManifest(
      oneLevelWith({
        SharedFunctionalGroupsSequence: [
          { PixelMeasuresSequence: [{ PixelSpacing: ['0.0005', '0.0005'] }] },
        ],
      }),
    )
    expect(built?.manifest.pixelSpacingMM).toEqual([0.0005, 0.0005])
  })

  it('maps tiles to row-major frame numbers and clips edge tiles', () => {
    const built = buildWsiManifest(smDisplaySet())
    const fine = built?.manifest.levels[0]
    if (!fine) throw new Error('expected level 0')
    // Row 0: frames 1..4 at y=0; row 1: frames 5..8 at y=512.
    expect(fine.tiles.map((t) => t.frame)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // x/y are COLUMN/ROW INDICES (not pixel offsets). Third tile of row 0: col 2.
    expect(fine.tiles[2]).toMatchObject({
      x: 2,
      y: 0,
      width: 512,
      height: 512,
      frame: 3,
    })
    // Last tile of row 0: col 3, clipped in width to 2000-1536 = 464.
    expect(fine.tiles[3]).toMatchObject({
      x: 3,
      y: 0,
      width: 464,
      height: 512,
      frame: 4,
    })
    // Row 1, col 0: clipped in height to 1000-512 = 488.
    expect(fine.tiles[4]).toMatchObject({
      x: 0,
      y: 1,
      width: 512,
      height: 488,
      frame: 5,
    })
  })

  it('flags a JPEG 2000 slide as not all-JPEG', () => {
    const ds = smDisplaySet()
    const instances = ds.instances?.map((inst) => ({
      ...inst,
      TransferSyntaxUID: JP2,
    }))
    const built = buildWsiManifest({ ...ds, instances })
    expect(built?.allJpeg).toBe(false)
    expect(built?.manifest.levels[0]?.codec).toBe('image/jp2')
  })
})

describe('DicomWsiTileSource.fetchTileBytes', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('requests /frames/{n} and returns the first multipart part', async () => {
    const built = buildWsiManifest(smDisplaySet())
    if (!built) throw new Error('expected a manifest')
    const source = new DicomWsiTileSource(built, { Authorization: 'Bearer t' })
    const level = built.manifest.levels[0]
    const tile = level?.tiles[2] // frame 3
    if (!level || !tile) throw new Error('expected a tile')

    const boundary = 'BmilkBoundary'
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const enc = new TextEncoder()
    const head = enc.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`)
    const tail = enc.encode(`\r\n--${boundary}--\r\n`)
    const body = new Uint8Array(head.length + jpeg.length + tail.length)
    body.set(head, 0)
    body.set(jpeg, head.length)
    body.set(tail, head.length + jpeg.length)

    let calledUrl = ''
    let calledHeaders: Record<string, string> = {}
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calledUrl = url
      calledHeaders = (init?.headers ?? {}) as Record<string, string>
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': `multipart/related; type="image/jpeg"; boundary=${boundary}`,
          },
        }),
      )
    }) as typeof fetch

    const bytes = await source.fetchTileBytes(level, tile)
    expect(calledUrl).toBe(`${BASE}/fine/frames/3`)
    expect(calledHeaders.Authorization).toBe('Bearer t')
    expect(Array.from(bytes)).toEqual(Array.from(jpeg))
  })

  it('throws on a non-ok response', async () => {
    const built = buildWsiManifest(smDisplaySet())
    if (!built) throw new Error('expected a manifest')
    const source = new DicomWsiTileSource(built)
    const level = built.manifest.levels[0]
    const tile = level?.tiles[0]
    if (!level || !tile) throw new Error('expected a tile')
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('nope', { status: 404 }),
      )) as unknown as typeof fetch
    await expect(source.fetchTileBytes(level, tile)).rejects.toThrow('404')
  })
})
