/**
 * Web Worker entry point for volume fetch + parse.
 *
 * Runs the synchronous-heavy parts of volume loading (gzip decompression,
 * NIfTI parse, intensity stats, RAS matrix setup) off the main thread so UI
 * controls stay responsive while large volumes are being prepared.
 *
 * Protocol (NVWorker bridge):
 *   Request:  { _wbId, url, urlImageData?, limitFrames4D?, name? }
 *             url may be a string or a structured-cloneable File.
 *   Success:  { _wbId, volume }   (volume.img.buffer transferred; volume.hdr is a
 *             data-only snapshot — see hdrTransfer — that loadBridge rehydrates)
 *   Error:    { _wbId, _wbError: string }
 */

import * as NVLoader from '@/NVLoader'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import { hdrToTransferable } from '@/volume/hdrTransfer'
import { nii2volume } from '@/volume/NVVolume'

const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self) as (msg: unknown, transfer?: Transferable[]) => void

interface VolumeReader {
  extensions?: string[]
  read: (
    buffer: ArrayBuffer,
    name?: string,
    pairedImgData?: ArrayBuffer | null,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }>
}

const modules = import.meta.glob<VolumeReader>(
  ['../volume/readers/*.ts', '!../volume/readers/*.test.ts'],
  { eager: true },
)
const readerByExt = NVLoader.buildExtensionMap(modules)

interface LoadRequest {
  _wbId: number
  url: string | File
  urlImageData?: string | File | null
  limitFrames4D?: number
  name?: string
}

self.onmessage = async (e: MessageEvent<LoadRequest>) => {
  const { _wbId: id, url, urlImageData, limitFrames4D, name } = e.data
  try {
    const buffer = await NVLoader.fetchFile(url)
    const pairedBuffer = urlImageData
      ? await NVLoader.fetchFile(urlImageData)
      : null
    const ext = NVLoader.getFileExt(url)
    let reader = readerByExt.get(ext)
    if (!reader || typeof reader.read !== 'function') {
      reader = readerByExt.get('NII')
    }
    if (!reader) {
      throw new Error(`No volume reader available for extension ${ext}`)
    }
    const fileName = name ?? NVLoader.getName(url)
    const { hdr, img } = await reader.read(buffer, fileName, pairedBuffer)
    const volume = nii2volume(hdr, img, fileName, limitFrames4D ?? Infinity)
    const transfer: Transferable[] = []
    if (volume.img && 'buffer' in volume.img) {
      transfer.push(volume.img.buffer as ArrayBuffer)
    }
    // `volume.hdr` is a NIFTI1/NIFTI2 instance whose methods are own properties,
    // which structured clone rejects. Post a data-only snapshot; loadBridge
    // rebuilds a real instance from it.
    const wire = { ...volume, hdr: hdrToTransferable(volume.hdr) }
    post({ _wbId: id, volume: wire }, transfer)
  } catch (err) {
    post({
      _wbId: id,
      _wbError: err instanceof Error ? err.message : String(err),
    })
  }
}
