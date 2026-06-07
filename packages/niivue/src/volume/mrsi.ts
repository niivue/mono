import { NiiDataType } from '@/NVConstants'
import type {
  MrsVolumeMeta,
  NIFTI1,
  NIFTI2,
  NVImage,
  TypedVoxelArray,
} from '@/NVTypes'
import {
  decodeComplexFID,
  isComplexDatatype,
  mrsFromHeaderExtensions,
  mrsGeometry,
} from '@/signal/mrs'
import { integratePpmBandMap, PPM_RANGE } from '@/signal/processing'
import { hasMrsFields } from '@/signal/sidecar'

/** Read MRS metadata from a NIfTI header's ecode-44 extension (cast-safe). */
function headerMrsMeta(
  hdr: NIFTI1 | NIFTI2,
): ReturnType<typeof mrsFromHeaderExtensions> {
  // The runtime header (from nifti.readHeader) carries `extensions`, but the
  // NVTypes NIFTIHeader alias does not declare them; cast for the ecode-44 read.
  return mrsFromHeaderExtensions(
    hdr as unknown as {
      extensions?: Array<{ ecode: number; edata: ArrayBuffer }>
    },
  )
}

/**
 * Spatial spectroscopic imaging (MRSI/CSI) support on the volume path.
 *
 * An MRSI NIfTI is complex AND spatial AND spectral (dim1-3 encode space, dim4
 * is the FID). It stays on the volume path (it IS a volume), but the complex
 * data cannot be shown directly, so {@link prepareMrsiVolume} derives a scalar
 * "total signal" map for display while retaining the raw complex FID + spectral
 * metadata on the NVImage for per-voxel spectrum extraction (see NVModel).
 */

/**
 * True when a NIfTI header describes a spatial complex spectroscopic image:
 * complex datatype, spatial extent (dim1-3 not all 1), spectral dim4 > 1, AND
 * genuine NIfTI-MRS metadata (ecode-44 `SpectrometerFrequency`/`ResonantNucleus`).
 *
 * The MRS-metadata gate is essential: without it any spatial complex 4-D NIfTI
 * (e.g. complex/phase fMRI) would be silently rewritten into a scalar map,
 * discarding its 4-D semantics. On the volume path only the ecode-44 header is
 * available (no sidecar fetch), so sidecar-only MRSI without ecode-44 is not
 * auto-detected — acceptable since spec2nii writes the header extension.
 */
export function isMrsiVolume(hdr: NIFTI1 | NIFTI2): boolean {
  if (!isComplexDatatype(hdr.datatypeCode)) return false
  const d = hdr.dims
  const spatial = !(d[1] === 1 && d[2] === 1 && d[3] === 1)
  if (!spatial || d[4] <= 1) return false
  return hasMrsFields(headerMrsMeta(hdr))
}

export type PreparedMrsiVolume = {
  /** new header: real float32, single 3D frame (the derived scalar map) */
  hdr: NIFTI1 | NIFTI2
  /** derived scalar map, native voxel order, length nVox3D */
  img: Float32Array
  /** raw complex FID, interleaved re/im, native order */
  complexFID: Float32Array
  mrsMeta: MrsVolumeMeta
}

/**
 * Decode a complex MRSI NIfTI into (a) a derived scalar display map — the
 * integral of `|spectrum|` over the nucleus' default ppm range, à la the
 * fsleyes range tool's "total signal" — and (b) the retained raw complex FID
 * plus spectral metadata. The returned header is real float32 and single-frame
 * so the rest of `nii2volume` (RAS transforms, GPU upload) treats it as an
 * ordinary scalar volume.
 */
export function prepareMrsiVolume(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
): PreparedMrsiVolume {
  const buffer =
    img instanceof ArrayBuffer
      ? img
      : (img.buffer.slice(
          img.byteOffset,
          img.byteOffset + img.byteLength,
        ) as ArrayBuffer)
  const complexFID = decodeComplexFID(buffer, hdr.datatypeCode)
  const meta = headerMrsMeta(hdr)
  const d = hdr.dims
  const nVox3D = Math.max(d[1], 1) * Math.max(d[2], 1) * Math.max(d[3], 1)
  let { nPoints, nTransients } = mrsGeometry(d)
  // Clamp the declared geometry to the samples actually present so a truncated
  // file cannot drive out-of-range reads (-> NaN) in integratePpmBandMap.
  // Mirrors the hardening in the SVS signal reader (readers/nii.ts).
  const available = Math.floor(complexFID.length / 2)
  if (nVox3D * nPoints * nTransients > available) {
    const perFrame = nVox3D * nPoints
    nTransients =
      perFrame > 0 ? Math.max(1, Math.floor(available / perFrame)) : 1
  }
  const dwell = hdr.pixDims[4] > 0 ? hdr.pixDims[4] : (meta.dwellTime ?? 0)
  const spectrometerFreq =
    meta.spectrometerFrequency ?? meta.imagingFrequency ?? null
  const nucleus = meta.resonantNucleus ?? '1H'
  const band = PPM_RANGE[nucleus] ?? PPM_RANGE['1H']
  // Derived display map: total signal over the nucleus' default ppm range.
  // halveFirstPoint matches FSL-MRS calcSpectrum; the band integral is a
  // smooth, mask-friendly scalar that mirrors the fsleyes grid display.
  const map = integratePpmBandMap(
    complexFID,
    nVox3D,
    nPoints,
    nTransients,
    dwell,
    spectrometerFreq,
    nucleus,
    band,
    { mode: 'magnitude', halveFirstPoint: true },
  )
  const newHdr = scalarHeaderLike(hdr)
  return {
    hdr: newHdr,
    img: map,
    complexFID,
    mrsMeta: { spectrometerFreq, nucleus, dwell, nPoints, nTransients },
  }
}

/**
 * Clone a NIfTI header as a single-frame real float32 scalar header, preserving
 * spatial dims/affine/pixdims. Used for the derived MRSI display map and for
 * range-integration metabolite maps built by nv-ext-mrs.
 */
function scalarHeaderLike(hdr: NIFTI1 | NIFTI2): NIFTI1 | NIFTI2 {
  const newHdr = {
    ...hdr,
    dims: [...hdr.dims],
    pixDims: [...hdr.pixDims],
    affine: hdr.affine.map((row) => [...row]),
  } as NIFTI1 | NIFTI2
  newHdr.datatypeCode = NiiDataType.DT_FLOAT32
  newHdr.numBitsPerVoxel = 32
  newHdr.dims[0] = 3
  for (let i = 4; i <= 7; i++) newHdr.dims[i] = 1
  newHdr.scl_slope = 1
  newHdr.scl_inter = 0
  return newHdr
}

/**
 * Build a derived scalar overlay NVImage that shares an MRSI volume's spatial
 * grid/affine. `data` must be in native voxel order, length nVox3D. Used by
 * nv-ext-mrs to add a metabolite map produced by {@link integratePpmBandMap}.
 *
 * `nii2volume` is passed in by the caller to avoid an import cycle
 * (NVVolume imports this module).
 */
export function buildDerivedScalarVolume(
  source: NVImage,
  data: Float32Array,
  name: string,
  nii2volume: (
    hdr: NIFTI1 | NIFTI2,
    img: ArrayBuffer | TypedVoxelArray,
    name?: string,
  ) => NVImage,
): NVImage {
  return nii2volume(scalarHeaderLike(source.hdr), data, name)
}
