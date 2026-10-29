/**
 * Web Worker entry point for volume transforms.
 *
 * Runs the built-in transforms listed in `volume/transforms/_registry.ts` (the
 * same registry the main thread uses) off the main thread.
 *
 * Protocol (NVWorker bridge):
 *   Request:  { _wbId, name, hdr, img, options }
 *   Success:  { _wbId, hdr, img }          (img.buffer transferred)
 *   Error:    { _wbId, _wbError: string }
 */

// Worker-scope postMessage with Transferable[] support
const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self) as (msg: unknown, transfer?: Transferable[]) => void

import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import type { TransformOptions } from '@/volume/transforms'
import { transformModules } from '@/volume/transforms/_registry'

interface VolumeTransformModule {
  name: string
  apply: (
    hdr: NIFTI1 | NIFTI2,
    img: TypedVoxelArray | ArrayBuffer,
    options?: TransformOptions,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }>
}

const transforms = new Map<string, VolumeTransformModule>()
for (const mod of Object.values(transformModules)) {
  if (mod.name && typeof mod.apply === 'function') {
    transforms.set(mod.name, mod)
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { _wbId: id, name, hdr, img, options } = e.data

  const transform = transforms.get(name)
  if (!transform) {
    post({ _wbId: id, _wbError: `Unknown volume transform: ${name}` })
    return
  }

  try {
    const result = await transform.apply(hdr, img, options)
    // NIFTI class instances have non-cloneable function properties;
    // JSON round-trip produces a plain data-only object safe for postMessage.
    const plainHdr = JSON.parse(JSON.stringify(result.hdr))
    // Transfer the output image buffer back (zero-copy)
    post({ _wbId: id, hdr: plainHdr, img: result.img }, [
      result.img.buffer as ArrayBuffer,
    ])
  } catch (err) {
    post({
      _wbId: id,
      _wbError: err instanceof Error ? err.message : String(err),
    })
  }
}
