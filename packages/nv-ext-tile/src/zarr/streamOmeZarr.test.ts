import { expect, mock, test } from 'bun:test'

const disposed: number[] = []
let opened = 0
// A store whose url is held here does not open until it is released.
const holds = new Map<string, Promise<void>>()
mock.module('./fetchOmeZarrChunkedSource', () => ({
  fetchOmeZarrChunkedSource: async (url: string) => {
    const id = ++opened
    await holds.get(url)
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
  const label = (labelColors: unknown[], dtype = 'uint16') => ({
    info: { channels: [], isLabel: true, labelColors },
    channelCount: 1,
    levels: [{ dtype }],
  })
  zarrs.set(
    'https://example.test/seg.zarr',
    label([{ id: 1, rgba: [255, 0, 0, 255] }]),
  )
  zarrs.set('https://example.test/plainseg.zarr', label([]))
  // 64-bit IDs: core refuses a label colormap, so it streams as intensities.
  zarrs.set('https://example.test/wideseg.zarr', label([], 'uint64'))
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
  await streamOmeZarr(viewer, 'https://example.test/wideseg.zarr')
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
    {},
  ])
  expect(added).toEqual(['https://example.test/seg.zarr labels'])
})
