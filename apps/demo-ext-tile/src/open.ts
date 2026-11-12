// Transitional open dispatch: which source reads a URL or a dropped file.
// ponytail: deleted when nv-ext-tile's `openSlide` / `sniffSlide` (lane A)
// merges; main.ts then calls those instead.
import { fromBlob, type Pool } from '@niivue/geotiff-rs'
import type {
  NVSlideAttribution,
  NVSlideOptions,
  SlideTileSource,
} from '@niivue/niivue'
import { DziSource, NVSlide } from '@niivue/niivue'
import { TiffSlideSource } from '@niivue/nv-ext-tile/tiff'
import { ZarrSlideSource } from '@niivue/nv-ext-tile/zarr'

export type Source = SlideTileSource & { attribution?: NVSlideAttribution }

/** A local file's kind from its first bytes. */
export async function sniffFile(
  file: File,
): Promise<'tiff' | 'dual' | 'dicom'> {
  const b = new Uint8Array(await file.slice(0, 132).arrayBuffer())
  // II*. / MM.* (TIFF) and II+. / MM.+ (BigTIFF)
  const tiff =
    (b[0] === 0x49 && b[1] === 0x49 && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0)
  // TIFF magic plus DICM at 128 is a dual-personality DICOM-TIFF, or a TIFF
  // whose padding holds those bytes: try DICOM, fall back to TIFF.
  const dicm = new TextDecoder().decode(b.subarray(128, 132)) === 'DICM'
  return tiff ? (dicm ? 'dual' : 'tiff') : 'dicom'
}

export const openTiffFile = async (file: File, pool: Pool): Promise<Source> =>
  TiffSlideSource.fromGeoTIFF(await fromBlob(file), { id: file.name, pool })

// zarr.json is OME-Zarr 0.5 (v3); a v2 store (.zattrs) shows no credit.
// ponytail: until the Zarr source fills manifest.attribution (lane B).
const fetchAttribution = (href: string, signal: AbortSignal) => {
  const u = new URL(href)
  u.pathname = u.pathname.replace(/\/*$/, '/zarr.json')
  return fetch(u, { signal })
    .then((r) => r.json())
    .then((j) => j.attributes?.attribution as NVSlideAttribution | undefined)
    .catch(() => undefined)
}

/**
 * The source for a URL: an OME-Zarr store (.zarr or a trailing /), Deep Zoom
 * (.dzi), a hosted DICOM-WSI manifest (.json, built as a slide here) or a
 * tiled TIFF.
 */
export async function openUrlSource(
  href: string,
  opts: {
    pool: Pool
    signal: AbortSignal
    slideOptions: NVSlideOptions
    /** Where a manifest's relative tile paths resolve (default the manifest URL). */
    manifestBase?: (href: string) => string
  },
): Promise<Source | NVSlide> {
  const { signal } = opts
  const path = new URL(href).pathname
  // A .zarr path or a directory (trailing /) is OME-Zarr; it must name the
  // store's group root, so a path to an array inside a store is refused.
  if (/\.zarr(\/|$)|\/$/.test(path)) {
    const [zarr, attribution] = await Promise.all([
      ZarrSlideSource.fromUrl(href, { signal }),
      fetchAttribution(href, signal),
    ])
    return Object.assign(zarr, { attribution })
  }
  if (/\.dzi$/i.test(path)) return DziSource.fromUrl(href, undefined, signal)
  // ponytail: a .json path is a hosted DICOM-WSI manifest; sniff if names lie.
  if (!path.endsWith('.json'))
    return TiffSlideSource.fromUrl(href, { pool: opts.pool, signal })
  const response = await fetch(href, { signal })
  if (!response.ok) throw new Error(`Slide manifest HTTP ${response.status}`)
  return new NVSlide(await response.json(), {
    ...opts.slideOptions,
    manifestUrl: opts.manifestBase?.(href) ?? href,
  })
}
