import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { NVSlideLevelManifest } from '@niivue/niivue'
import * as zarr from 'zarrita'
import { ZarrSlideSource } from './zarrSlideSource'

// The milestone-13 regression set (omezarr2d/variants on Hugging Face). Not in
// CI: point NV_ZARR_VARIANTS at a local copy to run the variants test.
const VARIANTS =
  process.env.NV_ZARR_VARIANTS ?? '/Volumes/TB5/ZARR/out/variants'
const ENCODINGS = [
  'v3-shard-per-level',
  'v3-shard-1024',
  'v3-chunks-blosc-zstd',
  'v3-chunks-zstd',
  'v2-blosc-lz4-slash',
  'v2-zlib-dot-bigendian',
]

type Store = Map<string, Uint8Array>

/** fetch over files or a Map, honouring Range (as serve.ts does); logs cache modes. */
function fakeFetch(read: (path: string) => Uint8Array | undefined) {
  const modes = new Map<string, RequestCache>()
  const fetchImpl = async (request: Request) => {
    const path = decodeURIComponent(new URL(request.url).pathname)
    modes.set(path, request.cache)
    const body = read(path)
    if (!body) return new Response(null, { status: 404 })
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    // Bun sets no Content-Length on a constructed Response; FetchStore HEADs for it.
    if (!m)
      return new Response(body, {
        headers: { 'Content-Length': String(body.length) },
      })
    const start = m[1] ? Number(m[1]) : body.length - Number(m[2])
    const end = m[1] && m[2] ? Number(m[2]) + 1 : body.length
    return new Response(body.slice(start, end), { status: 206 })
  }
  return { fetchImpl, modes }
}

async function tileBytes(source: ZarrSlideSource, level: NVSlideLevelManifest) {
  return Promise.all(
    level.tiles.map((t) =>
      t ? source.fetchTileBytes(level, t, 'x') : new Uint8Array(),
    ),
  )
}

