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
    try {
      const res = await bridge.execute<{ volume: NVImage }>({
        url,
        urlImageData: pairedImgData,
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
      log.warn(
        `volumeLoad worker failed, falling back to main thread: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  const { hdr, img } = await loadVolume(url, pairedImgData)
  return nii2volume(hdr, img, name ?? NVLoader.getName(url), limitFrames4D)
}

/** Terminate the volume-load worker. Safe to call if no worker was created. */
export function terminateLoadWorker(): void {
  if (loadBridge) {
    loadBridge.terminate()
    loadBridge = null
  }
}
