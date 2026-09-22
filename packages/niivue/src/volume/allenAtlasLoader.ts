/**
 * Load an Allen "volume-viewer" JSON + PNG atlas dataset as NiiVue volumes.
 *
 * One sidecar yields one volume PER CHANNEL, so this returns a list of load
 * options rather than a single volume, and callers hand the whole list to
 * `loadVolumes`:
 *
 * ```ts
 * const channels = await loadAllenAtlasVolumes(sidecarUrl, { channels: [0, 3] })
 * await nv.loadVolumes(channels)
 * ```
 *
 * The parse/deinterleave logic lives in `allenAtlas.ts`; this module adds
 * fetching, PNG decoding and NIfTI assembly. See `docs/allen-atlas-format.md`.
 */

import { NiiDataType } from '@/NVConstants'
import type { ImageFromUrlOptions } from '@/NVTypes'
import {
  type AllenAtlasInfo,
  allenAtlasSpacing,
  allenAtlasVolumeDims,
  deinterleaveAllenAtlasPlane,
  findAllenAtlasChannel,
  parseAllenAtlasInfo,
} from './allenAtlas'
import { channelColormapFor } from './channelColormaps'
import { channelVolumeFile } from './channelVolumeFile'
import { type DecodedImage, decodeImageRGBA } from './imageDecode'

/**
 * Colormap for one channel: the closest hue to the sidecar's `channel_colors`
 * entry when it has one, else the next colour in the shared palette so that
 * channels loaded together do not collide.
 */
export function allenAtlasChannelColormap(
  info: AllenAtlasInfo,
  channel: number,
  order: number,
): string {
  return channelColormapFor(info.channelColors[channel], order)
}

/**
 * Assemble one deinterleaved channel into a NIfTI `File`, origin-centred like
 * every microscopy channel loader (see `channelVolumeFile.ts`).
 */
export function allenAtlasChannelFile(
  info: AllenAtlasInfo,
  img: Uint8Array,
  name: string,
): File {
  return channelVolumeFile(
    allenAtlasVolumeDims(info),
    allenAtlasSpacing(info),
    NiiDataType.DT_UINT8,
    img,
    name,
  )
}

/** Options for {@link loadAllenAtlasVolumes}. */
export interface AllenAtlasLoadOptions {
  /**
   * Channel indices to load, in the order the volumes should be returned.
   * Defaults to every channel, which for a 32-channel dataset is a large load,
   * so callers showing a picker should pass an explicit subset.
   */
  channels?: number[]
  /** Override the fetcher, e.g. to add credentials or a cache. */
  fetchImpl?: typeof fetch
  /** Override PNG decoding, e.g. to decode in a worker. */
  decodeImage?: (buffer: ArrayBuffer) => Promise<DecodedImage>
}

/**
 * Resolve an atlas image name against the sidecar URL. Pages usually pass a
 * RELATIVE sidecar URL ("data/atlas.json"), which `new URL` rejects as a base,
 * so resolve through the page location when there is one; failing that, swap
 * the sidecar's final path segment for the image name.
 */
function resolveAtlasImageUrl(imageName: string, sidecarUrl: string): string {
  const pageHref = typeof location === 'undefined' ? undefined : location.href
  try {
    return new URL(
      imageName,
      pageHref ? new URL(sidecarUrl, pageHref) : sidecarUrl,
    ).href
  } catch {
    return sidecarUrl.replace(/[^/]*$/, imageName)
  }
}

async function fetchBuffer(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ArrayBuffer> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(
      `Allen atlas: ${url} returned ${response.status} ${response.statusText}`,
    )
  }
  return response.arrayBuffer()
}

/**
 * Fetch an Allen atlas sidecar and return its validated contents.
 *
 * Useful on its own for building a channel picker before committing to the
 * (much larger) atlas downloads.
 */
export async function fetchAllenAtlasInfo(
  sidecarUrl: string,
  options: Pick<AllenAtlasLoadOptions, 'fetchImpl'> = {},
): Promise<AllenAtlasInfo> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(sidecarUrl)
  if (!response.ok) {
    throw new Error(
      `Allen atlas: ${sidecarUrl} returned ${response.status} ${response.statusText}`,
    )
  }
  return parseAllenAtlasInfo(await response.json())
}

/**
 * Load the requested channels of an Allen atlas dataset.
 *
 * Each atlas PNG is fetched and decoded ONCE even when several requested
 * channels share it, because a single 2048x2048 decode is the dominant cost.
 */
export async function loadAllenAtlasVolumes(
  sidecarUrl: string,
  options: AllenAtlasLoadOptions = {},
): Promise<ImageFromUrlOptions[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const decode = options.decodeImage ?? decodeImageRGBA
  const info = await fetchAllenAtlasInfo(sidecarUrl, { fetchImpl })
  const wanted =
    options.channels ?? Array.from({ length: info.channels }, (_u, i) => i)

  // Resolve every channel up front so a bad index fails before any download.
  const requests = wanted.map((channel, order) => {
    const located = findAllenAtlasChannel(info, channel)
    if (!located) {
      throw new Error(`Allen atlas: no image carries channel ${channel}`)
    }
    return { channel, order, ...located }
  })

  const byImage = new Map<string, typeof requests>()
  for (const request of requests) {
    const group = byImage.get(request.image.name)
    if (group) {
      group.push(request)
    } else {
      byImage.set(request.image.name, [request])
    }
  }

  const volumes: ImageFromUrlOptions[] = new Array(requests.length)
  await Promise.all(
    Array.from(byImage, async ([imageName, group]) => {
      const url = resolveAtlasImageUrl(imageName, sidecarUrl)
      const decoded = await decode(await fetchBuffer(url, fetchImpl))
      if (
        decoded.width !== info.atlasWidth ||
        decoded.height !== info.atlasHeight
      ) {
        throw new Error(
          `Allen atlas: ${imageName} is ${decoded.width}x${decoded.height}, ` +
            `sidecar says ${info.atlasWidth}x${info.atlasHeight}`,
        )
      }
      for (const request of group) {
        const name = info.channelNames[request.channel]
        const img = deinterleaveAllenAtlasPlane(
          decoded.data,
          info,
          request.plane,
        )
        volumes[request.order] = {
          url: allenAtlasChannelFile(info, img, name),
          name,
          colormap: allenAtlasChannelColormap(
            info,
            request.channel,
            request.order,
          ),
        }
      }
    }),
  )
  return volumes
}
