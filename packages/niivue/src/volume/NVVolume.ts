import * as nifti from 'nifti-reader-js'
import { readFirstDecompressedBytes } from '@/codecs/NVGzStream'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import { NiiDataType, NiiIntentCode } from '@/NVConstants'
import * as NVLoader from '@/NVLoader'
import type {
  MrsVolumeMeta,
  NIFTI1,
  NIFTI2,
  NVImage,
  TypedVoxelArray,
} from '@/NVTypes'
import { isMrsiVolume, prepareMrsiVolume } from './mrsi'
import {
  calculateWorldExtents,
  calMinMax,
  ensureValidNonZero,
  toTypedViewOrU8,
} from './utils'

// Re-export utilities for external use
export { calculateWorldExtents, calMinMax }

// Writer support
import * as volumeWriters from './writers'
import { writeVolume } from './writers'
export function volumeWriteExtensions(): string[] {
  return volumeWriters.writeExtensions()
}
export { writeVolume }

type VolumeReader = {
  extensions?: string[]
  read: (
    buffer: ArrayBuffer,
    name?: string,
    pairedImgData?: ArrayBuffer | null,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }>
}

const modules = import.meta.glob<VolumeReader>(
  ['./readers/*.ts', '!./readers/*.test.ts'],
  {
    eager: true,
  },
)
const readerByExt = NVLoader.buildExtensionMap(modules)
export const builtinReaderExts = new Set(readerByExt.keys())
export function hasReader(ext: string): boolean {
  return readerByExt.has(ext)
}

export function volumeExtensions(): string[] {
  return Array.from(readerByExt.keys()).sort()
}

export function registerExternalReader(
  fromExt: string,
  toExt: string,
  converter: (
    buffer: ArrayBuffer,
  ) => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>,
): void {
  const targetReader = readerByExt.get(toExt.toUpperCase())
  if (!targetReader) {
    throw new Error(`No built-in volume reader for target format "${toExt}"`)
  }
  const wrappedReader: VolumeReader = {
    extensions: [fromExt.toUpperCase()],
    read: async (buffer, name, pairedImgData) => {
      const converted = await converter(buffer)
      const ab =
        converted instanceof ArrayBuffer
          ? converted
          : (new Uint8Array(converted).buffer as ArrayBuffer)
      return targetReader.read(ab, name, pairedImgData)
    },
  }
  readerByExt.set(fromExt.toUpperCase(), wrappedReader)
}

/**
 * Largest 4D image we attempt to hold in a single ArrayBuffer. V8/Chrome caps a
 * single ArrayBuffer at ~2 GiB (2^31-1); we stay safely below so the decompressed
 * image plus its typed view and headroom always allocate. A 4D volume bigger than
 * this can only be opened partially — as many frames as fit.
 */
const MAX_VOLUME_BYTES = 1_900_000_000 // ~1.77 GiB

/** Max whole 4D frames that fit under {@link MAX_VOLUME_BYTES}, clamped to nTotal. */
function maxFramesUnderCap(
  voxOffset: number,
  nVox3D: number,
  bpv: number,
  nTotal: number,
): number {
  const perFrame = nVox3D * bpv
  if (perFrame <= 0) return nTotal
  const fit = Math.floor((MAX_VOLUME_BYTES - voxOffset) / perFrame)
  return Math.max(1, Math.min(fit, nTotal))
}

/** Get a fresh gzip byte stream for a URL or File (re-callable for each pass). */
async function gzByteStream(
  src: string | File,
): Promise<ReadableStream<Uint8Array> | null> {
  if (typeof src === 'string') {
    const r = await fetch(src, { cache: 'force-cache' })
    return r.ok ? r.body : null
  }
  return src.stream()
}

