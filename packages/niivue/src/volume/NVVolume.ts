import * as nifti from 'nifti-reader-js'
import { readFirstBytes, readWindow } from '@/codecs/NVGzStream'
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
  framesInImage,
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
/**
 * Maximum acceptable `vox_offset` (header + extensions) for the partial-load path.
 * Bounds the header allocation against a malformed file advertising a huge
 * vox_offset, while staying generous enough not to reject a valid file with a large
 * NIfTI-1 extension (e.g. embedded DICOM/XML, which can run to a few MB). 16 MiB is
 * far above any real extension yet far below the image budget.
 */
const MAX_HEADER_BYTES = 16 * 1024 * 1024 // 16 MiB

/**
 * Max whole 4D frames that fit under {@link MAX_VOLUME_BYTES}, clamped to nTotal.
 * Returns 0 when not even one frame fits (e.g. a pathological header extension
 * whose vox_offset alone exceeds the cap) — the caller then declines the partial
 * path rather than loading a single frame that still blows the buffer.
 */
function maxFramesUnderCap(
  voxOffset: number,
  nVox3D: number,
  bpv: number,
  nTotal: number,
): number {
  const perFrame = nVox3D * bpv
  if (perFrame <= 0) return nTotal
  const fit = Math.floor((MAX_VOLUME_BYTES - voxOffset) / perFrame)
  return Math.max(0, Math.min(fit, nTotal))
}

/** Native gzip streaming is the engine of the gz partial path. Every modern browser
 * (and Bun/Node 18+) has it; feature-detect so a missing API degrades gracefully
 * (return null -> fall back to full load) instead of a ReferenceError. */
const HAS_DECOMPRESSION_STREAM = typeof DecompressionStream !== 'undefined'

/**
 * Fresh DECOMPRESSED (gunzipped) byte stream for a URL or File, re-callable for
 * each pass. Uses the browser-native `DecompressionStream`; decode errors surface
 * when the stream is read (so a non-gzip input lands in the caller's catch).
 * Returns null when `DecompressionStream` is unavailable.
 */
async function gunzipStream(
  src: string | File,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!HAS_DECOMPRESSION_STREAM) return null
  let raw: ReadableStream<Uint8Array> | null
  if (typeof src === 'string') {
    // `force-cache`: loadPartialNiftiGz may call this up to 3x for one URL (header,
    // a header-extension re-read, then the frame data) and needs byte-identical
    // responses each time; serving from cache guarantees that and avoids
    // re-downloading the leading bytes. Trade-off: a server-side change won't be
    // revalidated until the cache entry expires (acceptable for immutable volumes).
    const r = await fetch(src, { cache: 'force-cache' })
    raw = r.ok ? r.body : null
  } else {
    raw = src.stream()
  }
  // DecompressionStream's writable is typed `BufferSource` (wider than the
  // source's `Uint8Array`), which trips pipeThrough's invariant type check; the
  // cast is sound (we only ever write Uint8Array chunks).
  return raw
    ? raw.pipeThrough(
        new DecompressionStream('gzip') as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      )
    : null
}

/**
 * Byte source for a partial NIfTI-1 read. `readHeader` returns the first `minBytes`
 * decompressed bytes (header parse); `readImage` returns EXACTLY the window
 * `[start, start + length)` (the image data after vox_offset) in a fresh, pre-sized
 * buffer at byteOffset 0 — so the caller never concatenates a whole prefix nor
 * slices the header off afterwards (those were the two big synchronous multi-GB
 * copies that froze the main thread). Either returns `null` if the source can't
 * supply the requested bytes.
 */
type PartialSource = {
  readHeader: (minBytes: number) => Promise<Uint8Array | null>
  readImage: (start: number, length: number) => Promise<Uint8Array | null>
}

/**
 * Shared core for opening only the header + first N frames of a NIfTI-1, reading
 * bytes via a {@link PartialSource}. This is the only way to open a 4D volume whose
 * full extent exceeds V8's ~2 GiB ArrayBuffer cap (e.g. a 344x344x127x45 float32 PET
 * = 2.5 GiB). The ORIGINAL header is preserved (its dims still describe the full
 * extent), so `nii2volume` truncates cleanly and still reports "N of total" frames.
 *
 * Returns `{ hdr, img }` (img = the first N frames, starting at vox_offset) or
 * `null` to fall back to the normal full load — for any miss: NIfTI-2 or
 * byte-swapped header, all frames requested (a one-shot whole-file read is faster
 * than slicing for a complete read), or any read/decode error.
 */
