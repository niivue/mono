/**
 * Stack TIFF planes into a NiiVue volume.
 *
 * Shared by the `.tif`/`.tiff` volume reader (which builds one `{hdr, img}`)
 * and by `omeTiffLoader.ts` (which builds one volume per channel), so the two
 * cannot drift on plane ordering, datatype mapping or spacing.
 *
 * Spacing is in MICROMETRES, matching `allenAtlasSpacing` and OME's own
 * default `PhysicalSize` unit. See `docs/ome-tiff-format.md`.
 */

import { log } from '@/logger'
import { NiiDataType } from '@/NVConstants'
import type { TypedVoxelArray } from '@/NVTypes'
import {
  type ImageJStackInfo,
  type OmeTiffInfo,
  omeChannelName,
  omeEffectiveSizeC,
  omePlaneCount,
  omePlaneIndex,
  parseImageJDescription,
  parseOmeXml,
} from './omeTiff'
import {
  readTiffImage,
  SAMPLE_FORMAT,
  TIFF_TAG,
  type TiffFile,
  type TiffImage,
  tagValue,
  tiffImageDescription,
  tiffResolutionMm,
} from './tiff'

/** A parsed TIFF plus whatever higher-level metadata rode in it. */
export interface TiffSource {
  tiff: TiffFile
  /** OME-XML metadata, or null for a plain TIFF. */
  ome: OmeTiffInfo | null
  /** ImageJ stack description, or null when absent. */
  imagej: ImageJStackInfo | null
}

/** Which sub-volume of a multi-channel, multi-timepoint TIFF to build. */
export interface TiffVolumeSelection {
  /** Channel index. Ignored when the file describes a single channel. */
  channel?: number
  /** Timepoint index. Ignored when the file describes a single timepoint. */
  timepoint?: number
}

/** One assembled volume, ready to become a NIfTI. */
export interface TiffVolume {
  name: string
  dims: [number, number, number]
  /** Voxel size in micrometres. */
  spacingUm: [number, number, number]
  datatypeCode: number
  bitsPerVoxel: number
  img: TypedVoxelArray
}

/** Read the container and any metadata block its first IFD carries. */
export function describeTiff(tiff: TiffFile): TiffSource {
  const description = tiffImageDescription(tiff)
  return {
    tiff,
    ome: parseOmeXml(description),
    imagej: parseImageJDescription(description),
  }
}

/** Number of channels the file describes. */
export function tiffChannelCount(source: TiffSource): number {
  if (source.ome) {
    return omeEffectiveSizeC(source.ome)
  }
  return source.imagej?.channels ?? 1
}

/** Number of timepoints the file describes. */
export function tiffTimepointCount(source: TiffSource): number {
  if (source.ome) {
    return source.ome.sizeT
  }
  return source.imagej?.frames ?? 1
}

/** Human-readable name for a channel. */
export function tiffChannelName(source: TiffSource, channel: number): string {
  if (source.ome) {
    return omeChannelName(source.ome, channel)
  }
  return tiffChannelCount(source) > 1 ? `Channel ${channel}` : 'TIFF'
}

/**
 * IFD indices, in z order, for one (channel, timepoint) of the file.
 *
 * OME states its own `DimensionOrder`. An ImageJ hyperstack is always written
 * XYCZT. A plain TIFF is just every IFD in file order.
 */
export function tiffPlaneIndices(
  source: TiffSource,
  selection: TiffVolumeSelection = {},
): number[] {
  const nIfds = source.tiff.ifds.length
  const channel = selection.channel ?? 0
  const timepoint = selection.timepoint ?? 0
  const validateSelection = (
    value: number,
    count: number,
    name: string,
  ): void => {
    if (!Number.isInteger(value) || value < 0 || value >= count) {
      throw new Error(
        `OME-TIFF: ${name} ${value} is out of range (file has ${count})`,
      )
    }
  }
  if (source.ome) {
    const info = source.ome
    validateSelection(channel, omeEffectiveSizeC(info), 'channel')
    validateSelection(timepoint, info.sizeT, 'timepoint')
    if (omePlaneCount(info) > nIfds) {
      // A pyramidal or multi-file OME-TIFF splits its planes across companion
      // files; the plane map here only covers this file's IFDs.
      log.warn(
        `OME-TIFF: metadata describes ${omePlaneCount(info)} planes but the file has ${nIfds} IFDs`,
      )
    }
    const indices: number[] = []
    for (let z = 0; z < info.sizeZ; z++) {
      const index = omePlaneIndex(info, z, channel, timepoint)
      if (index < nIfds) {
        indices.push(index)
      }
    }
    if (indices.length === 0) {
      throw new Error(
        'OME-TIFF: the requested channel has no planes in this file',
      )
    }
    return indices
  }
  const imagej = source.imagej
  if (imagej && (imagej.channels > 1 || imagej.frames > 1)) {
    validateSelection(channel, imagej.channels, 'channel')
    validateSelection(timepoint, imagej.frames, 'timepoint')
    const slices = imagej.slices > 0 ? imagej.slices : nIfds
    const indices: number[] = []
    for (let z = 0; z < slices; z++) {
      // ImageJ hyperstacks are XYCZT: channel varies fastest.
      const index =
        channel + z * imagej.channels + timepoint * imagej.channels * slices
      if (index < nIfds) {
        indices.push(index)
      }
    }
    if (indices.length > 0) {
      return indices
    }
  }
  return Array.from({ length: nIfds }, (_unused, i) => i)
}

