import * as nifti from 'nifti-reader-js'
import type { SignalSidecar } from '@/NVTypes'
import { hasMrsFields } from './sidecar'

/**
 * Decide whether an ambiguous NIfTI should be treated as a signal rather than a
 * spatial volume. A NIfTI is a signal when EITHER:
 *
 *  - the sidecar carries MRS-defining fields (SpectrometerFrequency /
 *    ResonantNucleus), or
 *  - it has no spatial extent: dim1 == dim2 == dim3 == 1 and dim4 > 1.
 *
 * Datatype is deliberately NOT consulted: spatial MR is routinely complex
 * (real/imaginary), so a complex volume stays a volume unless one of the above
 * holds.
 */
export function niftiBufferIsSignal(
  buffer: ArrayBuffer,
  sidecar?: SignalSidecar | null,
): boolean {
  if (sidecar && hasMrsFields(sidecar)) return true
  try {
    const decompressed = nifti.isCompressed(buffer)
      ? nifti.decompress(buffer)
      : buffer
    const hdr = nifti.readHeader(decompressed as ArrayBuffer)
    if (!hdr) return false
    const d = hdr.dims
    return d[1] === 1 && d[2] === 1 && d[3] === 1 && d[4] > 1
  } catch {
    return false
  }
}