async function loadPartialNifti1(
  source: PartialSource,
  limitFrames4D: number,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer } | null> {
  // `Infinity` is allowed: it means "as many frames as fit under the cap" (the
  // >2 GiB fallback path). NaN / < 1 are rejected.
  if (!(limitFrames4D >= 1)) return null
  try {
    // 1) Header: read just enough to parse the NIfTI-1 header (348 B + any
    //    extensions, which end at vox_offset).
    let head = await source.readHeader(352)
    if (!head || head.length < 348) return null
    // `readHeader` returns a fresh, exactly-sized buffer at byteOffset 0, so
    // `head.buffer` IS the header bytes — both this DataView and the
    // `nifti.readHeader(head.buffer)` below (which reads from byte 0) rely on that.
    const dv = new DataView(head.buffer)
    // Only NIfTI-1 little-endian (sizeof_hdr == 348); NIfTI-2 / byte-swapped
    // headers fall back to the full load.
    if (dv.getInt32(0, true) !== 348) return null
    // vox_offset (float32 @ byte 108) marks where image data starts; if a header
    // extension pushes it past the first read, read more. It is an integer byte
    // count stored as float — floor it (and validate below) so a corrupt fractional
    // value can't mis-align the image window or the slice math.
    const voxOffset = Math.floor(dv.getFloat32(108, true))
    // Sanity-check vox_offset BEFORE reading up to it: reject NaN/negative/sub-header
    // values, and oversized extensions — MAX_HEADER_BYTES guards against a malformed
    // file advertising a huge vox_offset that would allocate a large header buffer.
    // (NIfTI-1 extensions are a few KB in practice; 64 KiB is a generous ceiling.)
    if (!(voxOffset >= 348) || voxOffset > MAX_HEADER_BYTES) return null
    if (voxOffset > head.length) {
      head = await source.readHeader(voxOffset)
      if (!head || head.length < voxOffset) return null
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
    const safeFrames = maxFramesUnderCap(voxOffset, nVox3D, bpv, nTotal)
    const nFrames = Math.min(requested, safeFrames)
    // Not even one frame fits under the cap -> can't help; fall back (and let the
    // full load surface the RangeError) rather than load a frame that overflows.
    if (nFrames < 1) return null
    // Want every frame and it all fits -> let the native full path handle it.
    if (nFrames >= nTotal) return null
    if (safeFrames < requested) {
      // The ~2 GiB ArrayBuffer cap (not the caller) limited the load. That is
      // data loss the user must always see, so bypass the level-gated logger.
      const fullGiB = ((voxOffset + nTotal * nVox3D * bpv) / 2 ** 30).toFixed(2)
      console.warn(
        `NiiVue: 4D volume too large to load fully — ${fullGiB} GiB exceeds the browser's ~2 GiB ArrayBuffer limit. Loaded ${nFrames} of ${nTotal} frames.`,
      )
    }
    // 3) Read ONLY the image window [vox_offset, vox_offset + imageBytes) straight
    //    into one pre-sized buffer — no whole-prefix concat, no header-drop slice.
    const imageBytes = nFrames * nVox3D * bpv
    const data = await source.readImage(voxOffset, imageBytes)
    if (!data || data.byteLength < imageBytes) return null // short -> fall back
    log.debug(
      `4D partial load: ${nFrames}/${nTotal} frames (~${Math.round(imageBytes / 1e6)} MB, not the full volume)`,
    )
    return { hdr, img: data.buffer as ArrayBuffer }
  } catch (e) {
    log.warn('4D partial load failed; falling back to full load', e)
    return null
  }
}

/**
 * Partial load for a gzip NIfTI-1: inflate via the native `DecompressionStream`,
 * read incrementally and cancel once enough bytes are in hand (which also aborts
 * the download). A fresh stream per read — gunzip is forward-only, so each read
 * re-inflates from the start (cheap: header reads are tiny; the image read skips the
 * ~352 header bytes and streams the rest straight into the pre-sized buffer).
 */
function loadPartialNiftiGz(
  src: string | File,
  limitFrames4D: number,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer } | null> {
  return loadPartialNifti1(
    {
      readHeader: async (minBytes) => {
        const stream = await gunzipStream(src)
        return stream ? readFirstBytes(stream, minBytes) : null
      },
      readImage: async (start, length) => {
        const stream = await gunzipStream(src)
        return stream ? readWindow(stream, start, length) : null
      },
    },
    limitFrames4D,
  )
}

/**
 * Partial load for an UNCOMPRESSED NIfTI-1 from a local `File`: `Blob.slice` reads
 * any byte range cheaply, so the image window is sliced directly — a >2 GiB file is
 * never read as one ArrayBuffer (which Chrome rejects with `NotReadableError`).
 * File-only — a remote URL would need HTTP range requests, and uncompressed multi-GB
 * volumes are virtually always local; remote callers should gzip or use
 * `limitFrames4D` on a `.nii.gz`.
 */
function loadPartialNiftiFile(
  src: string | File,
  limitFrames4D: number,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer } | null> {
  if (!(src instanceof File)) return Promise.resolve(null)
  return loadPartialNifti1(
    {
      readHeader: async (minBytes) =>
        new Uint8Array(await src.slice(0, minBytes).arrayBuffer()),
      readImage: async (start, length) => {
        const u8 = new Uint8Array(
          await src.slice(start, start + length).arrayBuffer(),
        )
        return u8.byteLength >= length ? u8 : null
      },
    },
    limitFrames4D,
  )
}

export async function loadVolume(
  url: string | File,
  pairedImgData: string | File | null = null,
  limitFrames4D = Infinity,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  // Partial fast path: a 4D NIfTI where only some frames are wanted. Avoids reading
  // (and allocating) the whole volume; misses fall through to the full load below.
  // Strip `?query`/`#fragment` BEFORE deriving the extension: getFileExt doesn't
  // strip them, so `image.nii.gz#v1` would otherwise yield ext "GZ#V1" (not "NII"),
  // making isNifti false and silently skipping the fast path AND the oversize
  // recovery (which gate on the same flag) — erroring out on a >2 GiB volume.
  const srcName = (typeof url === 'string' ? url : url.name)
    .split(/[?#]/)[0]
    .toLowerCase()
  const ext = NVLoader.getFileExt(srcName)
  // getFileExt strips `.gz` (nii.gz -> "NII"), so detect the gzip via the suffix.
  const isNifti = ext === 'NII'
  const isGzNifti = isNifti && srcName.endsWith('.gz')
  // An uncompressed >2 GiB `.nii` can't be read as one ArrayBuffer either (Chrome
  // throws NotReadableError); for a local File we can Blob.slice the prefix. Remote
  // uncompressed URLs have no partial path (would need HTTP range requests).
  const isUncompressedNiftiFile =
    isNifti && !srcName.endsWith('.gz') && url instanceof File
  const partialLoad = isGzNifti
    ? loadPartialNiftiGz
    : isUncompressedNiftiFile
      ? loadPartialNiftiFile
      : null
  if (partialLoad && Number.isFinite(limitFrames4D)) {
    const partial = await partialLoad(url, limitFrames4D)
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
    // A whole 4D volume can exceed V8's ~2 GiB ArrayBuffer cap. A gz volume throws
    // RangeError ("Array buffer allocation failed") while decompressing; an
    // uncompressed >2 GiB File throws NotReadableError when Chrome can't read it as
    // one ArrayBuffer. Either way — even without limitFrames4D, or on the graph
    // "load deferred frames" re-fetch — retry loading as many frames as fit
    // (partialLoad caps and emits the always-visible warning). Others propagate.
    const isOversize =
      e instanceof RangeError ||
      (e instanceof DOMException && e.name === 'NotReadableError')
    if (partialLoad && isOversize) {
      const capped = await partialLoad(url, Infinity)
      if (capped) return capped
      // gz partial load needs DecompressionStream; without it a >2 GiB gz volume
      // can't be opened at all. Surface a specific, always-visible reason rather
      // than the opaque underlying RangeError.
      if (isGzNifti && !HAS_DECOMPRESSION_STREAM) {
        console.warn(
          'NiiVue: cannot open this gzip volume — it exceeds the ~2 GiB ArrayBuffer limit and this runtime lacks DecompressionStream (needed to load it partially). Use a browser with DecompressionStream, or decompress the file.',
        )
      }
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
  const framesInImg = framesInImage(
    img.byteLength,
    nVox3D,
    hdr.numBitsPerVoxel / 8,
  )
  // Apply limitFrames4D: truncate img data if fewer frames requested. Floor the
  // request — a fractional limit (e.g. 1.5) must not leak a non-integer nFrame4D,
  // which would mis-align the truncation byte count and the 4D graph/setFrame4D.
  const nFrame4D = Math.min(
    Number.isFinite(limitFrames4D)
      ? Math.max(1, Math.floor(limitFrames4D))
      : nTotalFrame4D,
    framesInImg,
    nTotalFrame4D,
  )
  let truncatedImg = img
  if (nFrame4D < nTotalFrame4D) {
    const bytesPerVoxel = hdr.numBitsPerVoxel / 8
    const keepBytes = nVox3D * nFrame4D * bytesPerVoxel
    // The partial loader already returns exactly nFrame4D frames, so only copy
    // when img actually holds MORE (a full load capped by a finite limitFrames4D).
    // Skipping the no-op slice avoids a redundant multi-GB copy on the recovery path.
    if (img.byteLength > keepBytes) {
      if (img instanceof ArrayBuffer) {
        truncatedImg = img.slice(0, keepBytes)
      } else {
        const keepElements = nVox3D * nFrame4D
        truncatedImg = img.slice(0, keepElements)
      }
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
