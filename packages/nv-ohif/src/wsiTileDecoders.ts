import type { FrameDecoder } from '@niivue/dcm2niix'
import { NVSlide, type SlideTileDecoder } from '@niivue/niivue'

type Pool = { decoder: Promise<FrameDecoder>; active: number; retired: boolean }

// dcm2niix never respawns a dead worker: once both have died (WASM load failure,
// codec trap) every decode rejects. Its worker failures are plain Errors; a bad
// frame (FrameDecodeError), an abort (AbortError), a full queue or a terminated
// pool ('frame decoder ...') must not replace the pool.
function isWorkerFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'Error' &&
    !err.message.startsWith('frame decoder ')
  )
}

/** A tile decoder over a lazily created dcm2niix pool, replaced when its workers die. */
export function createWsiTileDecoder(
  createDecoder: () => Promise<FrameDecoder> = () =>
    import('@niivue/dcm2niix').then((m) =>
      m.createFrameDecoder({ workers: 2 }),
    ),
): SlideTileDecoder {
  let pool: Pool | null = null
  const startPool = (): Pool => {
    const p = { active: 0, retired: false } as Pool
    p.decoder = createDecoder().catch((err) => {
      if (pool === p) pool = null // a failed chunk load retries on the next tile
      throw err
    })
    return p
  }
  // Monochrome tiles return their samples, which NVSlide windows (D16); colour
  // tiles return RGBA8, with more than 8 bits scaled by DICOM BitsStored.
  return async (bytes, { level, signal }) => {
    pool ??= startPool()
    const p = pool
    p.active++
    try {
      const d = await p.decoder
      const options = {
        photometric: level.photometric,
        bitsStored: level.bitsStored,
        signal,
      }
      if (level.photometric?.startsWith('MONOCHROME')) {
        return await d.decode(bytes, { ...options, output: 'samples' })
      }
      const f = await d.decode(bytes, options)
      // The pixels arrive in a transferred ArrayBuffer (never shared memory).
      const rgba = f.rgba as Uint8ClampedArray<ArrayBuffer>
      return createImageBitmap(new ImageData(rgba, f.width, f.height))
    } catch (err) {
      if (isWorkerFailure(err)) {
        // Later tiles get a fresh pool; this one is terminated once its other
        // in-flight decodes (on a worker that may still be live) settle.
        p.retired = true
        if (pool === p) pool = null
      }
      throw err
    } finally {
      if (--p.active === 0 && p.retired)
        p.decoder.then(
          (d) => d.terminate(),
          () => {},
        )
    }
  }
}

/**
 * Register JPEG 2000 and JPEG-LS tile decoders for NVSlide, backed by dcm2niix's
 * WASM worker pool (loaded on the first such tile). A decoder the host already
 * registered wins.
 */
export function registerWsiTileDecoders(): void {
  const decodeTile = createWsiTileDecoder()
  for (const codec of ['image/jp2', 'image/jls'] as const)
    if (!NVSlide.tileDecoder(codec))
      NVSlide.registerTileDecoder(codec, decodeTile)
}
