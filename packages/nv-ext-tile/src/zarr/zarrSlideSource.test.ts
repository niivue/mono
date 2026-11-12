import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { NVSlide, type NVSlideLevelManifest } from '@niivue/niivue'
import * as zarr from '@niivue/zarrita-rs/inline'
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
    // TS 5.9 BodyInit rejects SharedArrayBuffer-backed views; fixtures are ArrayBuffer-backed.
    const body = read(path) as Uint8Array<ArrayBuffer> | undefined
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

function tileAt(level: NVSlideLevelManifest, i: number) {
  const tile = level.tiles[i]
  if (!tile) throw new Error(`no tile ${i}`)
  return tile
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

/** Runs `f` with stand-ins for the browser bitmap API NVSlide renders tiles with. */
async function withFakeBitmaps<T>(f: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>
  const saved = [g.ImageData, g.createImageBitmap]
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  g.createImageBitmap = async (img: { width: number; height: number }) => ({
    width: img.width,
    height: img.height,
    close() {},
  })
  try {
    return await f()
  } finally {
    ;[g.ImageData, g.createImageBitmap] = saved
  }
}

// Bin b of the 1001-bin 2-98% histogram over mn..mx (robustMinMax).
const bin = (b: number, mn: number, mx: number) => b / (1000 / (mx - mn)) + mn

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
    expect(source.manifest.channelInfo).toBeUndefined()
    expect(source.fetchTileSamples).toBeUndefined()
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

  test('the channel option shows one grey channel; z > 1 needs the z option; uint16 windows to the data range', async () => {
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
    const source = await ZarrSlideSource.fromStore(store, { z: 1, channel: 1 })
    const [l0] = source.manifest.levels
    expect(source.fetchTileSamples).toBeUndefined()
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

  test('an explicit channel shows even when omero marks it inactive', async () => {
    const store = await writeImage(
      {
        multiscales: multiscale(['c', 'y', 'x'], 1),
        omero: { channels: [{ active: true }, { active: false }] },
      },
      [{ shape: [2, 2, 2], chunks: [1, 2, 2], data: ramp(8, (i) => i) }],
      'uint16',
    )
    const source = await ZarrSlideSource.fromStore(store, { channel: 1 })
    const [l0] = source.manifest.levels
    expect(source.manifest.channelInfo).toBeUndefined()
    expect(Array.from(u16((await tileBytes(source, l0))[0]))).toEqual([
      4, 5, 6, 7,
    ])
  })

  test('multi-channel store with every channel inactive shows the first', async () => {
    const store = await writeImage(
      {
        multiscales: multiscale(['c', 'y', 'x'], 1),
        omero: { channels: [{ active: false }, { active: false }] },
      },
      [{ shape: [2, 2, 2], chunks: [1, 2, 2], data: ramp(8, (i) => i) }],
      'uint16',
    )
    const source = await ZarrSlideSource.fromStore(store)
    expect(source.manifest.channelInfo?.map((c) => c.active)).toEqual([
      true,
      false,
    ])
  })

  test.each([
    // tonsil IMC style: 6 stated active of 7, all shown (no cap)
    [
      'stated flags',
      [{ active: false }, ...Array(6).fill({ active: true })],
      [false, true, true, true, true, true, true],
    ],
    // every flag stated true is no choice: the first 4 show, as with no flags
    [
      'all stated active',
      Array(7).fill({ active: true }),
      [true, true, true, true, false, false, false],
    ],
    // a missing flag counts as active
    [
      'mixed flags',
      [{}, { active: false }, ...Array(5).fill({})],
      [true, false, true, true, true, true, true],
    ],
    // flags stated only past the old cap: still no cap
    [
      'flags past the cap',
      [...Array(5).fill({}), { active: true }, { active: false }],
      [true, true, true, true, true, true, false],
    ],
    // no flag stated: the first 4 show (tile budget)
    [
      'no flags',
      Array(7).fill({}),
      [true, true, true, true, false, false, false],
    ],
  ])('%s: visible channels follow omero active', async (_, channels, active) => {
    const store = await writeImage(
      { multiscales: multiscale(['c', 'y', 'x'], 1), omero: { channels } },
      [{ shape: [7, 2, 2], chunks: [1, 2, 2], data: ramp(28, (i) => i) }],
      'uint16',
    )
    const source = await ZarrSlideSource.fromStore(store)
    expect(source.manifest.channelInfo?.map((c) => c.active)).toEqual(active)
  })

  test('multi-channel uint16: omero channelInfo, planes in requested order, unrequested channels unread', async () => {
    // c, y, x = 3 x 2 x 3; value = 1000c + 3y + x.
    const store = await writeImage(
      {
        multiscales: multiscale(['c', 'y', 'x'], 1),
        omero: {
          channels: [
            {
              label: 'DAPI',
              color: '0000FF',
              window: { start: 0, end: 1, min: 0, max: 1 },
            },
            {
              color: '00FF00',
              active: false,
              window: { start: 10, end: 900, min: 0, max: 65535 },
            },
          ],
        },
      },
      [
        {
          shape: [3, 2, 3],
          chunks: [1, 2, 2],
          data: ramp(18, (i) => 1000 * Math.floor(i / 6) + (i % 6)),
        },
      ],
      'uint16',
    )
    const reads: string[] = []
    const get = store.get.bind(store)
    store.get = (key) => {
      reads.push(key)
      return get(key)
    }
    const source = await ZarrSlideSource.fromStore(store)
    const [l0] = source.manifest.levels
    expect(source.window).toBeNull()
    expect(l0).toMatchObject({ codec: 'raw-gray', bitsStored: 16 })
    // Placeholder window dropped for the data range; omero shorter than c.
    expect(source.manifest.channelInfo).toEqual([
      {
        name: 'DAPI',
        rgb: [0, 0, 255],
        window: { calMin: 0, calMax: 5 },
        active: true,
      },
      {
        name: 'Channel 2',
        rgb: [0, 255, 0],
        window: { calMin: 10, calMax: 900 },
        active: false,
      },
      {
        name: 'Channel 3',
        window: { calMin: 2000, calMax: 2005 },
        active: true,
      },
    ])
    expect(NVSlide.fromSource(source).channels).toEqual([
      { name: 'DAPI', colormap: 'blue', calMin: 0, calMax: 5, visible: true },
      {
        name: 'Channel 2',
        colormap: 'green',
        calMin: 10,
        calMax: 900,
        visible: false,
      },
      // No omero colour: the next unused channel colormap.
      {
        name: 'Channel 3',
        colormap: 'cyan',
        calMin: 2000,
        calMax: 2005,
        visible: true,
      },
    ])
    reads.length = 0
    const fetch = source.fetchTileSamples
    if (!fetch) throw new Error('no fetchTileSamples')
    // Right column tile: x = 2, y = 0..1.
    const s = await fetch(l0, tileAt(l0, 1), [2, 0])
    expect(s).toMatchObject({ width: 1, height: 2, bitsStored: 16, planes: 2 })
    expect(s.samples).toBeInstanceOf(Uint16Array)
    expect(Array.from(s.samples)).toEqual([2002, 2005, 2, 5])
    expect(reads.some((k) => k.includes('/c/1/'))).toBe(false)
  })

  test('multi-channel float32 on x, y axes: per-channel quantization, uint8 stays 8-bit', async () => {
    // c, x, y = 2 x 2 x 1: channel 0 over 0..1, channel 1 over 0..100.
    const store = await writeImage(
      {
        multiscales: multiscale(['c', 'x', 'y'], 1),
        omero: {
          channels: [
            { window: { start: 0, end: 1, min: 0, max: 1 } },
            { window: { start: 0, end: 50, min: 0, max: 100 } },
          ],
        },
      },
      [
        {
          shape: [2, 2, 1],
          chunks: [1, 2, 1],
          data: Float32Array.from([0.5, 1, 50, 100]),
        },
      ],
      'float32',
    )
    const source = await ZarrSlideSource.fromStore(store)
    const [l0] = source.manifest.levels
    expect(source.manifest.channelInfo?.map((c) => c.window)).toEqual([
      { calMin: 0, calMax: 65535 },
      { calMin: 0, calMax: 32767.5 },
    ])
    const s = await source.fetchTileSamples?.(l0, tileAt(l0, 0), [0, 1])
    expect(Array.from(s?.samples ?? [])).toEqual([32768, 65535, 32768, 65535])
    const u8 = await writeImage(
      { multiscales: multiscale(['c', 'y', 'x'], 1) },
      [
        {
          shape: [2, 1, 2],
          chunks: [2, 1, 2],
          data: Uint8Array.from([1, 2, 3, 4]),
        },
      ],
      'uint8',
    )
    const s8 = await ZarrSlideSource.fromStore(u8)
    const [m0] = s8.manifest.levels
    const t = await s8.fetchTileSamples?.(m0, tileAt(m0, 0), [1])
    expect(t?.samples).toBeInstanceOf(Uint8Array)
    expect(Array.from(t?.samples ?? [])).toEqual([3, 4])
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

test('quantized channels state storedToValue; NVSlide.sampleAt reads data values back', async () => {
  const store = await writeImage(
    { multiscales: multiscale(['c', 'y', 'x'], 1) },
    [
      {
        shape: [2, 1, 4],
        chunks: [1, 1, 4],
        data: Float32Array.from([0, 0.3, 0.7, 1, -50, 0, 25, 100]),
      },
    ],
    'float32',
  )
  const source = await ZarrSlideSource.fromStore(store)
  const maps = source.manifest.channelInfo?.map((c) => c.storedToValue)
  expect(maps).toEqual([
    { scale: 1 / 65535, offset: 0 },
    { scale: 150 / 65535, offset: -50 },
  ])
  const slide = await withFakeBitmaps(async () => {
    const slide = NVSlide.fromSource(source)
    await slide.loadSampleAt(0, 0)
    return slide
  })
  const values = [
    [0, 0.3, 0.7, 1],
    [-50, 0, 25, 100],
  ]
  for (let x = 0; x < 4; x++)
    for (const [c, s] of slide.sampleAt(x, 0).entries()) {
      const step = maps?.[c]?.scale ?? 0
      expect(Math.abs((s.value ?? Number.NaN) - values[c][x])).toBeLessThan(
        step / 2 + 1e-9,
      )
      // The range ends are bounds: values beyond them clamp there.
      expect([s.exact, s.clipped]).toEqual([
        false,
        x === 0 || x === 3 ? true : undefined,
      ])
    }
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

test('the data range samples a bounded grid of chunks, not the whole image', async () => {
  // 1 x 8192 in 512-wide chunks (16): a grid of 4 spread chunks is read.
  const data = ramp(8192, (i) => (i < 512 ? 100 + i : 50))
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 8192], chunks: [1, 512], data }],
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
  // Chunk 0 is 512 wide, under the span cap, so it is read whole: 2048
  // samples, 1536 at 50. 2-98%: 41 per end, the top 41 being 571..611; values
  // snap to 1/1000 of 50..611 (bin 929).
  expect(source.window).toEqual({ calMin: 50, calMax: bin(929, 50, 611) })
  expect(read.filter((k) => k.includes('/c/')).sort()).toEqual([
    '/0/c/0/0',
    '/0/c/0/10',
    '/0/c/0/15',
    '/0/c/0/5',
  ])
})

test('the data range reads a few chunks at a time and stops after a failure', async () => {
  // 64 x 64 in 16 x 16 chunks: the 4 x 4 sample grid covers all 16 chunks.
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [64, 64], chunks: [16, 16], data: ramp(4096, (i) => i) }],
    'uint16',
  )
  const isChunk = (k: string) => k.includes('/c/')
  let inFlight = 0
  let peak = 0
  let reads = 0
  const spy = (failKey?: string) => ({
    get: async (key: string) => {
      if (!isChunk(key)) return store.get(key)
      reads++
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      if (key === failKey) throw new Error('chunk read failed')
      return store.get(key)
    },
  })
  const ok = await ZarrSlideSource.fromStore(spy())
  // 2-98% of 0..4095 (zero excluded): 82 per end, bins 20 and 980 of 1000.
  expect(ok.window).toEqual({
    calMin: bin(20, 0, 4095),
    calMax: bin(980, 0, 4095),
  })
  expect(reads).toBe(16)
  expect(peak).toBe(4)
  reads = 0
  await expect(ZarrSlideSource.fromStore(spy('/0/c/0/0'))).rejects.toThrow(
    'chunk read failed',
  )
  // The failing read was among the first 4; the other 3 finish, none start.
  expect(reads).toBe(4)
  // A failure rejects the open even while another read never settles.
  const stalled = {
    get: async (key: string) => {
      if (!isChunk(key)) return store.get(key)
      if (key === '/0/c/0/0') throw new Error('chunk read failed')
      return new Promise<Uint8Array>(() => {})
    },
  }
  await expect(ZarrSlideSource.fromStore(stalled)).rejects.toThrow(
    'chunk read failed',
  )
})

test('a multi-channel store reads its channel ranges a few chunks at a time', async () => {
  // 3 uint16 channels of 64 x 64 in 16 x 16 chunks, no omero windows: each
  // channel's range samples all 16 of its chunks.
  const store = await writeImage(
    { multiscales: multiscale(['c', 'y', 'x'], 1) },
    [
      {
        shape: [3, 64, 64],
        chunks: [1, 16, 16],
        data: ramp(3 * 4096, (i) => i),
      },
    ],
    'uint16',
  )
  let inFlight = 0
  let peak = 0
  let reads = 0
  const source = await ZarrSlideSource.fromStore({
    get: async (key: string) => {
      if (!key.includes('/c/')) return store.get(key)
      reads++
      peak = Math.max(peak, ++inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return store.get(key)
    },
  })
  expect(source.manifest.channelInfo).toHaveLength(3)
  expect(reads).toBe(48)
  expect(peak).toBe(4)
})

test('a flat, empty or huge sample still quantizes values outside it to distinct levels', async () => {
  // 1 x 8192 in 512-wide chunks: the sampled chunks (0, 5, 10, 15) hold
  // `fill`; unsampled chunk 1 holds `values` in turn.
  const cases = [
    { dtype: 'int32', fill: 7, values: [0, 7, 14] },
    { dtype: 'float32', fill: 7, values: [0, 7, 14] },
    { dtype: 'float32', fill: Number.NaN, values: [0, 7, 14] },
    { dtype: 'float64', fill: 1e308, values: [0.5e308, 1e308, 1.5e308] },
    // Sampled range -1e308..1e308: hi - lo overflows.
    { dtype: 'float64', fill: [-1e308, 1e308], values: [-5e307, 0, 5e307] },
    // Sampled range 0..1e-323: 65535 / (hi - lo) overflows.
    { dtype: 'float64', fill: [0, 1e-323], values: [0, 5e-324, 1e-323] },
  ] as const
  for (const { dtype, fill, values } of cases) {
    // A pair fill alternates its two values across the sampled chunks.
    const all = Array.from({ length: 8192 }, (_, i) =>
      i >= 512 && i < 1024
        ? values[i % 3]
        : typeof fill === 'number'
          ? fill
          : fill[i % 2],
    )
    const data =
      dtype === 'int32'
        ? Int32Array.from(all)
        : dtype === 'float32'
          ? Float32Array.from(all)
          : Float64Array.from(all)
    const store = await writeImage(
      { multiscales: multiscale(['y', 'x'], 1) },
      [{ shape: [1, 8192], chunks: [1, 512], data }],
      dtype,
    )
    const source = await ZarrSlideSource.fromStore(store)
    const [l0] = source.manifest.levels
    const tile = l0.tiles[1]
    if (!tile) throw new Error('no tile')
    const out = u16(await source.fetchTileBytes(l0, tile, 't'))
    expect([dtype, fill, new Set(out.slice(0, 3)).size]).toEqual([
      dtype,
      fill,
      3,
    ])
  }
})

test('a wide chunk is sampled from its middle, at most 1024 wide', async () => {
  // One 4096-wide chunk: values outside the middle 1024 are not seen.
  const data = ramp(4096, (i) =>
    i >= 1536 && i < 2560 ? 1000 + i - 1536 : 60000,
  )
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 4096], chunks: [1, 4096], data }],
    'uint16',
  )
  const source = await ZarrSlideSource.fromStore(store)
  // 2-98% of 1000..2023: 20 per end, bins 19 and 981 of 1000.
  expect(source.window).toEqual({
    calMin: bin(19, 1000, 2023),
    calMax: bin(981, 1000, 2023),
  })
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