/**
 * Fast path for `limitFrames4D` on a gzip-compressed NIfTI-1: stream-inflate only
 * the header and the first N frames, instead of decompressing the whole file.
 * This is the only way to open a 4D volume whose full extent exceeds V8's ~2 GiB
 * ArrayBuffer cap (e.g. a 344x344x127x45 float32 PET = 2.5 GiB). The ORIGINAL
 * header is preserved (its dims still describe the full extent), so `nii2volume`
 * truncates cleanly and still reports "N of total" frames.
 *
 * Returns `{ hdr, img }` (img = the first N frames, starting at vox_offset) or
 * `null` to fall back to the normal full load — for any miss: uncompressed input,
 * NIfTI-2 or byte-swapped header, all frames requested (the native
 * DecompressionStream is faster for a full read), or any decode error.
 */
async function loadPartialNiftiGz(
  src: string | File,
  limitFrames4D: number,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer } | null> {
  // `Infinity` is allowed: it means "as many frames as fit under the cap" (the
  // >2 GiB fallback path). NaN / < 1 are rejected.
  if (!(limitFrames4D >= 1)) return null
  try {
    // 1) Header: inflate just enough to parse the NIfTI-1 header (348 B + any
    //    extensions, which end at vox_offset).
    const headStream = await gzByteStream(src)
    if (!headStream) return null
    let head = await readFirstDecompressedBytes(headStream, 352)
    if (head.length < 348) return null
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
    // Only NIfTI-1 little-endian (sizeof_hdr == 348); NIfTI-2 / byte-swapped
    // headers fall back to the full load.
    if (dv.getInt32(0, true) !== 348) return null
    // vox_offset (float32 @ byte 108) marks where image data starts; if a header
    // extension pushes it past the first read, inflate more.
    const voxOffset = dv.getFloat32(108, true)
    if (voxOffset > head.length) {
      const moreStream = await gzByteStream(src)
      if (!moreStream) return null
      head = await readFirstDecompressedBytes(moreStream, voxOffset)
      if (head.length < voxOffset) return null
    }
    const hdr = nifti.readHeader(head.buffer as ArrayBuffer) as NIFTI1 | NIFTI2
    if (!hdr) return null
    // 2) Frame budget. dims 4-6 give the total 4D frame count.
    const dims = hdr.dims
    const dim = (i: number): number => (dims[i] > 1 ? dims[i] : 1)
    const nVox3D = dim(1) * dim(2) * dim(3)
    const nTotal = dim(4) * dim(5) * dim(6)
    const bpv = hdr.numBitsPerVoxel / 8
    const requested = Math.max(1, Math.min(Math.floor(limitFrames4D), nTotal))
    // Never exceed the ArrayBuffer cap, even when the caller asked for more (or
    // for everything, via Infinity from the >2 GiB fallback path).
    const safeFrames = maxFramesUnderCap(hdr.vox_offset, nVox3D, bpv, nTotal)
    const nFrames = Math.min(requested, safeFrames)
    // Want every frame and it all fits -> let the native full path handle it.
    if (nFrames >= nTotal) return null
    if (safeFrames < requested) {
      // The ~2 GiB ArrayBuffer cap (not the caller) limited the load. That is
      // data loss the user must always see, so bypass the level-gated logger.
      const fullGiB = (
        (hdr.vox_offset + nTotal * nVox3D * bpv) /
        2 ** 30
      ).toFixed(2)
      console.warn(
        `NiiVue: 4D volume too large to load fully — ${fullGiB} GiB exceeds the browser's ~2 GiB ArrayBuffer limit. Loaded ${nFrames} of ${nTotal} frames.`,
      )
    }
    const bytesToLoad = hdr.vox_offset + nFrames * nVox3D * bpv
    // 3) Inflate header + N frames only, then slice out the image data.
    const dataStream = await gzByteStream(src)
    if (!dataStream) return null
    const data = await readFirstDecompressedBytes(dataStream, bytesToLoad)
    if (data.length < bytesToLoad) return null // unexpectedly short -> fall back
    const img = data.buffer.slice(
      data.byteOffset + hdr.vox_offset,
      data.byteOffset + bytesToLoad,
    ) as ArrayBuffer
    log.debug(
      `4D partial load: ${nFrames}/${nTotal} frames (~${Math.round(bytesToLoad / 1e6)} MB inflated, not the full volume)`,
    )
    return { hdr, img }
  } catch (e) {
    log.warn('4D partial load failed; falling back to full load', e)
    return null
  }
}