function u16(bytes: Uint8Array): Uint16Array {
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

async function writeImage(
  attrs: Record<string, unknown>,
  levels: {
    shape: number[]
    chunks: number[]
    data: zarr.TypedArray<zarr.DataType>
  }[],
  dtype: zarr.DataType,
): Promise<Store> {
  const store: Store = new Map()
  const root = zarr.root(store)
  await zarr.create(root, { attributes: { ome: { version: '0.5', ...attrs } } })
  for (const [i, { shape, chunks, data }] of levels.entries()) {
    const arr = await zarr.create(root.resolve(String(i)), {
      shape,
      chunkShape: chunks,
      dtype,
    })
    const stride = shape.map((_, d) =>
      shape.slice(d + 1).reduce((a, b) => a * b, 1),
    )
    await zarr.set(arr, null, {
      data,
      shape,
      stride,
    } as zarr.Chunk<zarr.DataType>)
  }
  return store
}

const multiscale = (axes: string[], n: number, units = false) => [
  {
    axes: axes.map((name) => ({
      name,
      type: name === 'c' ? 'channel' : name === 't' ? 'time' : 'space',
      ...(units && name !== 'c' && name !== 't' ? { unit: 'micrometer' } : {}),
    })),
    datasets: Array.from({ length: n }, (_, i) => ({
      path: String(i),
      coordinateTransformations: [
        {
          type: 'scale',
          scale: axes.map((a) => (a === 'c' || a === 't' ? 1 : 0.5 * 2 ** i)),
        },
      ],
    })),
  },
]

const ramp = (n: number, f: (i: number) => number) =>
  Uint16Array.from({ length: n }, (_, i) => f(i))

describe('ZarrSlideSource (synthetic)', () => {
  test('RGB: 3 uint8 channels, chunks split by channel, clipped edge tiles, 2 levels', async () => {
    // c, y, x = 3 x 5 x 7; pixel value = 100c + 10y + x.
    const data = Uint8Array.from({ length: 105 }, (_, i) => {
      const c = Math.floor(i / 35)
      return 100 * c + 10 * Math.floor((i % 35) / 7) + (i % 7)
    })
    const store = await writeImage(
      { multiscales: multiscale(['c', 'y', 'x'], 2) },
      [
        { shape: [3, 5, 7], chunks: [1, 4, 4], data },
        {
          shape: [3, 3, 4],
          chunks: [1, 4, 4],
          data: new Uint8Array(36).fill(9),
        },
      ],
      'uint8',
    )
    const source = await ZarrSlideSource.fromStore(store)
    const [l0, l1] = source.manifest.levels
    expect(source.manifest.channels).toBe('rgba')
    expect(source.window).toBeNull()
    expect(source.manifest.pixelSpacingMM).toBeUndefined()
    expect(l0).toMatchObject({
      codec: 'raw-rgba',
      columns: 2,
      rows: 2,
      downsample: 1,
    })
    expect(l1).toMatchObject({ columns: 1, rows: 1, downsample: 7 / 4 })
    const corner = l0.tiles[3]
    expect(corner).toMatchObject({ x: 1, y: 1, width: 3, height: 1 })
    const tiles = await tileBytes(source, l0)
    // Bottom-right tile: row y=4, x=4..6.
    expect(Array.from(tiles[3])).toEqual([
      44, 144, 244, 255, 45, 145, 245, 255, 46, 146, 246, 255,
    ])
    expect(tiles[0].length).toBe(4 * 4 * 4)
  })

  test('uint16 single channel by URL: omero window, spacing, edge clipping, no-store chunks', async () => {
    const store = await writeImage(
      {
        multiscales: multiscale(['y', 'x'], 2, true),
        omero: {
          channels: [{ window: { start: 100, end: 1000, min: 0, max: 65535 } }],
        },
      },
      [
        { shape: [3, 5], chunks: [2, 2], data: ramp(15, (i) => i * 1000) },
        { shape: [2, 3], chunks: [2, 2], data: ramp(6, (i) => i) },
      ],
      'uint16',
    )
    const { fetchImpl, modes } = fakeFetch((p) =>
      store.get(p.slice('/s.zarr'.length)),
    )
    const source = await ZarrSlideSource.fromUrl('http://h/s.zarr/', {
      fetch: fetchImpl,
    })
    const [l0] = source.manifest.levels
    expect(source.manifest.id).toBe('s.zarr')
    expect(source.window).toEqual({ calMin: 100, calMax: 1000 })
    expect(source.manifest.pixelSpacingMM).toEqual([0.0005, 0.0005])
    expect(l0).toMatchObject({
      codec: 'raw-gray',
      photometric: 'MONOCHROME2',
      bitsStored: 16,
      columns: 3,
      rows: 2,
    })
    const tiles = await tileBytes(source, l0)
    expect(Array.from(u16(tiles[0]))).toEqual([0, 1000, 5000, 6000])
    // Bottom-right: 1 x 1 at y=2, x=4.
    expect(Array.from(u16(tiles[5]))).toEqual([14000])
    expect(modes.get('/s.zarr/zarr.json')).toBe('default')
    expect(modes.get('/s.zarr/0/c/0/0')).toBe('no-store')
  })

  test('multi-channel picks the first active channel; z > 1 needs the z option; uint16 windows to the data range', async () => {
    const store = await writeImage(
      {
        multiscales: multiscale(['c', 'z', 'y', 'x'], 1),
        omero: { channels: [{ active: false }, { active: true }] },
      },
      [{ shape: [2, 2, 1, 2], chunks: [1, 1, 1, 2], data: ramp(8, (i) => i) }],
      'uint16',
    )
    await expect(ZarrSlideSource.fromStore(store)).rejects.toThrow(
      "pick one with the 'z' option",
    )
    const source = await ZarrSlideSource.fromStore(store, { z: 1 })
    const [l0] = source.manifest.levels
    expect(source.window).toEqual({ calMin: 6, calMax: 7 })
    expect(Array.from(u16((await tileBytes(source, l0))[0]))).toEqual([6, 7])
  })

  test('a chosen z plane maps to each level of a z-downsampled pyramid', async () => {
    // Level 0 is 4 planes (value = plane), level 1 is 2 planes (value = 10 + plane).
    const store = await writeImage(
      { multiscales: multiscale(['z', 'y', 'x'], 2) },
      [
        { shape: [4, 4, 4], chunks: [1, 4, 4], data: ramp(64, (i) => i >> 4) },
        {
          shape: [2, 2, 2],
          chunks: [1, 2, 2],
          data: ramp(8, (i) => 10 + (i >> 2)),
        },
      ],
      'uint16',
    )
    const source = await ZarrSlideSource.fromStore(store, { z: 3 })
    const [l0, l1] = source.manifest.levels
    expect(u16((await tileBytes(source, l0))[0] ?? new Uint8Array())[0]).toBe(3)
    // Plane 3 of 4 lies in plane 1 of 2.
    expect(u16((await tileBytes(source, l1))[0] ?? new Uint8Array())[0]).toBe(
      11,
    )
  })

  test("a chosen z plane follows each level's z scale and translation", async () => {
    // Odd depths: 5 planes (value = plane) and 3 planes (value = 10 + plane)
    // with z scale 2, translation 0.5. Plane 3 (z = 3) is nearest 1.25 -> 1.
    const store = await writeImage(
      {
        multiscales: [
          {
            axes: ['z', 'y', 'x'].map((name) => ({ name, type: 'space' })),
            datasets: [
              {
                path: '0',
                coordinateTransformations: [
                  { type: 'scale', scale: [1, 1, 1] },
                ],
              },
              {
                path: '1',
                coordinateTransformations: [
                  { type: 'scale', scale: [2, 2, 2] },
                  { type: 'translation', translation: [0.5, 0.5, 0.5] },
                ],
              },
            ],
          },
        ],
      },
      [
        { shape: [5, 4, 4], chunks: [1, 4, 4], data: ramp(80, (i) => i >> 4) },
        {
          shape: [3, 2, 2],
          chunks: [1, 2, 2],
          data: ramp(12, (i) => 10 + (i >> 2)),
        },
      ],
      'uint16',
    )
    const source = await ZarrSlideSource.fromStore(store, { z: 3 })
    const [l0, l1] = source.manifest.levels
    expect(u16((await tileBytes(source, l0))[0] ?? new Uint8Array())[0]).toBe(3)
    expect(u16((await tileBytes(source, l1))[0] ?? new Uint8Array())[0]).toBe(
      11,
    )
  })

  test('float32 is quantized to uint16 over the omero min..max', async () => {
    const store = await writeImage(
      {
        multiscales: multiscale(['y', 'x'], 1),
        omero: {
          channels: [{ window: { start: 0.25, end: 0.75, min: 0, max: 1 } }],
        },
      },
      [{ shape: [1, 3], chunks: [1, 3], data: Float32Array.from([0, 0.5, 2]) }],
      'float32',
    )
    const source = await ZarrSlideSource.fromStore(store)
    const [l0] = source.manifest.levels
    expect(source.window).toEqual({ calMin: 16383.75, calMax: 49151.25 })
    expect(Array.from(u16((await tileBytes(source, l0))[0]))).toEqual([
      0, 32768, 65535,
    ])
  })
})

test('int16 ignores a placeholder omero block and quantizes over the data range', async () => {
  const store = await writeImage(
    {
      multiscales: multiscale(['y', 'x'], 1),
      omero: { channels: [{ window: { start: 0, end: 1, min: 0, max: 1 } }] },
    },
    [{ shape: [1, 3], chunks: [1, 3], data: Int16Array.from([-100, 0, 100]) }],
    'int16',
  )
  const source = await ZarrSlideSource.fromStore(store)
  expect(source.window).toEqual({ calMin: 0, calMax: 65535 })
  const [l0] = source.manifest.levels
  expect(Array.from(u16((await tileBytes(source, l0))[0]))).toEqual([
    0, 32768, 65535,
  ])
})

test('all-NaN data falls back to the full window', async () => {
  const store = await writeImage(
    {
      multiscales: multiscale(['y', 'x'], 1),
      omero: {
        channels: [
          { window: { start: 0.25, end: 0.75, min: null, max: null } },
        ],
      },
    },
    [
      {
        shape: [1, 2],
        chunks: [1, 2],
        data: Float32Array.from([Number.NaN, Number.NaN]),
      },
    ],
    'float32',
  )
  const source = await ZarrSlideSource.fromStore(store)
  expect(source.window).toEqual({ calMin: 0, calMax: 65535 })
})

test('non-finite samples do not widen the quantize range', async () => {
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [
      {
        shape: [1, 4],
        chunks: [1, 4],
        data: Float32Array.from([0, 50, 100, Number.POSITIVE_INFINITY]),
      },
    ],
    'float32',
  )
  const source = await ZarrSlideSource.fromStore(store)
  const [l0] = source.manifest.levels
  expect(Array.from(u16((await tileBytes(source, l0))[0]))).toEqual([
    0, 32768, 65535, 65535,
  ])
})

