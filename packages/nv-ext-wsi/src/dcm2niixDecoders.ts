import type { FrameDecoder } from '@niivue/dcm2niix'
import {
  NVSlide,
  type SlideIccTransform,
  type SlideTileDecoder,
} from '@niivue/niivue'

let decoder: Promise<FrameDecoder> | null = null

const frameDecoder = (): Promise<FrameDecoder> => {
  decoder ??= import('@niivue/dcm2niix')
    .then((m) => m.createFrameDecoder({ workers: 2 }))
    .catch((err) => {
      decoder = null // a failed chunk load retries on the next tile
      throw err
    })
  return decoder
}

const LUT_SIZE = 33 // the standard device-link grid; exact to 0.5 at its nodes

// FrameDecoder.iccLut is newer than @niivue/dcm2niix rc.1; without it nothing is baked.
type IccLut = (
  profile: Uint8Array,
  options: { size: number; signal?: AbortSignal },
) => Promise<Uint8Array | null>

const bakeProfile: SlideIccTransform = async (profile, signal) => {
  const d = (await frameDecoder()) as FrameDecoder & { iccLut?: IccLut }
  if (!d.iccLut) return null
  const data = await d.iccLut(profile, { size: LUT_SIZE, signal })
  return data && { size: LUT_SIZE, data }
}

// Monochrome tiles return their samples, which NVSlide windows (D16); colour
// tiles return RGBA8, with more than 8 bits scaled by DICOM BitsStored.
const decodeTile: SlideTileDecoder = async (bytes, { level, signal }) => {
  const d = await frameDecoder()
  const options = {
    photometric: level.photometric,
    bitsStored: level.bitsStored,
    signal,
  }
  if (level.photometric?.startsWith('MONOCHROME')) {
    return d.decode(bytes, { ...options, output: 'samples' })
  }
  const f = await d.decode(bytes, options)
  // The pixels arrive in a transferred ArrayBuffer (never shared memory).
  const rgba = f.rgba as Uint8ClampedArray<ArrayBuffer>
  return createImageBitmap(new ImageData(rgba, f.width, f.height))
}

/**
 * Register JPEG 2000 and JPEG-LS tile decoders for NVSlide, backed by dcm2niix's
 * WASM worker pool (loaded on the first such tile), and its LittleCMS ICC
 * transform, so slides with a profile are colour-managed. A decoder the host
 * already registered wins. Needs the optional peer dependency `@niivue/dcm2niix`.
 */
export function registerDcm2niixDecoders(): void {
  for (const codec of ['image/jp2', 'image/jls'] as const)
    if (!NVSlide.tileDecoder(codec))
      NVSlide.registerTileDecoder(codec, decodeTile)
  NVSlide.registerIccTransform(bakeProfile)
}
