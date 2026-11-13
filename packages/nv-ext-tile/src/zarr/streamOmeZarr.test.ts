import { expect, mock, test } from 'bun:test'
import { omeZarrChunkedSource } from './omeZarrChunkedSource'
import { openOmeZarr } from './omeZarrLoader'

const disposed: number[] = []
let opened = 0
// A store whose url is held here does not open until it is released.
const holds = new Map<string, Promise<void>>()
// In-memory stores opened through the real source, as fetchOmeZarrChunkedSource does.
const stores = new Map<string, Map<string, Uint8Array>>()
mock.module('./fetchOmeZarrChunkedSource', () => ({
  fetchOmeZarrChunkedSource: async (url: string) => {
    const id = ++opened
    await holds.get(url)
    const store = stores.get(url)
    if (store) {
      const source = omeZarrChunkedSource(await openOmeZarr(store))
      return { ...source, id, dispose: () => disposed.push(id) }
    }
    return {
      id,
      url,
      zarr: zarrs.get(url) ?? noOmero,
      dispose: () => disposed.push(id),
    }
  },
}))
const noOmero = {
  info: { channels: [] },
  channelCount: 1,
  levels: [{ dtype: 'uint16' }],
}
const zarrs = new Map<string, unknown>()
const { streamOmeZarr } = await import('./streamOmeZarr')

test('overlapping replacement streams leave only the last volume shown', async () => {
  const events = new EventTarget()
  // Every removal waits here, so overlapping ones would all clear before any adds.
  let open = (): void => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const volumes: Array<{ chunkSource: { id: number } }> = []
  const nv = {
    isDestroyed: false,
    volumes,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    async removeAllVolumes() {
      await gate
      for (const volume of volumes.splice(0)) {
        events.dispatchEvent(
          new CustomEvent('volumeRemoved', { detail: { volume } }),
        )
      }
    },
    async loadChunkedVolume(source: { id: number }) {
      const volume = { chunkSource: source }
      volumes.push(volume)
      return { volume, dispose() {} }
    },
  }
  const viewer = nv as unknown as Parameters<typeof streamOmeZarr>[0]
  const streams = Promise.all([
    streamOmeZarr(viewer, 'https://example.test/a.zarr', { replace: true }),
    streamOmeZarr(viewer, 'https://example.test/b.zarr', { replace: true }),
  ])
  await Bun.sleep(5)
  open()
  await streams
  expect(volumes.map((v) => v.chunkSource.id)).toEqual([2])
  // The replaced stream released its source; the shown one did not.
  expect(disposed).toEqual([1])
})

