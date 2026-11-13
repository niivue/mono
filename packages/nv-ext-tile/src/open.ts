// One opener for every slide format this package reads. Each format's module
// is imported only when a slide of that format is opened, so this entry
// costs a DICOM-only page no TIFF or Zarr payload.
import type { Pool } from '@niivue/geotiff-rs'
import {
  type DocumentSourceResolver,
  DziSource,
  ManifestRangeSource,
  type NVSlideAttribution,
  type SlideTileSource,
} from '@niivue/niivue'
import { cleanAttribution } from './attribution'
import type { SlideIndex, SlideIndexSlide } from './dicomIndex'
import {
  anySignal,
  readCapped,
  type SlideFetch,
  slideFetch,
} from './rangeFetch'
import type { TiffSlideOptions } from './tiff'

export type SlideKind =
  | 'tiff'
  | 'dicom'
  /** TIFF magic with DICM at 128: indexed as DICOM and listed as a TIFF too. */
  | 'dicom-tiff'
  | 'zarr'
  | 'dzi'
  /** A hosted `dicom-wsi-range-v1` (or any byte-range) manifest. */
  | 'manifest'

export interface OpenSlideOptions {
  /** Every read, including the sniff probe (auth headers, signed URLs). */
  fetch?: SlideFetch
  signal?: AbortSignal
  /** geotiff decoder pool for TIFF; borrowed, never terminated here. */
  pool?: Pool
  /** Manifest URLs resolve against this instead of the manifest's own URL. */
  baseUrl?: string
  attribution?: NVSlideAttribution
  /** DICOM folders: files indexed so far. */
  onProgress?: (done: number, total: number) => void
  /** TIFF only, e.g. `placement`, `z`, `t`. */
  tiff?: Omit<TiffSlideOptions, 'pool' | 'attribution'>
}

/** One slide the input holds; `open` makes its source (the caller owns it). */
export interface SlideCandidate {
  kind: SlideKind
  label: string
  /** DICOM: the indexed slide it opens (levels, frames, transfer syntax). */
  slide?: SlideIndexSlide
  open(signal?: AbortSignal): Promise<SlideTileSource>
}

export interface OpenedSlides {
  kind: SlideKind
  /** Every slide found, in input order; never chosen among here. */
  candidates: SlideCandidate[]
  /** DICOM: the index, with skipped files and associated images (read them against the input files). */
  index?: SlideIndex
}

/** `VolumeSourceDescriptor.kind` of the slides `openSlide` opens. */
export const SLIDE_SOURCE_KIND = 'nv-ext-tile/slide'

const URL_KINDS: readonly string[] = [
  'tiff',
  'dicom-tiff',
  'zarr',
  'dzi',
  'manifest',
]

// `extra` holds what the reopen cannot recover from the saved manifest: `local`
// (a file the default resolver cannot reopen; the name lets a host offer it
// again), a non-default TIFF `placement`, a manifest's custom `baseUrl`.
function described<T extends SlideTileSource>(
  src: T,
  url: string,
  format: SlideKind,
  extra: { local?: true; placement?: false; baseUrl?: string } = {},
): T {
  src.descriptor = {
    kind: SLIDE_SOURCE_KIND,
    url,
    params: { format, ...extra },
  }
  return src
}

/**
 * A `loadDocument` `resolveSource` that reopens slides `openSlide` opened by
 * URL, reading through `options` (the host's fetch and credentials). Anything
 * else, local files included, resolves null; compose it with the host's own.
 */
export function resolveSlideSource(
  options: OpenSlideOptions = {},
): DocumentSourceResolver {
  return (d, { signal, slide }) => {
    const format = d.params?.format
    if (
      !slide ||
      d.kind !== SLIDE_SOURCE_KIND ||
      d.params?.local ||
      typeof format !== 'string' ||
      !URL_KINDS.includes(format)
    )
      return null
    const reopen: OpenSlideOptions = { ...options }
    // DZI reads tiles with the global fetch and refuses a custom one.
    if (format === 'dzi') reopen.fetch = undefined
    if (d.params?.placement === false)
      reopen.tiff = { ...options.tiff, placement: false }
    if (typeof d.params?.baseUrl === 'string') reopen.baseUrl = d.params.baseUrl
    return openUrl(format as SlideKind, d.url, reopen, signal)
  }
}

const isTiffMagic = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x49 && b[3] === 0) ||
  (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0)
const hasDicm = (b: Uint8Array) =>
  b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d

/** The kind of a file's first 132 bytes; null when neither TIFF nor DICOM. */
function kindOfBytes(b: Uint8Array): SlideKind | null {
  if (isTiffMagic(b)) return hasDicm(b) ? 'dicom-tiff' : 'tiff'
  return hasDicm(b) ? 'dicom' : null
}

