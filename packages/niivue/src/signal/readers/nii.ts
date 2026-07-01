import * as nifti from 'nifti-reader-js'
import { log } from '@/logger'
import type { NVSignalRaw, SignalSidecar } from '@/NVTypes'
import { temporalUnitScale, toTypedViewOrU8 } from '@/volume/utils'
import {
  decodeComplexFID,
  dimProduct,
  isComplexDatatype,
  mrsFromHeaderExtensions,
} from '../mrs'

export const extensions = ['nii', 'nii.gz']
export const type = 'nii'

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
  const isSpatial = !(dims[1] === 1 && dims[2] === 1 && dims[3] === 1)

  if (isComplexDatatype(hdr.datatypeCode)) {
    // Spatial+spectral spectroscopy (MRSI/CSI) cannot be represented by the 1-D
    // signal model; the loader keeps such files on the volume path, so reaching
    // here (e.g. a forced asSignal) is an explicit, unsupported case.
    if (isSpatial) {
      throw new Error(
        'NIfTI-MRS with spatial extent (MRSI/CSI) is not supported as a signal',
      )
    }
    // Metadata: sidecar wins, else the NIfTI-MRS header extension; the
    // spectrometer frequency falls back to ImagingFrequency for the ppm axis.
    const meta: SignalSidecar = {
      ...mrsFromHeaderExtensions(hdr),
      ...(sidecar ?? {}),
    }
    const fid = decodeComplexFID(img, hdr.datatypeCode)
    // Clamp the declared geometry to what the data actually holds so the
    // transform never indexes past the end (truncated/corrupt files).
    const available = Math.floor(fid.length / 2)
    let nPoints = dims[4] > 1 ? dims[4] : 1
    let nTransients = dimProduct(dims, 5, 7)
    if (nPoints * nTransients > available) {
      log.warn(
        `nii signal: declared ${nPoints}x${nTransients} complex samples exceed ${available} available; clamping`,
      )
      nPoints = Math.min(nPoints, available)
      nTransients = nPoints > 0 ? Math.floor(available / nPoints) : 0
    }
    // Dwell time in SECONDS. The sidecar DwellTime wins (sidecar-first, matching
    // spectrometerFreq/nucleus resolution): a rounded, generic, or unit-
    // misdeclared header pixdim would otherwise silently skew the ppm/Hz axis.
    // The header pixDims[4] fallback is in the header's temporal units, so scale
    // it to seconds via xyzt_units (mirrors volumeTR / the physio path).
    const headerDwell =
      pixDims[4] > 0 ? pixDims[4] * temporalUnitScale(hdr.xyzt_units) : 0
    const dwell =
      meta.dwellTime && meta.dwellTime > 0 ? meta.dwellTime : headerDwell
    return {
      kind: 'spectroscopy',
      fid,
      nPoints,
      nTransients,
      dwell,
      spectrometerFreq:
        meta.spectrometerFrequency ?? meta.imagingFrequency ?? null,
      nucleus: meta.resonantNucleus ?? '1H',
    }
  }

  // Real, non-spatial NIfTI -> physio. Apply the header intensity scaling
  // (scl_slope/scl_inter) the same way volumes do, since toTypedViewOrU8
  // returns raw, unscaled values.
  const nSamples = dims[4] > 1 ? dims[4] : 1
  const nCols = dimProduct(dims, 5, 7)
  const flat = toTypedViewOrU8(img, hdr.datatypeCode)
  const slope =
    Number.isFinite(hdr.scl_slope) && hdr.scl_slope !== 0 ? hdr.scl_slope : 1
  const inter = Number.isFinite(hdr.scl_inter) ? hdr.scl_inter : 0
  const columns: Float32Array[] = []
  for (let c = 0; c < nCols; c++) {
    const col = new Float32Array(nSamples)
    for (let s = 0; s < nSamples; s++) {
      const idx = s + c * nSamples
      col[s] = idx < flat.length ? flat[idx] * slope + inter : Number.NaN
    }
    columns.push(col)
  }
  // Sampling period in seconds = pixDims[4] scaled by the temporal unit, so
  // ms/us headers give the right rate (mirrors volumeTR for volumes).
  const dt = pixDims[4] * temporalUnitScale(hdr.xyzt_units)
  const fsFromHdr = dt > 0 ? 1 / dt : null
  return {
    kind: 'physio',
    columns,
    columnLabels: sidecar?.columns ?? columns.map((_, i) => `column ${i}`),
    samplingFrequency: sidecar?.samplingFrequency ?? fsFromHdr,
    startTime: sidecar?.startTime ?? 0,
  }
}
