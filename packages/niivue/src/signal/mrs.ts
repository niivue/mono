import { NiiDataType } from '@/NVConstants'
import type { SignalSidecar } from '@/NVTypes'
import { parseMrsExtension } from './sidecar'

/** Minimal structural view of a NIfTI header's extension list (both lib + NVTypes headers satisfy it). */
type HeaderWithExtensions = {
  extensions?: Array<{ ecode: number; edata: ArrayBuffer }>
}

/**
 * Shared NIfTI-MRS decode helpers used by BOTH the signal path
 * (`signal/readers/nii.ts`, single-voxel SVS) and the volume path
 * (`volume/mrsi.ts`, spatial MRSI/CSI), so complex decoding and the
 * NIfTI-MRS header-extension parse have one implementation.
 */

/** True for the two complex NIfTI datatypes (64- and 128-bit complex). */
export function isComplexDatatype(code: number): boolean {
  return code === NiiDataType.DT_COMPLEX64 || code === NiiDataType.DT_COMPLEX128
}

/** Product of NIfTI dims[from..to], treating singleton/zero dims as 1. */
export function dimProduct(dims: number[], from: number, to: number): number {
  let n = 1
  for (let i = from; i <= to; i++) n *= dims[i] > 1 ? dims[i] : 1
  return n
}

/**
 * Spectral geometry from a NIfTI-MRS header: dim4 is the spectral axis
 * (`nPoints`), dims 5..7 are transients/coils (`nTransients`). Shared by the
 * SVS signal reader and the spatial MRSI volume path so both compute it
 * identically.
 */
export function mrsGeometry(dims: number[]): {
  nPoints: number
  nTransients: number
} {
  return {
    nPoints: dims[4] > 1 ? dims[4] : 1,
    nTransients: dimProduct(dims, 5, 7),
  }
}

/**
 * Decode a complex NIfTI image buffer into an interleaved Float32 array
 * `[re0, im0, re1, im1, ...]`, preserving the file's native sample order.
 * COMPLEX64 is already two float32s per sample; COMPLEX128 is narrowed to
 * float32 (display/spectra do not need double precision).
 */
export function decodeComplexFID(
  img: ArrayBuffer,
  datatypeCode: number,
): Float32Array {
  if (datatypeCode === NiiDataType.DT_COMPLEX128) {
    const f64 = new Float64Array(img)
    const fid = new Float32Array(f64.length)
    for (let i = 0; i < f64.length; i++) fid[i] = f64[i]
    return fid
  }
  return new Float32Array(img)
}

/**
 * Extract MRS metadata from NIfTI header extensions (NIfTI-MRS / BEP005 stores a
 * JSON document, conventionally in ecode 44). Used as a fallback when no JSON
 * sidecar is present. Returns an empty sidecar when nothing parses.
 */
export function mrsFromHeaderExtensions(
  hdr: HeaderWithExtensions,
): SignalSidecar {
  const exts = hdr.extensions ?? []
  for (const ext of exts) {
    // NIfTI-MRS (BEP005) uses developer ecode 44.
    if (ext.ecode !== 44) continue
    const meta = parseMrsExtension(ext.edata)
    if (
      meta.spectrometerFrequency !== undefined ||
      meta.resonantNucleus !== undefined ||
      meta.imagingFrequency !== undefined ||
      meta.dwellTime !== undefined
    ) {
      return meta
    }
  }
  return {}
}
