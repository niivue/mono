import type { DecodedFrameSamples, FrameDecoder } from '@niivue/dcm2niix'
import {
  NVSlide,
  type SlideIccTransform,
  type SlideTileDecoder,
} from '@niivue/niivue'

type Pool = { decoder: Promise<FrameDecoder>; active: number; retired: boolean }

// dcm2niix never respawns a dead worker: once both have died (WASM load failure,
// codec trap) every decode rejects. Its worker failures are plain Errors; a bad
// frame (FrameDecodeError), an abort (AbortError), a full queue or a terminated
// pool ('frame decoder ...') must not replace the pool, nor may an abort whose
// reason is a plain Error (dcm2niix rejects with that reason, matched by
// identity). nv-ohif uses this registration too.
function isWorkerFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'Error' &&
    !err.message.startsWith('frame decoder ')
  )
}

const LUT_SIZE = 33 // the standard device-link grid; exact to 0.5 at its nodes

type Dcm2niixDecoders = {
  decodeTile: SlideTileDecoder
  bakeProfile: SlideIccTransform
  decodeSamples: (bytes: Uint8Array) => Promise<DecodedFrameSamples>
}

/** Tile decoder and ICC transform over one lazily created dcm2niix pool, replaced when its workers die. */
export function createDcm2niixDecoders(
  createDecoder: () => Promise<FrameDecoder> = () =>
    import('@niivue/dcm2niix').then((m) =>
      m.createFrameDecoder({ workers: 2 }),
    ),
): Dcm2niixDecoders {
  let pool: Pool | null = null
  const startPool = (): Pool => {
    const p: Pool = {
      active: 0,
      retired: false,
      decoder: createDecoder().catch((err) => {
        if (pool === p) pool = null // a failed chunk load retries on the next tile
        throw err
      }),
    }
    return p
  }
  // Run on the current pool; a worker failure retires it (terminated once its
  // other in-flight work settles) and retries once on a fresh pool, since a
  // death masked by an earlier abort surfaces only on the next call.
  const withPool = async <T>(
    signal: AbortSignal | undefined,
    run: (d: FrameDecoder) => Promise<T>,
    isRetry = false,
  ): Promise<T> => {
    pool ??= startPool()
    const p = pool
    p.active++
    try {
      return await run(await p.decoder)
    } catch (err) {
      if (err !== signal?.reason && isWorkerFailure(err)) {
        p.retired = true
        if (pool === p) pool = null
        if (!isRetry && !signal?.aborted) return withPool(signal, run, true)
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

  const bakeProfile: SlideIccTransform = (profile, signal) =>
    withPool(signal, async (d) => {
      const data = await d.iccLut(profile, { size: LUT_SIZE, signal })
      return data && { size: LUT_SIZE, data }
    })

  // Monochrome tiles return their samples, which NVSlide windows (D16); colour
  // tiles return RGBA8, with more than 8 bits scaled by DICOM BitsStored.
  const decodeTile: SlideTileDecoder = (bytes, { level, signal }) =>
    withPool(signal, async (d) => {
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
    })

  const decodeSamples = (bytes: Uint8Array) =>
    withPool(undefined, (d) => d.decode(bytes, { output: 'samples' }))

  return { decodeTile, bakeProfile, decodeSamples }
}

// One pool for /dicom's NVSlide decoders and /tiff's JPEG 2000 tiles.
let shared: Dcm2niixDecoders | null = null
export const sharedDcm2niixDecoders = (): Dcm2niixDecoders =>
  (shared ??= createDcm2niixDecoders())

/**
 * Register JPEG 2000 and JPEG-LS tile decoders for NVSlide, backed by dcm2niix's
 * WASM worker pool (loaded on the first such tile), and its LittleCMS ICC
 * transform, so slides with a profile are colour-managed. A decoder or ICC
 * transform the host already registered wins. Call it before opening slides.
 * Needs the optional peer dependency `@niivue/dcm2niix`.
 */
export function registerDcm2niixDecoders(): void {
  const { decodeTile, bakeProfile } = sharedDcm2niixDecoders()
  for (const codec of ['image/jp2', 'image/jls'] as const)
    if (!NVSlide.tileDecoder(codec))
      NVSlide.registerTileDecoder(codec, decodeTile)
  if (!NVSlide.iccTransform()) NVSlide.registerIccTransform(bakeProfile)
}