const PROBE = 'bytes=0-131'

const kindOfFile = async (file: File) =>
  kindOfBytes(new Uint8Array(await file.slice(0, 132).arrayBuffer()))

/**
 * What `input` is. A URL is named by its path when it can be (`.zarr` or a
 * trailing `/`, `.dzi`, `.json`, TIFF suffixes), else by one 132-byte Range
 * probe through `options.fetch` (its Content-Type for XML/JSON, else magic
 * bytes). A file is read by its magic bytes; several files are a DICOM folder
 * (`openSlide` still lists TIFFs among them).
 */
export async function sniffSlide(
  input: string | File | readonly File[],
  options: Pick<OpenSlideOptions, 'fetch' | 'signal'> = {},
): Promise<SlideKind> {
  if (typeof input !== 'string') {
    const files: readonly File[] = input instanceof File ? [input] : input
    const first = files[0]
    if (!first) throw new Error('No files')
    if (files.length > 1) return 'dicom'
    return (await kindOfFile(first)) ?? 'dicom' // the index names what it skipped
  }
  const path = new URL(input, globalThis.location?.href).pathname
  if (/\.zarr(\/|$)|\/$/i.test(path)) return 'zarr'
  if (/\.dzi$/i.test(path)) return 'dzi'
  if (/\.json$/i.test(path)) return 'manifest'
  if (/\.(svs|tiff?|btf|bif|scn|avs|ndpi|qptiff|ome\.tiff?)$/i.test(path))
    return 'tiff'
  const response = await slideFetch(options.fetch)(input, {
    headers: { Range: PROBE },
    signal: options.signal,
  })
  const type = response.headers.get('content-type') ?? ''
  const reader = response.body?.getReader()
  const head = new Uint8Array(132)
  let n = 0
  try {
    while (reader && n < head.length) {
      const { done, value } = await reader.read()
      if (done) break
      head.set(value.subarray(0, head.length - n), n)
      n += value.byteLength
    }
  } finally {
    await reader?.cancel()
  }
  if (!response.ok) throw new Error(`${input}: HTTP ${response.status}`)
  const kind = kindOfBytes(head)
  if (kind) return kind
  if (/json/i.test(type) || head[0] === 0x7b) return 'manifest'
  if (/xml/i.test(type) || head[0] === 0x3c) return 'dzi'
  throw new Error(`${input}: not a TIFF, DICOM, DZI, Zarr or manifest`)
}

const fileName = (url: string) =>
  url
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop() || url

/**
 * The slides `input` holds: a URL (TIFF, OME-Zarr, DZI or a hosted manifest),
 * or local files: TIFFs and DICOM-WSI files (a folder pick or drop), mixed.
 * Lists every slide and opens none; `candidates[i].open()` makes a source for
 * `NVSlide.fromSource`. A DICOM folder lists each optical path and focal plane;
 * its label, overview and thumbnail images are in `index`, never candidates.
 * A dual-personality DICOM-TIFF file is listed both ways.
 */
export async function openSlide(
  input: string | File | readonly File[],
  options: OpenSlideOptions = {},
): Promise<OpenedSlides> {
  if (typeof input === 'string') {
    const kind = await sniffSlide(input, options)
    const url = new URL(input, globalThis.location?.href).href
    return {
      kind,
      candidates: [
        {
          kind,
          label: fileName(url),
          open: (s) => openUrl(kind, url, options, s),
        },
      ],
    }
  }
  const files: readonly File[] = input instanceof File ? [input] : input
  if (!files.length) throw new Error('No files')
  const kinds = await Promise.all(files.map(kindOfFile))
  options.signal?.throwIfAborted()
  const tiffAt = files.flatMap((_, i) =>
    kinds[i] === 'tiff' || kinds[i] === 'dicom-tiff' ? [i] : [],
  )
  const tiffs = tiffAt.map((i) => tiffCandidate(files[i] as File, options))
  const dicomAt = files.flatMap((_, i) => (kinds[i] === 'tiff' ? [] : [i]))
  const dicom = dicomAt.map((i) => files[i] as File)
  if (!dicom.length) return { kind: 'tiff', candidates: tiffs }
  const [{ indexDicomWsiKeyed }, { DicomWsiSource }, { fileKeys, firstInput }] =
    await Promise.all([
      import('./indexDicomWsi'),
      import('./dicomWsiSource'),
      import('./dicomIndex'),
    ])
  // Keyed over the whole input, so the caller reads associated images and
  // opens slides against the files it passed, TIFFs among them.
  const keys = fileKeys(files)
  const index = await indexDicomWsiKeyed(
    dicom,
    dicomAt.map((i) => keys[i] as string),
    {
      signal: options.signal,
      onProgress: options.onProgress,
    },
  )
  const slides = index.slides.map(
    (slide): SlideCandidate => ({
      kind: 'dicom',
      label: `${slide.container ?? slide.series} path ${slide.opticalPath} z ${slide.focalPlane}`,
      slide,
      open: async (s) => {
        anySignal(options.signal, s)?.throwIfAborted()
        return described(
          new DicomWsiSource(slide, files, {
            attribution: options.attribution,
          }),
          slide.container ?? slide.series,
          'dicom',
          { local: true },
        )
      },
    }),
  )
  // Input order: a slide ranks by its first file.
  const at = new Map(keys.map((k, i) => [k, i]))
  const ranked = [
    ...slides.map((c, s) => ({
      c,
      rank: firstInput(index.slides[s] as SlideIndex['slides'][number], at),
    })),
    ...tiffs.map((c, t) => ({ c, rank: tiffAt[t] as number })),
  ].sort((a, b) => a.rank - b.rank)
  return {
    kind: slides.length || !tiffs.length ? 'dicom' : 'tiff',
    candidates: ranked.map((r) => r.c),
    index,
  }
}