test('a channel missing from a coarser level is refused on open', async () => {
  const grey = await writeImage(
    { multiscales: multiscale(['c', 'y', 'x'], 2) },
    [
      { shape: [2, 2, 2], chunks: [1, 2, 2], data: ramp(8, (i) => i) },
      { shape: [1, 1, 1], chunks: [1, 1, 1], data: ramp(1, () => 0) },
    ],
    'uint16',
  )
  await expect(ZarrSlideSource.fromStore(grey, { channel: 1 })).rejects.toThrow(
    'level 1 has 1 channels; channel 1 is out of range',
  )
  await ZarrSlideSource.fromStore(grey, { channel: 0 })
  // Without `channel` both are shown, so both must exist at every level.
  await expect(ZarrSlideSource.fromStore(grey)).rejects.toThrow(
    'level 1 has 1 channels; all 2 are shown',
  )
  const rgb = await writeImage(
    { multiscales: multiscale(['c', 'y', 'x'], 2) },
    [
      { shape: [3, 2, 2], chunks: [1, 2, 2], data: new Uint8Array(12) },
      { shape: [1, 1, 1], chunks: [1, 1, 1], data: new Uint8Array(1) },
    ],
    'uint8',
  )
  await expect(ZarrSlideSource.fromStore(rgb)).rejects.toThrow(
    'level 1 has 1 channels; RGB needs 3',
  )
})