test('the data range samples the centre, not the whole single-level image', async () => {
  // 4096 wide in 512-wide chunks: the 1024-wide centre is chunks 3 and 4.
  const data = ramp(4096, (i) =>
    i >= 1536 && i < 2560 ? 1000 + i - 1536 : 60000,
  )
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 4096], chunks: [1, 512], data }],
    'uint16',
  )
  const read: string[] = []
  const spy = {
    get: (key: string) => {
      read.push(key)
      return store.get(key)
    },
  }
  const source = await ZarrSlideSource.fromStore(spy)
  expect(source.window).toEqual({ calMin: 1000, calMax: 2023 })
  expect(read.filter((k) => k.includes('/c/')).sort()).toEqual([
    '/0/c/0/3',
    '/0/c/0/4',
  ])
})

test('a flat centre sample falls back to the whole level', async () => {
  // int16, 4096 wide: zero at the centre, 100 in the leftmost chunk.
  const data = Int16Array.from({ length: 4096 }, (_, i) => (i < 512 ? 100 : 0))
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 4096], chunks: [1, 512], data }],
    'int16',
  )
  const source = await ZarrSlideSource.fromStore(store)
  const [l0] = source.manifest.levels
  const [first] = await tileBytes(source, l0)
  expect(Math.max(...u16(first))).toBe(65535)
})

