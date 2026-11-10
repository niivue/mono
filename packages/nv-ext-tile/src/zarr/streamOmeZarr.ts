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
  | 'removeAllVolumes'
  | 'volumes'
  | 'addEventListener'
  | 'removeEventListener'
  | 'isDestroyed'
>

export interface StreamOmeZarrOptions extends FetchOmeZarrChunkedSourceOptions {
  /** Remove the volumes shown once the store has opened, so a store that fails to open leaves the scene as it was. */
  replace?: boolean
}

// The last replacement on each viewer: a replacement waits for it, so two
// overlapping ones cannot both clear the scene before either adds its volume.
const replacing = new WeakMap<Viewer, Promise<unknown>>()

/**
 * Stream an OME-Zarr store into `nv` (added, as `loadChunkedVolume` adds,
 * unless `replace`) and own what that leaves running: once the streamed
 * volume is removed (by any load or removal, even while it initializes) or
 * `nv` is destroyed, the manager is disposed and the source's worker pool
 * terminated. For callers that hold no handle of their own (bindings,
 * agents); an app that shares the source, as a volume and a slide do, keeps
 * using `fetchOmeZarrChunkedSource` and disposes it itself.
 */
export async function streamOmeZarr(
  nv: Viewer,
  url: string,
  { replace, ...options }: StreamOmeZarrOptions = {},
  volumeOptions?: ChunkedVolumeOptions,
): Promise<NVChunkedVolume> {
  const source = await fetchOmeZarrChunkedSource(url, options)
  let chunked: NVChunkedVolume
  const show = async (): Promise<NVChunkedVolume> => {
    if (nv.isDestroyed) throw new Error('the viewer was destroyed')
    if (replace) await nv.removeAllVolumes()
    return nv.loadChunkedVolume(source, volumeOptions)
  }
  try {
    if (replace) {
      const run = (replacing.get(nv) ?? Promise.resolve()).then(show)
      replacing.set(
        nv,
        run.catch(() => {}),
      )
      chunked = await run
    } else {
      chunked = await show()
    }
  } catch (err) {
    source.dispose?.()
    throw err
  }
  // The scene holds a shallow copy of chunked.volume; its chunkSource is shared.
  const shown = (volume: { chunkSource?: unknown }): boolean =>
    volume.chunkSource === chunked.volume.chunkSource
  const release = (): void => {
    nv.removeEventListener('volumeRemoved', onRemoved)
    nv.removeEventListener('viewDestroyed', onDestroyed)
    chunked.dispose()
    source.dispose?.()
  }
  const onRemoved = (e: Event): void => {
    const { volume } = (e as CustomEvent<{ volume: { chunkSource?: unknown } }>)
      .detail
    if (shown(volume)) release()
  }
  // viewDestroyed also fires when a view is rebuilt; only a real teardown counts.
  const onDestroyed = (): void => {
    if (nv.isDestroyed) release()
  }
  nv.addEventListener('volumeRemoved', onRemoved)
  nv.addEventListener('viewDestroyed', onDestroyed)
  // Removed, or the viewer destroyed, while it initialized: those events came
  // before these listeners.
  if (nv.isDestroyed || !nv.volumes.some(shown)) release()
  return chunked
}
