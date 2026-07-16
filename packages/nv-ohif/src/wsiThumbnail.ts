// Build a study-panel preview thumbnail for a DICOM-WSI (SM) series.
//
// OHIF's study browser fills each series thumbnail from `displaySet.thumbnailSrc`
// -> `displaySet.getThumbnailSrc()` -> a cornerstone render of a fallback imageId.
// OHIF's own WSI handler attaches a `getThumbnailSrc` (via the data source); ours
// replaced that handler to route SM into the NiiVue viewport, so without this the
// panel falls through to the cornerstone path, which cannot render our
// unregistered WSI imageIds and leaves the tile blank. This is a self-contained
// replacement: it fetches a small side image from the pyramid over the same
// WADO-RS `/frames` path the tile source uses and returns an image URL.
//
// The side images (OVERVIEW / THUMBNAIL / LABEL) are single-frame. A given store
// may serve a frame either JPEG-encoded or as raw interleaved pixels regardless
// of the instance's advertised transfer syntax (a static WADO store commonly
// returns uncompressed bytes), so this decodes by inspecting the actual bytes:
// an encoded frame becomes a Blob URL directly; raw pixels are painted to a
// canvas and exported.

import { parseMultipartRelated } from './dicomWadoRs'

interface WsiThumbInstance extends Record<string, unknown> {
  imageId?: unknown
  ImageType?: unknown
  NumberOfFrames?: unknown
  Rows?: unknown
  Columns?: unknown
  SamplesPerPixel?: unknown
  PhotometricInterpretation?: unknown
}

function frameCount(inst: WsiThumbInstance): number {
  const n = Number(inst.NumberOfFrames)
  return Number.isFinite(n) && n > 0 ? n : 1
}

// Preview quality by ImageType flavor: an OVERVIEW (whole-slide macro image) or a
// dedicated THUMBNAIL makes the best series preview; a plain side image is next;
// a LABEL (the slide's paper label) is the least useful, so only fall back to it.
function flavorRank(inst: WsiThumbInstance): number {
  const it = typeof inst.ImageType === 'string' ? inst.ImageType : ''
  if (it.includes('OVERVIEW')) return 0
  if (it.includes('THUMBNAIL')) return 1
  if (it.includes('LABEL')) return 3
  return 2
}

/**
 * Choose the best ready-made preview image in the pyramid: prefer an OVERVIEW,
 * then a THUMBNAIL, then any non-LABEL side image, then a LABEL; tie-break on the
 * fewest frames (the side images are single-frame). Only instances with an
 * imageId are eligible. Returns undefined when the series has no usable instance.
 */
export function pickThumbnailInstance(
  instances: ReadonlyArray<Record<string, unknown>>,
): WsiThumbInstance | undefined {
  const eligible = (instances as WsiThumbInstance[]).filter(
    (inst) => typeof inst.imageId === 'string',
  )
  if (eligible.length === 0) return undefined
  return eligible.reduce((best, inst) => {
    const r = flavorRank(inst)
    const rBest = flavorRank(best)
    if (r !== rBest) return r < rBest ? inst : best
    return frameCount(inst) < frameCount(best) ? inst : best
  })
}

/** Encoded-image signature of a frame's bytes, or 'raw' for uncompressed pixels. */
export function frameEncoding(bytes: Uint8Array): 'jpeg' | 'png' | 'raw' {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'png'
  return 'raw'
}

interface RawImageInfo {
  width: number
  height: number
  channels: number
}

/**
 * The dimensions for decoding a raw (uncompressed) frame, when the instance
 * describes an 8-bit RGB or grayscale image whose pixel count matches the byte
 * length. Returns null for anything else (leave those to the encoded path or the
 * panel's default tile) so a mismatched buffer never paints garbage.
 */
