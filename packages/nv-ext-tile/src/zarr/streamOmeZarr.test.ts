import { expect, mock, test } from 'bun:test'

const disposed: number[] = []
let opened = 0
// A store whose url is held here does not open until it is released.
const holds = new Map<string, Promise<void>>()
mock.module('./fetchOmeZarrChunkedSource', () => ({
  fetchOmeZarrChunkedSource: async (url: string) => {
    const id = ++opened
    await holds.get(url)
    return { id, url, dispose: () => disposed.push(id) }
  },
}))
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
