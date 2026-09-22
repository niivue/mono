/**
 * Load an OME-TIFF as one NiiVue volume PER CHANNEL.
 *
 * The `.tif`/`.tiff` volume reader returns a single volume, which is the right
 * answer for a plain stack but throws away every channel but the first of a
 * multi-channel acquisition. This returns a list of load options instead, so
 * callers hand the whole list to `loadVolumes`:
 *
 * ```ts
 * const channels = await loadOmeTiffVolumes(url, { channels: [0, 2] })
 * await nv.loadVolumes(channels)
 * ```
 *
 * The container parse lives in `tiff.ts`, the OME-XML parse in `omeTiff.ts`
 * and the plane stacking in `tiffVolume.ts`. See `docs/ome-tiff-format.md`.
 */

import { maybeDecompress } from '@/codecs/NVGz'
import type { ImageFromUrlOptions } from '@/NVTypes'
import { channelColormapFor } from './channelColormaps'
import { channelVolumeFile } from './channelVolumeFile'
import type { OmeTiffInfo } from './omeTiff'
import { parseTiff } from './tiff'
import {
  describeTiff,
  readTiffVolume,
  type TiffSource,
  type TiffVolume,
  tiffChannelCount,
  tiffChannelName,
} from './tiffVolume'

/** Options for {@link loadOmeTiffVolumes}. */
export interface OmeTiffLoadOptions {
  /**
   * Channel indices to load, in the order the volumes should be returned.
   * Defaults to every channel.
   */
  channels?: number[]
  /** Timepoint to load. Defaults to the first. */
  timepoint?: number
  /** Override the fetcher, e.g. to add credentials or a cache. */
  fetchImpl?: typeof fetch
}

/**
 * Colormap for one channel: the closest hue to the OME `Color` attribute when
 * the file states one, else the next entry in the shared palette.
 */
export function omeTiffChannelColormap(
  info: OmeTiffInfo | null,
  channel: number,
  order: number,
): string {
  return channelColormapFor(info?.channels[channel]?.color, order)
}

/**
 * Wrap an assembled channel as a NIfTI `File` ready for `loadVolumes`,
 * origin-centred like every microscopy channel loader (`tiffVolumeAffine` is
 * the same centred affine `channelVolumeFile` builds).
 */
export function omeTiffChannelFile(volume: TiffVolume, name: string): File {
  return channelVolumeFile(
    volume.dims,
    volume.spacingUm,
    volume.datatypeCode,
    volume.img,
    name,
  )
}

/**
 * Fetch and parse an OME-TIFF's directories and metadata without decoding any
 * pixels.
 *
 * Useful on its own for building a channel picker before committing to the
 * (much larger) decode.
 */
export async function fetchOmeTiff(
  url: string,
  options: Pick<OmeTiffLoadOptions, 'fetchImpl'> = {},
): Promise<TiffSource> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(
      `OME-TIFF: ${url} returned ${response.status} ${response.statusText}`,
    )
  }
  const raw = await maybeDecompress(await response.arrayBuffer())
  return describeTiff(parseTiff(raw))
}

/**
 * Load the requested channels of an OME-TIFF.
 *
 * The file is fetched and its directories parsed ONCE; each channel then
 * decodes only its own planes.
 */
export async function loadOmeTiffVolumes(
  url: string,
  options: OmeTiffLoadOptions = {},
): Promise<ImageFromUrlOptions[]> {
  const source = await fetchOmeTiff(url, options)
  return omeTiffVolumesFrom(source, options)
}

/**
 * Build the per-channel load options from an already-parsed OME-TIFF.
 *
 * Split out from {@link loadOmeTiffVolumes} so a caller that fetched the file
 * itself (to show a channel picker) does not have to download it twice.
 */
export async function omeTiffVolumesFrom(
  source: TiffSource,
  options: OmeTiffLoadOptions = {},
): Promise<ImageFromUrlOptions[]> {
  const total = tiffChannelCount(source)
  const wanted =
    options.channels ?? Array.from({ length: total }, (_unused, i) => i)
  // Validate up front so a bad index fails before any decode work.
  for (const channel of wanted) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= total) {
      throw new Error(
        `OME-TIFF: channel ${channel} is out of range (file has ${total})`,
      )
    }
  }

  const volumes: ImageFromUrlOptions[] = []
  for (const [order, channel] of wanted.entries()) {
    const volume = await readTiffVolume(source, {
      channel,
      timepoint: options.timepoint ?? 0,
    })
    const name = tiffChannelName(source, channel)
    volumes.push({
      url: omeTiffChannelFile(volume, name),
      name,
      colormap: omeTiffChannelColormap(source.ome, channel, order),
    })
  }
  return volumes
}