test('a timepoint missing from a coarser level is refused on open', async () => {
  const store = await writeImage(
    { multiscales: multiscale(['t', 'y', 'x'], 2) },
    [
      { shape: [2, 2, 2], chunks: [1, 2, 2], data: ramp(8, (i) => i) },
      { shape: [1, 1, 1], chunks: [1, 1, 1], data: ramp(1, () => 0) },
    ],
    'uint16',
  )
  await expect(ZarrSlideSource.fromStore(store, { t: 1 })).rejects.toThrow(
    'level 1 has 1 timepoints; t 1 is out of range',
  )
  await ZarrSlideSource.fromStore(store, { t: 0 })
})

test('an aborted tile is reported aborted, not failed', async () => {
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 2], chunks: [1, 2], data: Uint8Array.from([1, 2]) }],
    'uint8',
  )
  const source = await ZarrSlideSource.fromStore(store)
  const status: string[] = []
  source.bind({
    resolveUrl: (u) => u,
    addWireBytes() {},
    rangeHit() {},
    rangeFallback() {},
    pushRangeEvent: (e) => status.push(e.status),
    updateRangeEvent: (_, s) => status.push(s),
  })
  const [l0] = source.manifest.levels
  const tile = l0.tiles[0]
  if (!tile) throw new Error('no tile')
  await expect(
    source.fetchTileBytes(l0, tile, 't', AbortSignal.abort()),
  ).rejects.toThrow()
  expect(status).toEqual(['pending', 'aborted'])
})

test('axes declared x, y: tiles come out row-major', async () => {
  // x, y = 3 x 2; value = 10y + x.
  const store = await writeImage(
    { multiscales: multiscale(['x', 'y'], 1) },
    [
      {
        shape: [3, 2],
        chunks: [3, 2],
        data: Uint8Array.from([0, 10, 1, 11, 2, 12]),
      },
    ],
    'uint8',
  )
  const source = await ZarrSlideSource.fromStore(store)
  const [l0] = source.manifest.levels
  expect(l0).toMatchObject({ width: 3, height: 2, bitsStored: 8 })
  expect(Array.from((await tileBytes(source, l0))[0])).toEqual([
    0, 1, 2, 10, 11, 12,
  ])
})

describe('ZarrSlideSource (omezarr2d/variants)', () => {
  const present = existsSync(`${VARIANTS}/expected.json`)
  if (!present)
    console.log(
      `skipping omezarr2d/variants: no local copy at ${VARIANTS} (set NV_ZARR_VARIANTS)`,
    )
  test.skipIf(!present).each(ENCODINGS)(
    '%s decodes to expected.json sums',
    async (name) => {
      const expected = JSON.parse(
        readFileSync(`${VARIANTS}/expected.json`, 'utf8'),
      ) as {
        levels: { shape: number[]; sum_per_channel: number[] }[]
      }
      const { fetchImpl } = fakeFetch((p) =>
        existsSync(VARIANTS + p)
          ? new Uint8Array(readFileSync(VARIANTS + p))
          : undefined,
      )
      for (const channel of [0, 1]) {
        const source = await ZarrSlideSource.fromUrl(
          `http://h/${name}.ome.zarr`,
          { fetch: fetchImpl, channel },
        )
        const levels = source.manifest.levels
        expect(levels.map((l) => [l.height, l.width])).toEqual(
          expected.levels.map((l) => l.shape.slice(1)),
        )
        for (const [i, level] of levels.entries()) {
          expect(level.tileWidth).toBe(Math.min(512, level.width))
          let sum = 0
          for (const bytes of await tileBytes(source, level))
            for (const v of u16(bytes)) sum += v
          expect(sum).toBe(expected.levels[i].sum_per_channel[channel])
        }
      }
    },
  )
})