function tiffCandidate(file: File, options: OpenSlideOptions): SlideCandidate {
  return {
    kind: 'tiff',
    label: file.name,
    open: async (s) => {
      const signal = anySignal(options.signal, s)
      const [{ fromBlob }, { TiffSlideSource }] = await Promise.all([
        import('@niivue/geotiff-rs'),
        import('./tiff'),
      ])
      signal?.throwIfAborted()
      const tiff = await fromBlob(file)
      try {
        return described(
          await TiffSlideSource.fromGeoTIFF(tiff, {
            id: file.name,
            ...options.tiff,
            pool: options.pool,
            attribution: options.attribution,
            signal,
          }),
          file.webkitRelativePath || file.name,
          'tiff',
          options.tiff?.placement === false
            ? { local: true, placement: false }
            : { local: true },
        )
      } catch (err) {
        // Not adopted by a source: closed here.
        Promise.resolve(tiff.close()).catch(() => {})
        throw err
      }
    },
  }
}

async function openUrl(
  kind: SlideKind,
  url: string,
  options: OpenSlideOptions,
  s?: AbortSignal,
): Promise<SlideTileSource> {
  const extra: Parameters<typeof described>[3] = {}
  if (
    (kind === 'tiff' || kind === 'dicom-tiff') &&
    options.tiff?.placement === false
  )
    extra.placement = false
  if (kind === 'manifest' && options.baseUrl) extra.baseUrl = options.baseUrl
  return described(await openSource(kind, url, options, s), url, kind, extra)
}

async function openSource(
  kind: SlideKind,
  url: string,
  {
    fetch: fetchImpl,
    pool,
    baseUrl,
    attribution,
    tiff,
    signal: s0,
  }: OpenSlideOptions,
  s?: AbortSignal,
): Promise<SlideTileSource> {
  const signal = anySignal(s0, s)
  switch (kind) {
    case 'zarr': {
      const { ZarrSlideSource } = await import('./zarr/zarrSlideSource')
      return ZarrSlideSource.fromUrl(url, {
        signal,
        // The loader passes a plain init, so a spreading wrapper keeps Range and signal.
        fetch: fetchImpl,
      })
    }
    case 'dzi':
      // DziSource reads its tiles with the global fetch.
      if (fetchImpl) throw new Error(`${url}: DZI takes no custom fetch`)
      return DziSource.fromUrl(url, undefined, signal)
    case 'manifest': {
      const response = await slideFetch(fetchImpl)(url, { signal })
      const manifest = JSON.parse(
        new TextDecoder().decode(await readCapped(response, 'Slide manifest')),
      )
      // A manifest is untrusted: its own attribution is cleaned too.
      const credit = cleanAttribution(attribution ?? manifest.attribution)
      return new ManifestRangeSource(
        { ...manifest, attribution: credit },
        { fetch: fetchImpl, manifestUrl: url, baseUrl: baseUrl ?? url },
      )
    }
    default: {
      // A DICOM file served alone has no tile index to read by Range.
      if (kind === 'dicom')
        throw new Error(`${url}: a DICOM file by URL; host a manifest instead`)
      const { TiffSlideSource } = await import('./tiff')
      return TiffSlideSource.fromUrl(url, {
        ...tiff,
        fetch: fetchImpl,
        pool,
        signal,
        attribution,
      })
    }
  }
}
