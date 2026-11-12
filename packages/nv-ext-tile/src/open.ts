// One opener for every slide format this package reads. Each format's module
// is imported only when a slide of that format is opened, so this entry
// costs a DICOM-only page no TIFF or Zarr payload.
import type { Pool } from '@niivue/geotiff-rs'
import {
  DziSource,
  ManifestRangeSource,
  type NVSlideAttribution,
  type SlideTileSource,
} from '@niivue/niivue'
import { cleanAttribution } from './attribution'
import type { SlideIndex } from './dicomIndex'
import { anySignal, type SlideFetch } from './rangeFetch'
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
  open(signal?: AbortSignal): Promise<SlideTileSource>
}

export interface OpenedSlides {
  kind: SlideKind
  /** Every slide found, in input order; never chosen among here. */
  candidates: SlideCandidate[]
  /** DICOM: the index, with skipped files and associated images. */
  index?: SlideIndex
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
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(input, {
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
  const tiffs = files
    .filter((_, i) => kinds[i] === 'tiff' || kinds[i] === 'dicom-tiff')
    .map((file) => tiffCandidate(file, options))
  const dicom = files.filter((_, i) => kinds[i] !== 'tiff')
  if (!dicom.length) return { kind: 'tiff', candidates: tiffs }
  const [{ indexDicomWsi }, { DicomWsiSource }] = await Promise.all([
    import('./indexDicomWsi'),
    import('./dicomWsiSource'),
  ])
  const index = await indexDicomWsi(dicom, {
    signal: options.signal,
    onProgress: options.onProgress,
  })
  const slides = index.slides.map(
    (slide): SlideCandidate => ({
      kind: 'dicom',
      label: `${slide.container ?? slide.series} path ${slide.opticalPath} z ${slide.focalPlane}`,
      open: async (s) => {
        anySignal(options.signal, s)?.throwIfAborted()
        return new DicomWsiSource(slide, dicom, {
          attribution: options.attribution,
        })
      },
    }),
  )
  return {
    kind: slides.length || !tiffs.length ? 'dicom' : 'tiff',
    candidates: [...slides, ...tiffs],
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
        return await TiffSlideSource.fromGeoTIFF(tiff, {
          id: file.name,
          ...options.tiff,
          pool: options.pool,
          attribution: options.attribution,
          signal,
        })
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
        // A plain init, so a wrapper that spreads it keeps Range and signal.
        ...(fetchImpl && {
          fetch: (r: Request) =>
            fetchImpl(r.url, {
              method: r.method,
              headers: Object.fromEntries(r.headers),
              signal: r.signal,
              cache: r.cache,
            }),
        }),
      })
    }
    case 'dzi':
      // DziSource reads its tiles with the global fetch.
      if (fetchImpl) throw new Error(`${url}: DZI takes no custom fetch`)
      return DziSource.fromUrl(url, undefined, signal)
    case 'manifest': {
      const response = await (fetchImpl ?? fetch)(url, { signal })
      if (!response.ok)
        throw new Error(`Slide manifest HTTP ${response.status}`)
      const manifest = await response.json()
      // A manifest is untrusted: its own attribution is cleaned too.
      const credit = cleanAttribution(attribution ?? manifest.attribution)
      return new ManifestRangeSource(
        { ...manifest, attribution: credit },
        {
          // The caller's fetch only on the manifest's own origin (as DICOMweb
          // ICC): a tile file elsewhere is read without credentials.
          fetch:
            fetchImpl &&
            ((u, init) =>
              new URL(u).origin === new URL(url).origin
                ? fetchImpl(u, init)
                : fetch(u, { ...init, credentials: 'omit' })),
          baseUrl: baseUrl ?? url,
        },
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
