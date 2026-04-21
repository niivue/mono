/**
 * Web Worker entry point for volume transforms.
 *
 * Discovers transform plugins via import.meta.glob (same pattern as the
 * main-thread registry) and executes them off the main thread.
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

interface VolumeTransformModule {
  name: string
  apply: (
    hdr: NIFTI1 | NIFTI2,
    img: TypedVoxelArray | ArrayBuffer,
    options?: TransformOptions,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: TypedVoxelArray }>
}

// Auto-discover transform modules (mirrors the pattern in transforms/index.ts)
const modules = import.meta.glob<VolumeTransformModule>(
  '../volume/transforms/*.ts',
  { eager: true },
)

const transforms = new Map<string, VolumeTransformModule>()
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith('/index.ts')) continue
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
