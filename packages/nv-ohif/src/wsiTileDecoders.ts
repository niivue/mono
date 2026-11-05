import { NVSlide, type SlideTileDecoder } from '@niivue/niivue'

// The @niivue/dcm2niix decode API from 1.4.20261105-rc.1 (samples output, bitsStored).
// ponytail: local type until the dependency is rc.1; then use its FrameDecoder.
type DecodeOptions = {
  photometric?: string
  bitsStored?: number
  signal?: AbortSignal
}
interface FrameDecoder {
  decode(
    bytes: Uint8Array,
    options: DecodeOptions & { output: 'samples' },
  ): Promise<{
    width: number
    height: number
    samples: Uint8Array | Uint16Array
    bitsStored: number
  }>
  decode(
    bytes: Uint8Array,
    options: DecodeOptions,
  ): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }>
}

let decoder: Promise<FrameDecoder> | null = null

// Monochrome tiles return their samples, which NVSlide windows (D16); colour
// tiles return RGBA8, with more than 8 bits scaled by DICOM BitsStored.
const decodeTile: SlideTileDecoder = async (bytes, { level, signal }) => {
  decoder ??= import('@niivue/dcm2niix')
    .then(
      (m) => m.createFrameDecoder({ workers: 2 }) as unknown as FrameDecoder,
    )
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
