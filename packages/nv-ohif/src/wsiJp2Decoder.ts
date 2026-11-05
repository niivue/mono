import { NVSlide } from '@niivue/niivue'

let decoder: Promise<import('@niivue/dcm2niix').FrameDecoder> | null = null

/**
 * Register a JPEG 2000 tile decoder for NVSlide, backed by dcm2niix's WASM worker
 * pool (loaded on the first JP2K tile). A decoder the host already registered wins.
 */
export function registerJp2TileDecoder(): void {
  if (NVSlide.tileDecoder('image/jp2')) return
  NVSlide.registerTileDecoder('image/jp2', async (bytes, { level }) => {
    decoder ??= import('@niivue/dcm2niix').then((m) =>
      m.createFrameDecoder({ workers: 2 }),
    )
    const frame = await (await decoder).decode(bytes, {
      photometric: level.photometric,
    })
    // The pixels arrive in a transferred ArrayBuffer (never shared memory).
    const rgba = frame.rgba as Uint8ClampedArray<ArrayBuffer>
    return createImageBitmap(new ImageData(rgba, frame.width, frame.height))
  })
}