/** Map a decoded sample description onto a NIfTI datatype. */
function scalarDatatype(image: TiffImage): { code: number; bits: number } {
  const { bitsPerSample, sampleFormat } = image
  if (sampleFormat === SAMPLE_FORMAT.float) {
    return {
      code:
        bitsPerSample === 64 ? NiiDataType.DT_FLOAT64 : NiiDataType.DT_FLOAT32,
      bits: bitsPerSample,
    }
  }
  if (sampleFormat === SAMPLE_FORMAT.int) {
    if (bitsPerSample === 8) return { code: NiiDataType.DT_INT8, bits: 8 }
    if (bitsPerSample === 16) return { code: NiiDataType.DT_INT16, bits: 16 }
    return { code: NiiDataType.DT_INT32, bits: 32 }
  }
  if (bitsPerSample === 8) return { code: NiiDataType.DT_UINT8, bits: 8 }
  if (bitsPerSample === 16) return { code: NiiDataType.DT_UINT16, bits: 16 }
  return { code: NiiDataType.DT_UINT32, bits: 32 }
}

/**
 * Voxel size in micrometres.
 *
 * OME physical sizes win. Otherwise the in-plane size comes from the
 * `XResolution`/`YResolution` tags (only meaningful when `ResolutionUnit` is a
 * real length) and the z step from an ImageJ `spacing` field. Any axis still
 * unknown falls back to the in-plane size rather than to 1, so a stack of
 * sub-micron pixels does not render as a stack of 1 um slabs.
 */
function resolveSpacing(
  source: TiffSource,
  planeCount: number,
): [number, number, number] {
  let x = source.ome?.spacingUm[0] ?? 0
  let y = source.ome?.spacingUm[1] ?? 0
  let z = source.ome?.spacingUm[2] ?? 0
  if (x === 0 || y === 0) {
    const resolution = tiffResolutionMm(source.tiff.ifds[0])
    if (resolution) {
      // `tiffResolutionMm` reports mm; this module works in micrometres.
      if (x === 0) x = resolution.x * 1000
      if (y === 0) y = resolution.y * 1000
    }
  }
  if (z === 0 && source.imagej) {
    z = source.imagej.spacingUm
  }
  if (x === 0 && y === 0) {
    x = 1
    y = 1
  }
  if (x === 0) x = y
  if (y === 0) y = x
  if (z === 0) z = planeCount > 1 ? Math.max(x, y) : x
  return [x, y, z]
}

/**
 * Assemble the selected planes into a single volume.
 *
 * A plane with 3 or 4 8-bit samples becomes an RGBA volume (matching the 2-D
 * image reader); anything else uses sample 0, because a multi-sample
 * scientific plane is a channel stack, not a colour.
 */
export async function readTiffVolume(
  source: TiffSource,
  selection: TiffVolumeSelection = {},
): Promise<TiffVolume> {
  const planes = tiffPlaneIndices(source, selection)
  const first = await readTiffImage(source.tiff, planes[0])
  const { width, height, samplesPerPixel } = first
  const isRgb = samplesPerPixel >= 3 && first.bitsPerSample === 8
  const voxels = width * height
  const nz = planes.length

  const datatype = isRgb
    ? { code: NiiDataType.DT_RGBA32, bits: 32 }
    : scalarDatatype(first)
  const componentsOut = isRgb ? 4 : 1
  const img = isRgb
    ? new Uint8Array(voxels * nz * 4)
    : new (first.data.constructor as new (n: number) => TypedVoxelArray)(
        voxels * nz,
      )

  for (let z = 0; z < nz; z++) {
    const image = z === 0 ? first : await readTiffImage(source.tiff, planes[z])
    if (image.width !== width || image.height !== height) {
      throw new Error(
        `TIFF: plane ${planes[z]} is ${image.width}x${image.height}, expected ${width}x${height}`,
      )
    }
    if (
      image.bitsPerSample !== first.bitsPerSample ||
      image.sampleFormat !== first.sampleFormat ||
      image.samplesPerPixel !== samplesPerPixel
    ) {
      throw new Error(`TIFF: plane ${planes[z]} has a different sample layout`)
    }
    const base = z * voxels * componentsOut
    if (isRgb) {
      const out = img as Uint8Array
      const src = image.data
      const hasAlpha = samplesPerPixel >= 4
      for (let i = 0; i < voxels; i++) {
        const from = i * samplesPerPixel
        const to = base + i * 4
        out[to] = src[from]
        out[to + 1] = src[from + 1]
        out[to + 2] = src[from + 2]
        out[to + 3] = hasAlpha ? src[from + 3] : 255
      }
    } else if (samplesPerPixel === 1) {
      img.set(image.data as never, base)
    } else {
      for (let i = 0; i < voxels; i++) {
        img[base + i] = image.data[i * samplesPerPixel]
      }
    }
  }

  return {
    name: source.ome?.imageName ?? 'TIFF',
    dims: [width, height, nz],
    spacingUm: resolveSpacing(source, nz),
    datatypeCode: datatype.code,
    bitsPerVoxel: datatype.bits,
    img,
  }
}

/**
 * A centred affine for a TIFF volume.
 *
 * Centring on the origin means every channel of one dataset shares a world
 * position regardless of which subset was loaded, matching the Allen loader.
 */
export function tiffVolumeAffine(volume: TiffVolume): number[][] {
  const [sx, sy, sz] = volume.spacingUm
  const [nx, ny, nz] = volume.dims
  return [
    [sx, 0, 0, -(nx - 1) * 0.5 * sx],
    [0, sy, 0, -(ny - 1) * 0.5 * sy],
    [0, 0, sz, -(nz - 1) * 0.5 * sz],
    [0, 0, 0, 1],
  ]
}

/** True when the container advertises tiles, which pyramidal slides use. */
export function tiffIsTiled(tiff: TiffFile): boolean {
  return tagValue(tiff.ifds[0], TIFF_TAG.tileWidth) !== undefined
}
