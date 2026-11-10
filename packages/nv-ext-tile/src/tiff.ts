import type {
  BlockedSourceOptions,
  GeoTIFF,
  Pool,
  RemoteSourceOptions,
} from '@niivue/geotiff-rs'
import {
  addDecoder,
  BaseClient,
  BaseDecoder,
  BaseResponse,
  fromCustomClient,
  GeoTIFFImage,
} from '@niivue/geotiff-rs'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import { sharedDcm2niixDecoders } from './dcm2niixDecoders'

export interface TiffSlideOptions {
  /** Manifest id; defaults to the file name. */
  id?: string
  /** geotiff decoder pool (web workers). Owned by the caller; omit to decode on the main thread. */
  pool?: Pool
}

export interface TiffSlideUrlOptions extends TiffSlideOptions {
  /** fetch implementation, e.g. one that adds auth headers. Defaults to globalThis.fetch. */
  fetch?: typeof fetch
  /** Aborts opening, e.g. when a newer open supersedes this one. */
  signal?: AbortSignal
}

// geotiff block cache: coalesces the 4/8-byte TileOffsets/TileByteCounts reads
// and IFD parsing into 64 KiB Range requests (geotiff 2.x's default). A tile
// read costs its byte count rounded out to block boundaries. fromCustomClient
// forwards blockSize, though its typings only declare RemoteSourceOptions.
const SOURCE_OPTIONS: RemoteSourceOptions & BlockedSourceOptions = {
  blockSize: 65536,
}

// Hostile-file bounds. Real slides use 256-1024 px tiles; 4096 caps one
// decoded RGBA tile at 64 MiB. A self-referencing IFD chain or a 2^32-pixel
// level must fail fast instead of looping or allocating per-tile objects.
const MAX_TILE_SIZE = 4096
// Across all levels: a 200k x 200k slide at 256 px is ~815k tiles incl. pyramid.
const MAX_TILES = 1 << 21
const MAX_IMAGES = 64

class RangeResponse extends BaseResponse {
  constructor(
    private readonly response: Response,
    private readonly onBytes: (n: number) => void,
  ) {
    super()
  }
  get status(): number {
    return this.response.status
  }
  getHeader(name: string): string | undefined {
    return this.response.headers.get(name) ?? undefined
  }
  async getData(): Promise<ArrayBuffer> {
    const data = await this.response.arrayBuffer()
    this.onBytes(data.byteLength)
    return data
  }
}

