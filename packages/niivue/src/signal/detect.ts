import * as nifti from 'nifti-reader-js'

/**
 * Decide whether an ambiguous NIfTI should be treated as a signal rather than a
 * spatial volume. A NIfTI is a signal only when it has **no spatial extent**:
 * dim1 == dim2 == dim3 == 1 and dim4 > 1.
 *
 * MRS sidecar/header fields are deliberately NOT used to route here: a spatial
 * spectroscopic image (MRSI/CSI) carries MRS fields too, but its dim1-3 encode
 * space, which the 1-D signal reader cannot represent. Such files must stay on
 * the volume path (MRSI is not yet supported). Datatype is likewise not
 * consulted (spatial MR is routinely complex). The `asSignal` load option
 * overrides this sniff in either direction.
 */
export function niftiBufferIsSignal(buffer: ArrayBuffer): boolean {
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
