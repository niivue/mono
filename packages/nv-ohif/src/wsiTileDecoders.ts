import type { FrameDecoder } from '@niivue/dcm2niix'
import { NVSlide, type SlideTileDecoder } from '@niivue/niivue'

let decoder: Promise<FrameDecoder> | null = null

// Monochrome tiles return their samples, which NVSlide windows (D16); colour
// tiles return RGBA8, with more than 8 bits scaled by DICOM BitsStored.
const decodeTile: SlideTileDecoder = async (bytes, { level, signal }) => {
  decoder ??= import('@niivue/dcm2niix')
    .then((m) => m.createFrameDecoder({ workers: 2 }))
    .catch((err) => {
      decoder = null // a failed chunk load retries on the next tile
      throw err
    })
  const d = await decoder
  const options = {
    photometric: level.photometric,
    bitsStored: level.bitsStored,
    signal,
  }
  if (level.photometric?.startsWith('MONOCHROME')) {
    const f = await d.decode(bytes, { ...options, output: 'samples' })
    return { ...f, components: 1 }
  }
  const f = await d.decode(bytes, options)
  // The pixels arrive in a transferred ArrayBuffer (never shared memory).
  const rgba = f.rgba as Uint8ClampedArray<ArrayBuffer>
  return createImageBitmap(new ImageData(rgba, f.width, f.height))
}

/**
 * Register JPEG 2000 and JPEG-LS tile decoders for NVSlide, backed by dcm2niix's
 * WASM worker pool (loaded on the first such tile). A decoder the host already
 * registered wins.
 */
export function registerWsiTileDecoders(): void {
  for (const codec of ['image/jp2', 'image/jls'] as const)
    if (!NVSlide.tileDecoder(codec))
      NVSlide.registerTileDecoder(codec, decodeTile)
}