export async function loadVolume(
  url: string | File,
  pairedImgData: string | File | null = null,
  limitFrames4D = Infinity,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const ext = NVLoader.getFileExt(url)
  // Partial fast path: a gzip 4D NIfTI where only some frames are wanted. Avoids
  // inflating (and allocating) the whole volume; misses fall through to the full
  // load below. getFileExt strips `.gz` (nii.gz -> "NII"), so detect the gzip via
  // the `.gz` filename suffix.
  const srcName = (typeof url === 'string' ? url : url.name)
    .split('?')[0]
    .toLowerCase()
  const isGzNifti = ext === 'NII' && srcName.endsWith('.gz')
  if (isGzNifti && Number.isFinite(limitFrames4D)) {
    const partial = await loadPartialNiftiGz(url, limitFrames4D)
    if (partial) return partial
  }
  try {
    const result = await NVLoader.fetchFile(url)
    const pairedBuffer = pairedImgData
      ? await NVLoader.fetchFile(pairedImgData)
      : null
    const name = NVLoader.getName(url)
    let reader = readerByExt.get(ext)
    if (!reader || typeof reader.read !== 'function') {
      log.warn(
        `Unsupported volume format "${ext}", falling back to NIfTI reader`,
      )
      reader = readerByExt.get('NII')
    }
    if (!reader) {
      throw new Error(`No volume reader available for extension ${ext}`)
    }
    return await reader.read(result, name, pairedBuffer)
  } catch (e) {
    // Decompressing a whole 4D volume can exceed V8's ~2 GiB ArrayBuffer cap
    // (RangeError: "Array buffer allocation failed"). Even without limitFrames4D
    // (or on the graph "load deferred frames" re-fetch), retry loading as many
    // frames as fit — loadPartialNiftiGz caps and emits the always-visible
    // warning. Other errors propagate.
    if (isGzNifti && e instanceof RangeError) {
      const capped = await loadPartialNiftiGz(url, Infinity)
      if (capped) return capped
    }
    throw e
  }
}

/**
 * Convert a float32 RGB vector volume (intent_code 2003, dim4=3) to RGBA8.
 * Each voxel's 3 float32 components (across frames) become |x|→R, |y|→G, |z|→B.
 * Alpha is 255 (fully opaque) if any component is non-zero, 0 otherwise.
 */