export function rawImageInfo(
  inst: WsiThumbInstance,
  byteLength: number,
): RawImageInfo | null {
  const width = Number(inst.Columns)
  const height = Number(inst.Rows)
  const channels = Number(inst.SamplesPerPixel)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (channels !== 1 && channels !== 3) return null
  const photometric =
    typeof inst.PhotometricInterpretation === 'string'
      ? inst.PhotometricInterpretation
      : ''
  // Only interleaved RGB / grayscale are painted directly; a YBR frame would
  // need a color transform we do not do for a thumbnail.
  if (channels === 3 && photometric && !photometric.startsWith('RGB'))
    return null
  if (width * height * channels !== byteLength) return null
  return { width, height, channels }
}

// Cap the exported thumbnail's largest dimension; the panel tile is ~128px, so a
// full macro image (often >1000px) is needless bytes in the object URL.
const MAX_THUMBNAIL_EDGE = 256

// Paint raw interleaved 8-bit RGB / grayscale pixels to a (downscaled) canvas and
// export a data URL. Browser-only (needs a canvas); returns null where the DOM or
// a 2D context is unavailable (e.g. the test runtime), so callers degrade to the
// panel's default tile rather than throw.
function rawFrameToDataUrl(raw: Uint8Array, info: RawImageInfo): string | null {
  if (typeof document === 'undefined') return null
  const { width, height, channels } = info
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const fctx = full.getContext('2d')
  if (!fctx) return null
  const image = fctx.createImageData(width, height)
  const out = image.data
  if (channels === 3) {
    for (let px = 0, s = 0, d = 0; px < width * height; px++) {
      out[d++] = raw[s++] ?? 0
      out[d++] = raw[s++] ?? 0
      out[d++] = raw[s++] ?? 0
      out[d++] = 255
    }
  } else {
    for (let px = 0, d = 0; px < width * height; px++) {
      const v = raw[px] ?? 0
      out[d++] = v
      out[d++] = v
      out[d++] = v
      out[d++] = 255
    }
  }
  fctx.putImageData(image, 0, 0)

  const scale = Math.min(1, MAX_THUMBNAIL_EDGE / Math.max(width, height))
  if (scale === 1) return full.toDataURL('image/png')
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(width * scale))
  small.height = Math.max(1, Math.round(height * scale))
  const sctx = small.getContext('2d')
  if (!sctx) return full.toDataURL('image/png')
  sctx.drawImage(full, 0, 0, small.width, small.height)
  return small.toDataURL('image/jpeg', 0.85)
}

/**
 * Fetch a WSI series' preview image and return an image URL for the study panel
 * (a Blob URL for an encoded frame, a data URL for a decoded raw frame), or null
 * if there is no usable instance or the fetch/decode fails. The caller treats the
 * result as an `<img src>`.
 */
export async function fetchWsiThumbnailObjectUrl(
  instances: ReadonlyArray<Record<string, unknown>>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string | null> {
  const inst = pickThumbnailInstance(instances)
  if (!inst) return null
  const imageId = inst.imageId
  if (typeof imageId !== 'string') return null
  // The imageId already points at the single-frame preview's frame resource
  // (`.../instances/{sop}/frames/1`); strip the cornerstone loader scheme.
  const url = imageId.replace(/^(wadors|dicomweb|wadouri):/i, '')
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const response = await fetch(url, {
      headers: { Accept: 'multipart/related; type="image/jpeg"', ...headers },
      signal,
    })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') ?? ''
    const body = new Uint8Array(await response.arrayBuffer())
    const frame = parseMultipartRelated(body, contentType)[0]
    if (!frame || frame.length === 0) return null

    const encoding = frameEncoding(frame)
    if (encoding !== 'raw') {
      // Copy into a fresh ArrayBuffer-backed view so the bytes satisfy BlobPart
      // (a `Uint8Array<ArrayBufferLike>` slice does not).
      return URL.createObjectURL(
        new Blob([new Uint8Array(frame)], { type: `image/${encoding}` }),
      )
    }
    const info = rawImageInfo(inst, frame.length)
    if (!info) return null
    return rawFrameToDataUrl(frame, info)
  } catch {
    // Abort or network/parse/decode failure: fall back to the panel default tile.
    return null
  }
}