// Every geotiff read goes through here: counts wire bytes and refuses a server
// that ignores Range, so a multi-GB slide is never downloaded whole by accident.
class RangeClient extends BaseClient {
  private host: SlideSourceHost | null = null
  // Opening reads the header and IFDs before bind(); report them on bind.
  private unboundBytes = 0
  private unboundHits = 0
  // geotiff's block cache swallows client errors into "Request failed"; keep
  // the last one so opening a slide can report the real cause.
  lastError: unknown = null
  // geotiff passes a signal only to the header and tile fetches, so every read
  // also listens to this: the caller's open signal while opening, then the
  // source's lifetime, which cancels deferred metadata reads (an ICC profile)
  // on dispose.
  openSignal: AbortSignal | null = null
  constructor(
    url: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    super(url)
  }
  bind(host: SlideSourceHost): void {
    this.host = host
    host.addWireBytes(this.unboundBytes)
    for (let i = 0; i < this.unboundHits; i++) host.rangeHit()
  }
  async request(options: RequestInit = {}): Promise<BaseResponse> {
    try {
      return await this.rangeRequest(options)
    } catch (error) {
      this.lastError = error
      throw error
    }
  }
  private async rangeRequest(options: RequestInit): Promise<BaseResponse> {
    const signals = [options.signal, this.openSignal].filter(
      (x): x is AbortSignal => !!x,
    )
    const response = await this.fetchImpl(this.url, {
      headers: options.headers,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    })
    if (response.status === 200) {
      await response.body?.cancel()
      throw new Error(
        `${this.url}: server ignored the HTTP Range request (200, not 206). ` +
          'nv-ext-tile/tiff needs Range support (and CORS allowing Range) to stream a slide. Open a local copy with TiffSlideSource.fromGeoTIFF(await fromBlob(file)).',
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${this.url}: HTTP ${response.status}`)
    }
    // Absent cross-origin unless the server exposes it; then trust the length.
    const got = /^bytes (\d+)-/.exec(
      response.headers.get('Content-Range') ?? '',
    )
    const want = /^bytes=(\d+)-/.exec(
      new Headers(options.headers).get('Range') ?? '',
    )
    if (got && want && got[1] !== want[1]) {
      await response.body?.cancel()
      throw new Error(
        `${this.url}: server sent Content-Range starting at ${got[1]}, requested ${want[1]}`,
      )
    }
    if (this.host) this.host.rangeHit()
    else this.unboundHits++
    return new RangeResponse(response, (n) => {
      if (this.host) this.host.addWireBytes(n)
      else this.unboundBytes += n
    })
  }
}

async function pyramidImages(tiff: GeoTIFF): Promise<TiffLevel[]> {
  const first = await tiff.getImage(0)
  // OME-TIFF (bioformats 6+) keeps the pyramid of each plane in SubIFDs; the
  // main IFD chain then holds channels/z/t planes, not levels.
  // ponytail: first plane only (channel 0, z 0, t 0); plane selection is a follow-up.
  const subIfds = (await first.fileDirectory.loadValue('SubIFDs')) as
    | ArrayLike<number | bigint>
    | undefined
  if (subIfds && subIfds.length > 0) {
    const subs = await Promise.all(
      Array.from(subIfds)
        .slice(0, MAX_IMAGES)
        .map(async (offset) => {
          const ifd = await tiff.parser.parseFileDirectoryAt(Number(offset))
          return new GeoTIFFImage(
            ifd,
            tiff.littleEndian,
            tiff.cache,
            tiff.source,
          )
        }),
    )
    return pyramidLevels([first, ...subs])
  }
  // SVS / plain pyramidal TIFF: levels are the tiled images of the main chain.
  // The stripped ones (SVS thumbnail, label, macro) are not levels.
  // Walk the chain ourselves: geotiff's getImageCount loops forever on a cycle.
  const images = [first]
  let last = first
  while (last.fileDirectory.nextIFDByteOffset && images.length < MAX_IMAGES) {
    last = await tiff.getImage(images.length)
    images.push(last)
  }
  return pyramidLevels(images)
}

// A pyramid level: its image and the slide area it holds, which is smaller
// than the image when the writer padded it to whole tiles.
interface TiffLevel {
  img: GeoTIFFImage
  width: number
  height: number
  downsample: number
}

const padToTiles = (n: number, downsample: number, tile: number) =>
  Math.ceil(Math.ceil(n / downsample) / tile) * tile

// `img` as a level of `base`, or null when it is not one: a tiled image off
// the base aspect ratio (SVS macro between levels) would be stretched over the
// slide. The tolerance is the height error of rounding the width to pixels.
// Philips pads every level to whole tiles (91136x68096 / 128 is stored as
// 1024x1024), so a whole-tile image is a level when some downsample's area,
// padded to tiles, is its size on both axes. Padding hides the downsample
// (91136 / 1024 = 89), so try powers of two from the smallest it allows that
// no earlier (larger) image has taken: a one-tile image fits many.
// Only an image marked reduced-resolution (NewSubfileType bit 0, as Philips
// writes) and not a transparency mask (bit 2) is tried: a tiled macro can
// fit the padding too.
// ponytail: powers of two only, as Philips writes; parse its XML
// DICOM_PIXEL_SPACING if another padding writer needs other factors.
function levelOf(
  base: GeoTIFFImage,
  img: GeoTIFFImage,
  taken: Map<number, TiffLevel>,
): TiffLevel | null {
  const baseWidth = base.getWidth()
  const baseHeight = base.getHeight()
  const width = img.getWidth()
  const height = img.getHeight()
  const aspect = baseHeight / baseWidth
  if (Math.abs(height - aspect * width) <= 1 + aspect) {
    return { img, width, height, downsample: baseWidth / width }
  }
  const subfileType = Number(img.fileDirectory.getValue('NewSubfileType') ?? 0)
  if ((subfileType & 5) !== 1) return null
  const tileWidth = img.getTileWidth()
  const tileHeight = img.getTileHeight()
  if (width % tileWidth || height % tileHeight) return null
  for (
    let d = 2 ** Math.ceil(Math.log2(baseWidth / width));
    padToTiles(baseWidth, d, tileWidth) === width;
    d *= 2
  ) {
    if (!taken.has(d) && padToTiles(baseHeight, d, tileHeight) === height) {
      return {
        img,
        width: Math.ceil(baseWidth / d),
        height: Math.ceil(baseHeight / d),
        downsample: d,
      }
    }
  }
  return null
}

// Tiled images, one per downsample, finest first (NVSlide.selectLevel walks
// levels in order). Philips-2 stores two 512-wide levels (512x1024, 512x512).
function pyramidLevels(images: GeoTIFFImage[]): TiffLevel[] {
  const tiled = images
    .filter((img) => img.isTiled)
    .sort((a, b) => b.getWidth() - a.getWidth())
  const base = tiled[0]
  if (!base) return []
  const byDownsample = new Map<number, TiffLevel>()
  for (const img of tiled) {
    const level = levelOf(base, img, byDownsample)
    if (level && !byDownsample.has(level.downsample)) {
      byDownsample.set(level.downsample, level)
    }
  }
  return [...byDownsample.values()].sort((a, b) => a.downsample - b.downsample)
}

function buildTiffManifest(images: TiffLevel[], id: string): NVSlideManifest {
  const base = images[0]?.img
  if (!base) throw new Error('TIFF has no tiled pyramid levels')
  let totalTiles = 0
  const levels: NVSlideLevelManifest[] = images.map((level, index) => {
    const { img, width, height } = level
    const tileWidth = img.getTileWidth()
    const tileHeight = img.getTileHeight()
    // TIFF 6.0: tile width and length must be multiples of 16.
    const tileOk = (n: number) =>
      Number.isInteger(n) && n >= 16 && n <= MAX_TILE_SIZE && n % 16 === 0
    if (!tileOk(tileWidth) || !tileOk(tileHeight)) {
      throw new Error(
        `TIFF level ${index}: tile ${tileWidth}x${tileHeight} is not a multiple of 16 in 16-${MAX_TILE_SIZE}`,
      )
    }
    const columns = Math.ceil(width / tileWidth)
    const rows = Math.ceil(height / tileHeight)
    totalTiles += columns * rows
    if (totalTiles > MAX_TILES) {
      throw new Error(`TIFF has more than ${MAX_TILES} tiles`)
    }
    // Unsigned integers only: geotiff renders float gray black and signed wraps.
    if (img.getSampleFormat(0) !== 1) {
      throw new Error(
        `TIFF level ${index}: SampleFormat ${img.getSampleFormat(0)} is not supported (unsigned integer only)`,
      )
    }
    // readRGB returns RGB samples unscaled; only 8-bit fits the Uint8 tiles.
    // Gray and palette are scaled to 8-bit by geotiff-rs.
    const photometric = img.fileDirectory.getValue('PhotometricInterpretation')
    if (photometric === 2 && img.getBitsPerSample(0) !== 8) {
      throw new Error(
        `TIFF level ${index}: ${img.getBitsPerSample(0)}-bit RGB is not supported (8-bit only)`,
      )
    }
    // geotiff-rs decodes 8-bit JPEG only, and no old-style JPEG: reject the
    // level at open rather than fail every tile. 8-bit lossless JPEG still
    // fails per tile, as only the tile stream shows it.
    const compression = img.fileDirectory.getValue('Compression')
    const bits = img.getBitsPerSample(0)
    if (compression === 6 || (compression === 7 && bits !== 8)) {
      const kind = compression === 6 ? 'old-style' : `${bits}-bit`
      throw new Error(
        `TIFF level ${index}: ${kind} JPEG is not supported (8-bit only)`,
      )
    }
    const tiles: NVSlideTileManifest[] = []
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        tiles.push({
          x: col,
          y: row,
          width: Math.min(tileWidth, width - col * tileWidth),
          height: Math.min(tileHeight, height - row * tileHeight),
        })
      }
    }
    return {
      index,
      width,
      height,
      downsample: level.downsample,
      tileWidth,
      tileHeight,
      columns,
      rows,
      codec: 'raw-rgba',
      tiles,
    }
  })
  return {
    id,
    name: `${id} (TIFF)`,
    format: 'tiff',
    width: base.getWidth(),
    height: base.getHeight(),
    tileSize: base.getTileWidth(),
    dtype: 'uint8',
    channels: 'rgba',
    displayYAxis: 'down',
    levels,
  }
}

// readRGB with enableAlpha yields 3 samples per pixel, or every sample of an
// RGB image with ExtraSamples: the first extra is alpha, further ones are
// skipped. The case is chosen once per tile so each pixel loop stays branch-free.
function toRgba(
  rgb: ArrayLike<number>,
  pixels: number,
  associatedAlpha: boolean,
): Uint8Array {
  const stride = rgb.length / pixels
  if (stride === 4 && !associatedAlpha && rgb instanceof Uint8Array) return rgb
  const rgba = new Uint8Array(pixels * 4)
  const n = pixels * 4
  if (stride === 3) {
    for (let i = 0, j = 0; i < n; i += 4, j += 3) {
      rgba[i] = rgb[j]
      rgba[i + 1] = rgb[j + 1]
      rgba[i + 2] = rgb[j + 2]
      rgba[i + 3] = 255
    }
  } else if (!associatedAlpha) {
    for (let i = 0, j = 0; i < n; i += 4, j += stride) {
      rgba[i] = rgb[j]
      rgba[i + 1] = rgb[j + 1]
      rgba[i + 2] = rgb[j + 2]
      rgba[i + 3] = rgb[j + 3]
    }
  } else {
    // Associated alpha is premultiplied; NVSlide takes straight alpha. The
    // clamped view rounds and caps colour > alpha in malformed files.
    const out = new Uint8ClampedArray(rgba.buffer)
    for (let i = 0, j = 0; i < n; i += 4, j += stride) {
      const a = rgb[j + 3]
      const k = a ? 255 / a : 0
      out[i] = rgb[j] * k
      out[i + 1] = rgb[j + 1] * k
      out[i + 2] = rgb[j + 2] * k
      out[i + 3] = a
    }
  }
  return rgba
}

// geotiff-rs ships no JPEG 2000 codec. dcm2niix's OpenJPEG returns the whole
// tile as final 8-bit RGB (or gray): it upsamples 33003's half-width chroma
// and converts YCbCr itself, and geotiff-rs converts nothing after it.
// ponytail: dcm2niix refuses tiles over 2048 px ('too-large'); MAX_TILE_SIZE allows 4096.
class Dcm2niixJpeg2000Decoder extends BaseDecoder {
  async decodeBlock(buffer: ArrayBufferLike): Promise<ArrayBufferLike> {
    const { tileWidth, tileHeight, bitsPerSample, planarConfiguration } =
      this.parameters
    const frame = await sharedDcm2niixDecoders().decodeSamples(
      new Uint8Array(buffer),
    )
    // geotiff-rs places 8-bit samples by the TIFF's tile size and sample count;
    // a grey codestream in an RGB TIFF would leave it a short buffer.
    const perPixel =
      planarConfiguration === 2 || typeof bitsPerSample === 'number'
        ? 1
        : (bitsPerSample?.length ?? 1)
    if (
      frame.width !== tileWidth ||
      frame.height !== tileHeight ||
      frame.samples.byteLength !== tileWidth * tileHeight * perPixel
    ) {
      throw new Error(
        `JPEG 2000 tile is ${frame.width}x${frame.height} (${frame.samples.byteLength} bytes), TIFF declares ${tileWidth}x${tileHeight} x ${perPixel} samples`,
      )
    }
    return frame.samples.buffer // transferred from the worker, exactly the samples
  }
}

/**
 * Decode JPEG 2000 TIFF tiles (Aperio SVS 33003 and 33005, TIFF 34712) with
 * dcm2niix's WASM worker pool, loaded on the first such tile and shared with
 * `registerDcm2niixDecoders` from `/dicom`. Without it, such tiles fail with
 * geotiff-rs's "no built-in decoder" error. Call it before reading tiles; it
 * replaces any decoder registered for those compressions.
 * Needs the optional peer dependency `@niivue/dcm2niix`.
 */
export function registerDcm2niixTiffDecoders(): void {
  // preferWorker false: registrations do not reach geotiff Pool workers; the
  // decode runs in dcm2niix's own workers.
  addDecoder(
    [33003, 33005, 34712],
    async () => Dcm2niixJpeg2000Decoder,
    undefined,
    false,
  )
}

function fileName(url: string): string {
  const last = url.replace(/[?#].*$/, '').replace(/^.*\//, '')
  try {
    return decodeURIComponent(last) || url
  } catch {
    return last || url
  }
}

/**
 * NVSlide tile source for tiled/pyramidal TIFF, BigTIFF, OME-TIFF and Aperio
 * SVS. geotiff-rs parses IFDs lazily and reads one tile's bytes per request, then
 * decodes it (JPEG incl. JPEGTables, LZW, Deflate, PackBits, ZSTD, WebP, LERC;
 * JPEG 2000 after {@link registerDcm2niixTiffDecoders}) and converts its
 * photometric interpretation (YCbCr, palette, gray, CMYK) to RGB. Tiles reach NVSlide as raw RGBA, cropped at the right/bottom edge.
 *
 * NVSlide.dispose() does not reach the source: call {@link dispose} too.
 */
export class TiffSlideSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null
  private readonly closed = new AbortController()

  private constructor(
    private readonly tiff: GeoTIFF,
    private readonly images: TiffLevel[],
    id: string,
    private readonly pool: Pool | undefined,
    private readonly client: RangeClient | null,
  ) {
    this.manifest = buildTiffManifest(images, id)
  }

  /** Stream a remote TIFF by HTTP Range. Rejects if the server ignores Range. */
  static async fromUrl(
    url: string,
    options: TiffSlideUrlOptions = {},
  ): Promise<TiffSlideSource> {
    // Bound: a bare window.fetch called as a method throws "Illegal invocation".
    const client = new RangeClient(
      url,
      options.fetch ?? globalThis.fetch.bind(globalThis),
    )
    const fail = (error: unknown): never => {
      options.signal?.throwIfAborted()
      throw client.lastError ?? error
    }
    client.openSignal = options.signal ?? null
    let tiff: GeoTIFF
    let images: TiffLevel[]
    try {
      tiff = await fromCustomClient(
        client,
        SOURCE_OPTIONS,
        options.signal,
      ).catch(fail)
      images = await pyramidImages(tiff).catch(fail)
    } finally {
      // Until the source exists; then its lifetime (below).
      client.openSignal = null
    }
    options.signal?.throwIfAborted()
    const source = new TiffSlideSource(
      tiff,
      images,
      options.id ?? fileName(url),
      options.pool,
      client,
    )
    client.openSignal = source.closed.signal
    return source
  }

  /** Wrap an already-open GeoTIFF, e.g. `fromBlob(file)` for a local file. */
  static async fromGeoTIFF(
    tiff: GeoTIFF,
    options: TiffSlideOptions = {},
  ): Promise<TiffSlideSource> {
    return new TiffSlideSource(
      tiff,
      await pyramidImages(tiff),
      options.id ?? 'tiff',
      options.pool,
      null,
    )
  }

  bind(host: SlideSourceHost): void {
    this.host = host
    this.client?.bind(host)
  }

  /** The base image's ICC profile (tag 34675, e.g. Aperio SVS); null without one. */
  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const dir = this.images[0]?.img.fileDirectory
    // By number: geotiff 3's name lookup does not resolve 'ICCProfile'.
    if (!dir?.hasTag(34675)) return null
    signal?.throwIfAborted()
    // geotiff's loadValue takes no signal: an abort stops the wait here, and
    // dispose() cancels the read itself (RangeClient.openSignal).
    const read: Promise<ArrayLike<number> | undefined> = dir.loadValue(34675)
    let onAbort = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    let value: ArrayLike<number> | undefined
    try {
      value = await (signal ? Promise.race([read, aborted]) : read)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    if (!value) return null
    return value instanceof Uint8Array ? value : Uint8Array.from(value)
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const img = this.images[level.index]?.img
    if (!img) throw new Error(`No TIFF level ${level.index}`)
    const abort = signal
      ? AbortSignal.any([signal, this.closed.signal])
      : this.closed.signal
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      abort.throwIfAborted()
      // TileByteCounts 0 marks a tile absent (Philips sparse ROIs, Aperio);
      // like OpenSlide, show it transparent rather than decode zeros (green
      // through YCbCr). Planar configuration 2 stores one tile per sample, so
      // the tile is absent only when every sample's is; geotiff fills a lone
      // absent sample with zeros.
      const index = tile.y * level.columns + tile.x
      const planes =
        img.fileDirectory.getValue('PlanarConfiguration') === 2
          ? img.getSamplesPerPixel()
          : 1
      let absent = true
      for (let s = 0; s < planes && absent; s++) {
        const byteCount = await img.fileDirectory.loadValueIndexed(
          'TileByteCounts',
          index + s * level.columns * level.rows,
        )
        absent = Number(byteCount) === 0
      }
      abort.throwIfAborted()
      if (absent) {
        this.host?.updateRangeEvent(label, 'hit')
        return new Uint8Array(tile.width * tile.height * 4)
      }
      const x0 = tile.x * img.getTileWidth()
      const y0 = tile.y * img.getTileHeight()
      const rgb = await img.readRGB({
        window: [x0, y0, x0 + tile.width, y0 + tile.height],
        interleave: true,
        pool: this.pool,
        signal: abort,
        enableAlpha: true,
      })
      abort.throwIfAborted()
      this.host?.updateRangeEvent(label, 'hit')
      return toRgba(
        rgb,
        tile.width * tile.height,
        img.fileDirectory.getValue('ExtraSamples')?.[0] === 1,
      )
    } catch (error) {
      this.host?.updateRangeEvent(label, abort.aborted ? 'aborted' : 'failed')
      throw error
    }
  }

  /** Abort in-flight reads and close the file. The caller's pool is left alone. */
  dispose(): void {
    if (this.closed.signal.aborted) return
    this.closed.abort()
    // Closing a file source twice (or a closed fd) rejects with EBADF.
    Promise.resolve(this.tiff.close()).catch(() => {})
  }
}
