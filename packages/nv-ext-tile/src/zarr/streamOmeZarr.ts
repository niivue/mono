import type {
  ChunkedVolumeOptions,
  NiiVue,
  NVChunkedVolume,
} from '@niivue/niivue'
import { fetchOmeZarrChunkedSource } from './fetchOmeZarrChunkedSource'
import type { FetchOmeZarrChunkedSourceOptions } from './omeZarrChunkedSource'

type Viewer = Pick<
  NiiVue,
  | 'loadChunkedVolume'
  | 'addEventListener'
  | 'removeEventListener'
  | 'isDestroyed'
>

/**
 * Stream an OME-Zarr store into `nv` (added, as `loadChunkedVolume` adds) and
 * own what that leaves running: once the streamed volume is removed (by any
 * load or removal) or `nv` is destroyed, the manager is disposed and the
 * source's worker pool terminated. For callers that hold no handle of their
 * own (bindings, agents); an app that shares the source, as a volume and a
 * slide do, keeps using `fetchOmeZarrChunkedSource` and disposes it itself.
 */
export async function streamOmeZarr(
  nv: Viewer,
  url: string,
  options: FetchOmeZarrChunkedSourceOptions = {},
  volumeOptions?: ChunkedVolumeOptions,
): Promise<NVChunkedVolume> {
  const source = await fetchOmeZarrChunkedSource(url, options)
  let chunked: NVChunkedVolume
  try {
    chunked = await nv.loadChunkedVolume(source, volumeOptions)
  } catch (err) {
    source.dispose?.()
    throw err
  }
  const release = (): void => {
    nv.removeEventListener('volumeRemoved', onRemoved)
    nv.removeEventListener('viewDestroyed', onDestroyed)
    chunked.dispose()
    source.dispose?.()
  }
  // The scene holds a shallow copy of chunked.volume; its chunkSource is shared.
  const onRemoved = (e: Event): void => {
    const { volume } = (e as CustomEvent<{ volume: { chunkSource?: unknown } }>)
      .detail
    if (volume.chunkSource === chunked.volume.chunkSource) release()
  }
  // viewDestroyed also fires when a view is rebuilt; only a real teardown counts.
  const onDestroyed = (): void => {
    if (nv.isDestroyed) release()
  }
  nv.addEventListener('volumeRemoved', onRemoved)
  nv.addEventListener('viewDestroyed', onDestroyed)
  return chunked
}