test('invalid chunk shapes and too many tiles are refused before any read', async () => {
  // Metadata only: 1 x 2^21 + 1 one-pixel chunks, never written.
  const store: Store = new Map()
  const root = zarr.root(store)
  await zarr.create(root, {
    attributes: {
      ome: { version: '0.5', multiscales: multiscale(['y', 'x'], 1) },
    },
  })
  await zarr.create(root.resolve('0'), {
    shape: [1, 2 ** 21 + 1],
    chunkShape: [1, 1],
    dtype: 'uint8',
  })
  await expect(ZarrSlideSource.fromStore(store)).rejects.toThrow(
    'more than 2097152 tiles',
  )
  // A zero chunk width would loop forever building the tile list.
  const meta = JSON.parse(new TextDecoder().decode(store.get('/0/zarr.json')))
  meta.shape = [1, 4]
  meta.chunk_grid.configuration.chunk_shape = [1, 0]
  store.set('/0/zarr.json', new TextEncoder().encode(JSON.stringify(meta)))
  await expect(ZarrSlideSource.fromStore(store)).rejects.toThrow(
    'level 0 chunk 0x1 is invalid',
  )
})

test('levels not listed finest first are refused', async () => {
  const level = (n: number) => ({
    shape: [n, n],
    chunks: [n, n],
    data: new Uint8Array(n * n),
  })
  const open = async (sizes: number[]) =>
    ZarrSlideSource.fromStore(
      await writeImage(
        { multiscales: multiscale(['y', 'x'], sizes.length) },
        sizes.map(level),
        'uint8',
      ),
    )
  await expect(open([2, 4])).rejects.toThrow(
    'level 1 (4x4) is not smaller than level 0',
  )
  await expect(open([4, 4])).rejects.toThrow('level 1 (4x4) is not smaller')
  expect((await open([4, 2])).manifest.levels[1].downsample).toBe(2)
})