export function convertFloat32RGBVector(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
): { hdr: NIFTI1 | NIFTI2; img: Uint8Array } {
  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  const slope = hdr.scl_slope
  const inter = hdr.scl_inter
  let f32: Float32Array
  if (img instanceof ArrayBuffer) {
    f32 = new Float32Array(img)
  } else if (img instanceof Float32Array) {
    f32 = img
  } else {
    f32 = new Float32Array(img.buffer, img.byteOffset, img.byteLength / 4)
  }
  // Apply slope/intercept and find max magnitude (skip NaN from tensor tools)
  const calibrated = new Float32Array(nVox3D * 3)
  let mx = 1.0
  for (let i = 0; i < nVox3D * 3; i++) {
    const v = f32[i] * slope + inter
    calibrated[i] = Number.isNaN(v) ? 0 : v
    mx = Math.max(mx, Math.abs(calibrated[i]))
  }
  const colorSlope = 255 / mx
  const rgba = new Uint8Array(nVox3D * 4)
  const nVox3D2 = nVox3D * 2
  // RGB = absolute magnitude scaled to 0-255
  // Alpha encodes sign polarity in 3 least-significant bits:
  //   bit 0 (1) = x positive, bit 1 (2) = y positive, bit 2 (4) = z positive
  //   alpha = 248 + xPos + yPos + zPos (or 0 if near-zero magnitude)
  for (let i = 0; i < nVox3D; i++) {
    const x = calibrated[i]
    const y = calibrated[i + nVox3D]
    const z = calibrated[i + nVox3D2]
    const j = i * 4
    rgba[j] = Math.abs(x * colorSlope)
    rgba[j + 1] = Math.abs(y * colorSlope)
    rgba[j + 2] = Math.abs(z * colorSlope)
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.1) {
      rgba[j + 3] = 0
    } else {
      const xPos = x > 0 ? 1 : 0
      const yPos = y > 0 ? 2 : 0
      const zPos = z > 0 ? 4 : 0
      rgba[j + 3] = 248 + xPos + yPos + zPos
    }
  }
  const newHdr = {
    ...hdr,
    dims: [...hdr.dims],
    affine: hdr.affine.map((row) => [...row]),
  }
  newHdr.datatypeCode = NiiDataType.DT_RGBA32
  newHdr.numBitsPerVoxel = 32
  newHdr.dims[0] = 3
  newHdr.dims[4] = 1
  newHdr.scl_slope = 1.0
  newHdr.scl_inter = 0.0
  log.info(
    `Converted RGB vector (intent 2003, dim4=3) to RGBA8 with sign-encoded alpha`,
  )
  return { hdr: newHdr, img: rgba }
}

/**
 * Convert a Float64 volume to Float32. GPU textures top out at 32-bit floats
 * on both WebGPU and WebGL2, and f32 precision is sufficient for visualization.
 */
function convertFloat64ToFloat32(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
): { hdr: NIFTI1 | NIFTI2; img: Float32Array } {
  const src =
    img instanceof Float64Array
      ? img
      : img instanceof ArrayBuffer
        ? new Float64Array(img)
        : new Float64Array(img.buffer, img.byteOffset, img.byteLength / 8)
  const dst = Float32Array.from(src)
  const newHdr = {
    ...hdr,
    dims: [...hdr.dims],
    affine: hdr.affine.map((row) => [...row]),
  }
  newHdr.datatypeCode = NiiDataType.DT_FLOAT32
  newHdr.numBitsPerVoxel = 32
  log.info('Converted DT_FLOAT64 volume to DT_FLOAT32 for GPU upload')
  return { hdr: newHdr, img: dst }
}

