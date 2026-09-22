import { log } from '@/logger'
import * as NVLoader from '@/NVLoader'
import type { NVImage } from '@/NVTypes'
import { NVWorker } from '@/workers/NVWorker'
import VolumeLoadWorker from '@/workers/volumeLoad.worker?worker&inline'
import { hdrFromTransferable, isTransferableHdr } from './hdrTransfer'
import {
  builtinReaderExts,
  hasReader,
  loadVolume,
  nii2volume,
} from './NVVolume'

let loadBridge: NVWorker | null = null
function getLoadBridge(): NVWorker | null {
  if (!NVWorker.isSupported()) return null
  if (!loadBridge) loadBridge = new NVWorker(() => new VolumeLoadWorker())
  return loadBridge
}

/**
 * Fetch, decode, and run nii2volume — off the main thread when a Worker is
 * available. Falls back to direct main-thread execution if Workers are not
 * supported, the file's extension is handled by a runtime-registered external
 * reader the worker doesn't know about, or the worker itself errors.
 */
export async function loadVolumePrepared(
  url: string | File,
  pairedImgData: string | File | null = null,
  limitFrames4D = Infinity,
  name?: string,
): Promise<NVImage> {
  const ext = NVLoader.getFileExt(url)
  const handledByExternalReader = hasReader(ext) && !builtinReaderExts.has(ext)
  const bridge = handledByExternalReader ? null : getLoadBridge()
  if (bridge) {
    // Resolve against the DOCUMENT before handing the URL over. A worker's base
    // is its own script — a blob: URL for `?worker&inline` — so a relative URL
    // like `../volumes/x.nii.gz` resolves to nonsense there (404 in dev, a
    // `Failed to parse URL` TypeError from a blob worker in a build). That has
    // always been broken; it was invisible only because every worker failure was
    // silently retried on the main thread, where the base is correct.
    const resolve = (u: string | File | null): string | File | null =>
      typeof u === 'string' && typeof location !== 'undefined'
        ? new URL(u, location.href).href
        : u
    try {
      const res = await bridge.execute<{ volume: NVImage }>({
        url: resolve(url) as string | File,
        urlImageData: resolve(pairedImgData),
        limitFrames4D,
        name,
      })
      // The worker sends the header as a data-only snapshot (its methods are own
      // properties, which structured clone rejects). Rebuild the real instance so
      // callers keep hdr.toFormattedString(), getDatatypeCodeString(), etc.
      const volume = res.volume
      if (isTransferableHdr(volume.hdr)) {
        volume.hdr = hdrFromTransferable(volume.hdr)
      }
      return volume
    } catch (err) {
      // Only INFRASTRUCTURE failures are worth retrying here — no Worker, a
      // terminated one, a transport error. A `VolumeLoadError` means a healthy
      // worker read the input and the input was bad, so re-running the whole
      // fetch + decompress + parse on the UI thread burns the same CPU and
      // transient memory to reach the same failure.
      if (err instanceof Error && err.name === 'VolumeLoadError') throw err
      log.warn(
        `volumeLoad worker failed, falling back to main thread: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  // Pass the limit: `loadVolume`'s third parameter defaults to Infinity, and
  // its partial fast path is gated on `Number.isFinite(limitFrames4D)`. Omitting
  // it here meant the bounded 4D loader could never engage on this path, so a
  // 4D request decoded every frame and `nii2volume` merely discarded them.
  const { hdr, img } = await loadVolume(url, pairedImgData, limitFrames4D, name)
  return nii2volume(hdr, img, name ?? NVLoader.getName(url), limitFrames4D)
}

/** Terminate the volume-load worker. Safe to call if no worker was created. */
export function terminateLoadWorker(): void {
  if (loadBridge) {
    loadBridge.terminate()
    loadBridge = null
  }
}