test('aborting fromUrl cancels its requests; tile reads after open keep their own signal', async () => {
  const store = await writeImage(
    { multiscales: multiscale(['y', 'x'], 1) },
    [{ shape: [1, 2], chunks: [1, 2], data: Uint8Array.from([1, 2]) }],
    'uint8',
  )
  const { fetchImpl } = fakeFetch((p) => store.get(p.slice('/s.zarr'.length)))
  const calls: Request[] = []
  const spy = (r: Request) => {
    calls.push(r)
    return fetchImpl(r)
  }
  await expect(
    ZarrSlideSource.fromUrl('http://h/s.zarr', {
      fetch: spy,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow()
  expect(calls.length).toBe(0)
  // Abort during open: the first request already carries an aborted signal.
  const ac = new AbortController()
  await expect(
    ZarrSlideSource.fromUrl('http://h/s.zarr', {
      fetch: (r) => {
        ac.abort()
        calls.push(r)
        return fetchImpl(r)
      },
      signal: ac.signal,
    }),
  ).rejects.toThrow()
  expect(calls[0]?.signal.aborted).toBe(true)
  // Aborting after open leaves tile reads alone.
  const late = new AbortController()
  const source = await ZarrSlideSource.fromUrl('http://h/s.zarr', {
    fetch: spy,
    signal: late.signal,
  })
  late.abort()
  const [l0] = source.manifest.levels
  expect(Array.from((await tileBytes(source, l0))[0])).toEqual([1, 2])
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
      // No channel option: both channels as sample planes.
      const source = await ZarrSlideSource.fromUrl(
        `http://h/${name}.ome.zarr`,
        { fetch: fetchImpl },
      )
      expect(source.manifest.channelInfo?.length).toBe(2)
      for (const [i, level] of source.manifest.levels.entries()) {
        const sums = [0, 0]
        for (const tile of level.tiles) {
          if (!tile) continue
          const s = await source.fetchTileSamples?.(level, tile, [0, 1])
          const n = tile.width * tile.height
          s?.samples.forEach((v, j) => {
            sums[j < n ? 0 : 1] += v
          })
        }
        expect(sums).toEqual(expected.levels[i].sum_per_channel)
      }
    },
  )
})
