import * as nifti from 'nifti-reader-js'
import { log } from '@/logger'
import { NiiDataType } from '@/NVConstants'
import type { NVSignalRaw, SignalSidecar } from '@/NVTypes'
import { toTypedViewOrU8 } from '@/volume/utils'

export const extensions = ['nii', 'nii.gz']
export const type = 'nii'

function isComplex(code: number): boolean {
  return code === NiiDataType.DT_COMPLEX64 || code === NiiDataType.DT_COMPLEX128
}

function product(dims: number[], from: number, to: number): number {
  let n = 1
  for (let i = from; i <= to; i++) n *= dims[i] > 1 ? dims[i] : 1
  return n
}

/**
 * Read a NIfTI file as a non-spatial signal. Reuses `nifti-reader-js` header
 * parsing (like the volume reader) but does NOT route through `nii2volume`,
 * which is GPU-volume specific and would discard complex data.
 *
 * - Complex datatype  -> spectroscopy (interleaved real/imag FID).
 * - Real, non-spatial -> physio (dim4 is the time axis, dims5..7 are columns).
 *
 * Volume-vs-signal disambiguation lives in the loader, not here; by the time a
 * file reaches this reader it has been classified as a signal.
 */
export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  sidecar?: SignalSidecar | null,
): Promise<NVSignalRaw> {
  const hdr = nifti.readHeader(buffer)
  const imageBuffer = nifti.isCompressed(buffer)
    ? nifti.decompress(buffer)
    : buffer
  const img = nifti.readImage(hdr, imageBuffer as ArrayBuffer) as ArrayBuffer
  const dims = hdr.dims
  const pixDims = hdr.pixDims

  if (isComplex(hdr.datatypeCode)) {
    let fid: Float32Array
    if (hdr.datatypeCode === NiiDataType.DT_COMPLEX128) {
      const f64 = new Float64Array(img)
      fid = new Float32Array(f64.length)
      for (let i = 0; i < f64.length; i++) fid[i] = f64[i]
    } else {
      fid = new Float32Array(img)
    }
    // Clamp the declared geometry to what the data actually holds so the
    // transform never indexes past the end (truncated/corrupt files).
    const available = Math.floor(fid.length / 2)
    let nPoints = dims[4] > 1 ? dims[4] : 1
    let nTransients = product(dims, 5, 7)
    if (nPoints * nTransients > available) {
      log.warn(
        `nii signal: declared ${nPoints}x${nTransients} complex samples exceed ${available} available; clamping`,
      )
      nPoints = Math.min(nPoints, available)
      nTransients = nPoints > 0 ? Math.floor(available / nPoints) : 0
    }
    const dwell = pixDims[4] > 0 ? pixDims[4] : (sidecar?.dwellTime ?? 0)
    return {
      kind: 'spectroscopy',
      fid,
      nPoints,
      nTransients,
      dwell,
      spectrometerFreq: sidecar?.spectrometerFrequency ?? null,
      nucleus: sidecar?.resonantNucleus ?? '1H',
    }
  }

  // Real, non-spatial NIfTI -> physio. Apply the header intensity scaling
  // (scl_slope/scl_inter) the same way volumes do, since toTypedViewOrU8
  // returns raw, unscaled values.
  const nSamples = dims[4] > 1 ? dims[4] : 1
  const nCols = product(dims, 5, 7)
  const flat = toTypedViewOrU8(img, hdr.datatypeCode)
  const slope = hdr.scl_slope !== 0 ? hdr.scl_slope : 1
  const inter = hdr.scl_inter
  const columns: Float32Array[] = []
  for (let c = 0; c < nCols; c++) {
    const col = new Float32Array(nSamples)
    for (let s = 0; s < nSamples; s++) {
      const idx = s + c * nSamples
      col[s] = idx < flat.length ? flat[idx] * slope + inter : Number.NaN
    }
    columns.push(col)
  }
  const fsFromHdr = pixDims[4] > 0 ? 1 / pixDims[4] : null
  return {
    kind: 'physio',
    columns,
    columnLabels: sidecar?.columns ?? columns.map((_, i) => `column ${i}`),
    samplingFrequency: sidecar?.samplingFrequency ?? fsFromHdr,
    startTime: sidecar?.startTime ?? 0,
  }
}