test('an earlier replacement whose store opens later does not overwrite a newer one', async () => {
  const events = new EventTarget()
  const volumes: Array<{ chunkSource: { url: string } }> = []
  const nv = {
    isDestroyed: false,
    volumes,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    async removeAllVolumes() {
      for (const volume of volumes.splice(0)) {
        events.dispatchEvent(
          new CustomEvent('volumeRemoved', { detail: { volume } }),
        )
      }
    },
    async loadChunkedVolume(source: { url: string }) {
      const volume = { chunkSource: source }
      volumes.push(volume)
      return { volume, dispose() {} }
    },
  }
  const viewer = nv as unknown as Parameters<typeof streamOmeZarr>[0]
  let release = (): void => {}
  holds.set(
    'https://example.test/late-a.zarr',
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const a = streamOmeZarr(viewer, 'https://example.test/late-a.zarr', {
    replace: true,
  })
  const b = streamOmeZarr(viewer, 'https://example.test/late-b.zarr', {
    replace: true,
  })
  await Bun.sleep(5)
  release()
  await Promise.all([a, b])
  expect(volumes.map((v) => v.chunkSource.url)).toEqual([
    'https://example.test/late-b.zarr',
  ])
})

test('a streamed channel takes its omero name, colour and window; caller options win', async () => {
  const window = { start: 5, end: 50, min: 0, max: 65535 }
  zarrs.set('https://example.test/omero.zarr', {
    info: {
      channels: [
        { label: 'DAPI', color: [0, 0, 255], window, active: false },
        { label: 'CD19', color: [255, 0, 0], window, active: true },
      ],
    },
    channelCount: 2,
    levels: [{ dtype: 'uint16' }],
  })
  // Two active channels stated red get distinct ramps, as in a whole-level load.
  zarrs.set('https://example.test/twored.zarr', {
    info: {
      channels: [
        { label: 'A', color: [255, 0, 0], window, active: true },
        { label: 'B', color: [255, 0, 0], window, active: true },
      ],
    },
    channelCount: 2,
    levels: [{ dtype: 'uint16' }],
  })
  // Segmentations: stated colours registered under the url, else Random.
  const label = (labelColors: unknown[]) => ({
    info: { channels: [], isLabel: true, labelColors },
    channelCount: 1,
    levels: [{ dtype: 'uint16' }],
  })
  zarrs.set(
    'https://example.test/seg.zarr',
    label([{ id: 1, rgba: [255, 0, 0, 255] }]),
  )
  zarrs.set('https://example.test/plainseg.zarr', label([]))
  const loaded: unknown[] = []
  const added: string[] = []
  const nv = {
    isDestroyed: false,
    volumes: [] as unknown[],
    addColormap(name: string) {
      added.push(name)
      return name
    },
    addEventListener() {},
    removeEventListener() {},
    async removeAllVolumes() {},
    async loadChunkedVolume(source: unknown, options: unknown) {
      loaded.push(options)
      const volume = { chunkSource: source }
      nv.volumes.push(volume)
      return { volume, dispose() {} }
    },
  }
  const viewer = nv as unknown as Parameters<typeof streamOmeZarr>[0]
  await streamOmeZarr(viewer, 'https://example.test/omero.zarr')
  await streamOmeZarr(
    viewer,
    'https://example.test/omero.zarr',
    {},
    { colormap: 'gray' },
  )
  await streamOmeZarr(viewer, 'https://example.test/plain.zarr')
  await streamOmeZarr(viewer, 'https://example.test/twored.zarr', {
    channel: 1,
  })
  await streamOmeZarr(viewer, 'https://example.test/seg.zarr')
  await streamOmeZarr(viewer, 'https://example.test/plainseg.zarr')
  await streamOmeZarr(viewer, 'https://example.test/seg.zarr', {
    labels: false,
  })
  expect(loaded).toEqual([
    { name: 'CD19', colormap: 'red', calMin: 5, calMax: 50 },
    { name: 'CD19', colormap: 'gray', calMin: 5, calMax: 50 },
    {},
    { name: 'B', colormap: 'violet', calMin: 5, calMax: 50 },
    { colormap: 'https://example.test/seg.zarr labels' },
    { colormap: 'Random' },
    {},
  ])
  expect(added).toEqual(['https://example.test/seg.zarr labels'])
})

// A 2x2x2 zyx label store of the given zarr v2 dtype, with no chunks (all fill).
function labelStore(dtype: string): Map<string, Uint8Array> {
  const json = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value))
  const axes = ['z', 'y', 'x'].map((name) => ({ name, type: 'space' }))
  return new Map([
    ['/.zgroup', json({ zarr_format: 2 })],
    [
      '/.zattrs',
      json({
        multiscales: [
          {
            version: '0.4',
            axes,
            datasets: [
              {
                path: '0',
                coordinateTransformations: [
                  { type: 'scale', scale: [1, 1, 1] },
                ],
              },
            ],
          },
        ],
        'image-label': {},
      }),
    ],
    [
      '/0/.zarray',
      json({
        zarr_format: 2,
        shape: [2, 2, 2],
        chunks: [2, 2, 2],
        dtype,
        compressor: null,
        fill_value: 0,
        order: 'C',
        filters: null,
      }),
    ],
  ])
}

test('64-bit label stores: float64 streams as intensities, (u)int64 is refused at open', async () => {
  stores.set('https://example.test/f64seg.zarr', labelStore('<f8'))
  stores.set('https://example.test/u64seg.zarr', labelStore('<u8'))
  stores.set('https://example.test/i64seg.zarr', labelStore('<i8'))
  const loaded: unknown[] = []
  const nv = {
    isDestroyed: false,
    volumes: [] as unknown[],
    addColormap: (name: string) => name,
    addEventListener() {},
    removeEventListener() {},
    async removeAllVolumes() {
      nv.volumes.length = 0
    },
    async loadChunkedVolume(source: unknown, options: unknown) {
      loaded.push(options)
      const volume = { chunkSource: source }
      nv.volumes.push(volume)
      return { volume, dispose() {} }
    },
  }
  const viewer = nv as unknown as Parameters<typeof streamOmeZarr>[0]
  await streamOmeZarr(viewer, 'https://example.test/f64seg.zarr')
  expect(loaded).toEqual([{}])
  for (const dtype of ['uint64', 'int64']) {
    const url = `https://example.test/${dtype[0]}64seg.zarr`
    await expect(streamOmeZarr(viewer, url, { replace: true })).rejects.toThrow(
      `OME-Zarr: dtype '${dtype}' is not supported`,
    )
  }
  // Refused before the scene was touched.
  expect(loaded).toEqual([{}])
  expect(nv.volumes).toHaveLength(1)
})