export function nii2volume(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
  name = '',
  limitFrames4D = Infinity,
): NVImage {
  // Convert float32 RGB vector volumes (intent_code 2003, dim4=3) to RGBA8
  if (
    hdr.intent_code === NiiIntentCode.NIFTI_INTENT_RGB_VECTOR &&
    hdr.dims[4] === 3 &&
    hdr.datatypeCode === NiiDataType.DT_FLOAT32
  ) {
    const converted = convertFloat32RGBVector(hdr, img)
    hdr = converted.hdr
    img = converted.img
  }
  if (hdr.datatypeCode === NiiDataType.DT_FLOAT64) {
    const converted = convertFloat64ToFloat32(hdr, img)
    hdr = converted.hdr
    img = converted.img
  }
  // Spatial complex spectroscopic imaging (MRSI/CSI): replace the complex data
  // with a derived scalar display map and retain the raw FID + spectral
  // metadata to attach to the NVImage after construction.
  let mrsiExtra: { complexFID: Float32Array; mrsMeta: MrsVolumeMeta } | null =
    null
  if (isMrsiVolume(hdr)) {
    const prepped = prepareMrsiVolume(hdr, img)
    hdr = prepped.hdr
    img = prepped.img
    mrsiExtra = { complexFID: prepped.complexFID, mrsMeta: prepped.mrsMeta }
  }
  const { extentsMin, extentsMax } = calculateWorldExtents(
    hdr.dims.slice(1, 4),
    new Float32Array(hdr.affine.flat()),
  )
  if (!Number.isFinite(hdr.scl_inter)) {
    hdr.scl_inter = 0.0
  }
  if (!Number.isFinite(hdr.scl_slope) || hdr.scl_slope === 0.0) {
    hdr.scl_slope = 1.0
  }
  for (let i = 1; i < 4; i++) {
    hdr.dims[i] = Math.max(hdr.dims[i], 1)
    hdr.pixDims[i] = ensureValidNonZero(hdr.pixDims[i])
  }
  // Compute total 4D frames from header (handles 5D/6D by multiplying dims 4-6)
  const nTotalFrame4D = [4, 5, 6].reduce(
    (acc, i) => acc * (hdr.dims[i] > 1 ? hdr.dims[i] : 1),
    1,
  )
  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  // Frames actually present in `img` — may be fewer than the header total when
  // the loader capped a >2 GiB volume to as many frames as fit (the supplied img
  // already holds only those). Clamp so nFrame4D never claims more than the data.
  const framesInImg = Math.max(
    1,
    Math.floor(img.byteLength / (nVox3D * (hdr.numBitsPerVoxel / 8))),
  )
  // Apply limitFrames4D: truncate img data if fewer frames requested.
  const nFrame4D = Math.min(
    Number.isFinite(limitFrames4D) ? Math.max(1, limitFrames4D) : nTotalFrame4D,
    framesInImg,
    nTotalFrame4D,
  )
  let truncatedImg = img
  if (nFrame4D < nTotalFrame4D) {
    const bytesPerVoxel = hdr.numBitsPerVoxel / 8
    const keepBytes = nVox3D * nFrame4D * bytesPerVoxel
    if (img instanceof ArrayBuffer) {
      truncatedImg = img.slice(0, keepBytes)
    } else {
      const keepElements = nVox3D * nFrame4D
      truncatedImg = img.slice(0, keepElements)
    }
    log.debug(
      `4D: loaded ${nFrame4D} of ${nTotalFrame4D} frames (limitFrames4D=${limitFrames4D})`,
    )
  }
  const [pct2, pct98, mnScale, mxScale] = calMinMax(hdr, truncatedImg)
  const typedImg = toTypedViewOrU8(truncatedImg, hdr.datatypeCode)
  const volume: NVImage = {
    img: typedImg,
    hdr: hdr,
    originalAffine: hdr.affine.map((row) => [...row]),
    dims: hdr.dims.slice(0, 4),
    nVox3D: nVox3D,
    extentsMin: extentsMin,
    extentsMax: extentsMax,
    name: name,
    id: name,
    calMin: pct2,
    calMax: pct98,
    robustMin: pct2,
    robustMax: pct98,
    globalMin: mnScale,
    globalMax: mxScale,
    frame4D: 0,
    nFrame4D: nFrame4D,
    nTotalFrame4D: nTotalFrame4D,
    isLegendVisible: false,
  }
  const v1 = (hdr as unknown as { v1?: Float32Array }).v1
  if (v1) {
    volume.v1 = v1
  }
  if (mrsiExtra) {
    volume.complexFID = mrsiExtra.complexFID
    volume.mrsMeta = mrsiExtra.mrsMeta
    // NB: do NOT set `isImaginary` — the displayed `img` is the derived REAL
    // scalar map (the complex data lives in `complexFID`). Setting it would make
    // locationTracking append a bogus "imaginary" component to the readout.
  }
  NVTransforms.calculateRAS(volume)
  if (!volume.pixDimsRAS || !volume.dimsRAS) {
    throw new Error('calculateRAS failed to set pixDimsRAS/dimsRAS')
  }
  const dimsMM = [
    volume.pixDimsRAS[1] * volume.dimsRAS[1],
    volume.pixDimsRAS[2] * volume.dimsRAS[2],
    volume.pixDimsRAS[3] * volume.dimsRAS[3],
  ]
  const longestAxis = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const volScale = [
    dimsMM[0] / longestAxis,
    dimsMM[1] / longestAxis,
    dimsMM[2] / longestAxis,
  ]
  volume.volScale = volScale
  return volume
}
