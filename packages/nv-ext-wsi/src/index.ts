import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'
import type {
  BlockedSourceOptions,
  GeoTIFF,
  Pool,
  RemoteSourceOptions,
} from 'geotiff'
import {
  BaseClient,
  BaseResponse,
  fromCustomClient,
  GeoTIFFImage,
} from 'geotiff'

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
  // Set while opening: geotiff passes a signal only to the header fetch, so
  // every metadata (IFD) read also listens to the caller's open signal.
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
          'nv-ext-wsi needs Range support (and CORS allowing Range) to stream a slide. Open a local copy with TiffSlideSource.fromGeoTIFF(await fromBlob(file)).',
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

async function pyramidImages(tiff: GeoTIFF): Promise<GeoTIFFImage[]> {
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

// Tiled images, one per width, largest first (NVSlide.selectLevel walks levels
// in order). A tiled image off the base aspect ratio (SVS macro between levels)
// is not a level: it would be stretched over the slide. The tolerance is the
// height error of rounding the level width to whole pixels.
function pyramidLevels(images: GeoTIFFImage[]): GeoTIFFImage[] {
  const tiled = images
    .filter((img) => img.isTiled)
    .sort((a, b) => b.getWidth() - a.getWidth())
  const base = tiled[0]
  if (!base) return []
  const aspect = base.getHeight() / base.getWidth()
  const byWidth = new Map<number, GeoTIFFImage>()
  for (const img of tiled) {
    const offAspect =
      Math.abs(img.getHeight() - aspect * img.getWidth()) > 1 + aspect
    if (!offAspect && !byWidth.has(img.getWidth())) {
      byWidth.set(img.getWidth(), img)
    }
  }
  return [...byWidth.values()]
}

function buildTiffManifest(
  images: GeoTIFFImage[],
  id: string,
): NVSlideManifest {
  const base = images[0]
  if (!base) throw new Error('TIFF has no tiled pyramid levels')
  let totalTiles = 0
  const levels: NVSlideLevelManifest[] = images.map((img, index) => {
    const width = img.getWidth()
    const height = img.getHeight()
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
    // Gray and palette are scaled to 8-bit by geotiff, except WhiteIsZero,
    // whose conversion wraps 0 (white) to 256 = black in a Uint8Array.
    const photometric = img.fileDirectory.getValue('PhotometricInterpretation')
    if (photometric === 0) {
      throw new Error(`TIFF level ${index}: WhiteIsZero is not supported`)
    }
    if (photometric === 2 && img.getBitsPerSample(0) !== 8) {
      throw new Error(
        `TIFF level ${index}: ${img.getBitsPerSample(0)}-bit RGB is not supported (8-bit only)`,
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
      downsample: base.getWidth() / width,
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
 * SVS. geotiff parses IFDs lazily and reads one tile's bytes per request, then
 * decodes it (JPEG incl. JPEGTables, LZW, Deflate, PackBits, ZSTD, WebP, LERC)
 * and converts its photometric interpretation (YCbCr, palette, gray, CMYK) to
 * RGB. Tiles reach NVSlide as raw RGBA, cropped at the right/bottom edge.
 *
 * NVSlide.dispose() does not reach the source: call {@link dispose} too.
 */
export class TiffSlideSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null
  private readonly closed = new AbortController()

  private constructor(
    private readonly tiff: GeoTIFF,
    private readonly images: GeoTIFFImage[],
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
    let images: GeoTIFFImage[]
    try {
      tiff = await fromCustomClient(
        client,
        SOURCE_OPTIONS,
        options.signal,
      ).catch(fail)
      images = await pyramidImages(tiff).catch(fail)
    } finally {
      // Tile reads carry their own per-tile signal from NVSlide.
      client.openSignal = null
    }
    options.signal?.throwIfAborted()
    return new TiffSlideSource(
      tiff,
      images,
      options.id ?? fileName(url),
      options.pool,
      client,
    )
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

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const img = this.images[level.index]
    if (!img) throw new Error(`No TIFF level ${level.index}`)
    const abort = signal
      ? AbortSignal.any([signal, this.closed.signal])
      : this.closed.signal
    this.host?.pushRangeEvent({ label, status: 'pending' })
    try {
      abort.throwIfAborted()
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
