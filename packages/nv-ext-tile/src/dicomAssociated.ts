import { NVSlide, type NVSlideTileCodec, settleBy } from '@niivue/niivue'
import type {
  SlideIndex,
  SlideIndexAssociated,
  SlideIndexSlide,
} from './dicomIndex'
import {
  CODEC_BY_TRANSFER_SYNTAX,
  fileFor,
  joinFragments,
} from './dicomWsiSource'

/** An associated image's pixels: an encoded frame, or 8-bit RGBA. */
export interface AssociatedImageData {
  codec: NVSlideTileCodec
  width: number
  height: number
  bytes: Uint8Array
}

/**
 * The label, overview and thumbnail images of `slide`'s specimen: same study
 * and container (or series, when either states no container).
 */
export function associatedImages(
  index: SlideIndex,
  slide: SlideIndexSlide,
): SlideIndexAssociated[] {
  return (index.associated ?? []).filter(
    (a) =>
      a.study === slide.study &&
      (a.container && slide.container
        ? a.container === slide.container
        : a.series === slide.series),
  )
}

/** Native 8-bit grey or RGB samples as RGBA; MONOCHROME1 inverted. */
function nativeRgba(
  { width, height, native, instance }: SlideIndexAssociated,
  s: Uint8Array,
): Uint8Array {
  const n = width * height
  const out = new Uint8Array(n * 4)
  if (native?.samplesPerPixel === 3) {
    // Planar: all R, then G, then B.
    const [step, plane] = native.planar ? [1, n] : [3, 1]
    for (let i = 0, j = 0; i < n; i++, j += step) {
      out[i * 4] = s[j] as number
      out[i * 4 + 1] = s[j + plane] as number
      out[i * 4 + 2] = s[j + 2 * plane] as number
      out[i * 4 + 3] = 255
    }
  } else {
    const flip = instance.photometric === 'MONOCHROME1' ? 255 : 0
    for (let i = 0; i < n; i++) {
      const v = (s[i] as number) ^ flip
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
      out[i * 4 + 3] = 255
    }
  }
  return out
}

/**
 * Read an associated image from the indexed `files`: its encoded frame
 * (fragments joined), or native samples as `raw-rgba`.
 */
export async function readAssociatedImage(
  image: SlideIndexAssociated,
  files: readonly File[],
  signal?: AbortSignal,
): Promise<AssociatedImageData> {
  const { instance, offset, length, width, height } = image
  const file = fileFor(files)(instance)
  const read = (start: number, end: number) =>
    settleBy(
      signal,
      file
        .slice(start, end)
        .arrayBuffer()
        .then((b) => new Uint8Array(b)),
    )
  if (image.native)
    return {
      codec: 'raw-rgba',
      width,
      height,
      bytes: nativeRgba(image, await read(offset, offset + length)),
    }
  const codec = CODEC_BY_TRANSFER_SYNTAX[instance.transferSyntax]
  if (!codec)
    throw new Error(
      `transfer syntax ${instance.transferSyntax} cannot be decoded`,
    )
  const span = await read(offset - 8, offset + length)
  const bytes = joinFragments(span, `${file.name} ${image.kind}`)
  return { codec, width, height, bytes }
}

/**
 * An associated image as an ImageBitmap (browser), through NVSlide's tile
 * decoders: JPEG and native built in, JPEG 2000 and JPEG-LS once registered
 * (registerDcm2niixDecoders). A monochrome JPEG 2000 or JPEG-LS image, which
 * decodes to samples, is refused.
 */
export async function associatedImageBitmap(
  image: SlideIndexAssociated,
  files: readonly File[],
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const { codec, width, height, bytes } = await readAssociatedImage(
    image,
    files,
    signal,
  )
  const level = {
    index: 0,
    width,
    height,
    downsample: 1,
    columns: 1,
    rows: 1,
    tiles: [],
    codec,
    photometric: image.instance.photometric,
    bitsStored: image.instance.bitsStored,
  }
  const out = await NVSlide.tileDecoder(codec)?.(bytes, {
    width,
    height,
    level,
    signal,
  })
  if (!(out instanceof ImageBitmap))
    throw new Error(`no bitmap decoder for a ${codec} ${image.kind}`)
  return out
}
