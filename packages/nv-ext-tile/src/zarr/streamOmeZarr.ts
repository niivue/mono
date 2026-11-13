import type {
  ChunkedVolumeOptions,
  NiiVue,
  NVChunkedVolume,
} from '@niivue/niivue'
import { fetchOmeZarrChunkedSource } from './fetchOmeZarrChunkedSource'
import { omeroActiveChannels } from './omeZarr'
import type { FetchOmeZarrChunkedSourceOptions } from './omeZarrChunkedSource'
import { omeZarrChannelOptions, omeZarrLabelColormap } from './omeZarrLoader'

type Viewer = Pick<
  NiiVue,
  | 'addColormap'
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
  /** Show it as a segmentation (true) or not (false); detected from `image-label` otherwise. */
  labels?: boolean
}

// The last replacement on each viewer: a replacement waits for it, so two
// overlapping ones cannot both clear the scene before either adds its volume.
const replacing = new WeakMap<Viewer, Promise<unknown>>()

/**
 * Stream an OME-Zarr store into `nv` (added, as `loadChunkedVolume` adds,
 * unless `replace`) and own what that leaves running: once the streamed
 * volume is removed (by any load or removal, even while it initializes) or
 * `nv` is destroyed, the manager is disposed and the source's worker pool
 * terminated. A segmentation (`image-label`) shows its stated colours,
 * registered as `<url> labels`, else the generated `Random` colormap, as a
 * whole-level load does. For callers that hold no handle of their own (bindings,
 * agents); an app that shares the source, as a volume and a slide do, keeps
 * using `fetchOmeZarrChunkedSource` and disposes it itself.
 */
export async function streamOmeZarr(
  nv: Viewer,
  url: string,
  { replace, labels, ...options }: StreamOmeZarrOptions = {},
  volumeOptions?: ChunkedVolumeOptions,
): Promise<NVChunkedVolume> {
  // Opening starts now, but a replacement joins the queue at call time, so an
  // earlier call whose store opens later cannot overwrite a newer one.
  const opening = fetchOmeZarrChunkedSource(url, options)
  opening.catch(() => {}) // awaited in show; this marks it handled while queued
  let source: Awaited<typeof opening> | undefined
  let chunked: NVChunkedVolume
  const show = async (): Promise<NVChunkedVolume> => {
    source = await opening
    if (nv.isDestroyed) throw new Error('the viewer was destroyed')
    if (replace) await nv.removeAllVolumes()
    return nv.loadChunkedVolume(source, {
      ...display(nv, url, source.zarr, options.channel, labels),
      ...volumeOptions,
    })
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
    source?.dispose?.()
    throw err
  }
  const opened = await opening // resolved by now; typed without the undefined
  // The scene holds a shallow copy of chunked.volume; its chunkSource is shared.
  const shown = (volume: { chunkSource?: unknown }): boolean =>
    volume.chunkSource === chunked.volume.chunkSource
  const release = (): void => {
    nv.removeEventListener('volumeRemoved', onRemoved)
    nv.removeEventListener('viewDestroyed', onDestroyed)
    chunked.dispose()
    opened.dispose?.()
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

// A segmentation's stated colours (else Random) under its omero name, as a
// whole-level load shows it; otherwise the channel's omero display.
function display(
  nv: Viewer,
  url: string,
  zarr: Parameters<typeof omeZarrChannelOptions>[0],
  channel?: number,
  labels = zarr.info.isLabel,
): ChunkedVolumeOptions {
  const shown = omeroDisplay(zarr, channel)
  // loadChunkedVolume refuses a label colormap on float64 IDs (not exact past
  // 2^24), so those stream as intensities; the source refuses (u)int64 at open.
  if (!labels || zarr.levels[0].dtype === 'float64') return shown
  const map = omeZarrLabelColormap(zarr.info)
  const colormap = map ? nv.addColormap(`${url} labels`, map) : 'Random'
  return shown.name === undefined
    ? { colormap }
    : { name: shown.name, colormap }
}

// The streamed channel's omero name, colour and window, as a whole-level load
// shows it; none for a store without omero, so it keeps the chunked defaults.
function omeroDisplay(
  zarr: Parameters<typeof omeZarrChannelOptions>[0],
  channel = omeroActiveChannels(zarr.info.channels, zarr.channelCount)[0],
): ChunkedVolumeOptions {
  if (zarr.info.channels.length === 0) return {}
  // Colormaps are assigned across the active set, as a whole-level load does,
  // so two channels stated with the same colour still get distinct ramps.
  const { visible: _visible, ...display } = omeZarrChannelOptions(zarr, channel)
  return display
}
