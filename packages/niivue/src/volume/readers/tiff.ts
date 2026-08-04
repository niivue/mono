import * as nifti from 'nifti-reader-js'
import { maybeDecompress } from '@/codecs/NVGz'
import { log } from '@/logger'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import { parseTiff } from '../tiff'
import {
  describeTiff,
  readTiffVolume,
  tiffChannelCount,
  tiffTimepointCount,
  tiffVolumeAffine,
} from '../tiffVolume'

export const extensions = ['tif', 'tiff']
export const type = 'nii'

/**
 * Read a TIFF, OME-TIFF or ImageJ stack as a single volume.
 *
 * Every IFD becomes one z plane. A multi-channel file yields its FIRST channel
 * only, because a volume reader returns one volume; load every channel as its
 * own volume with `loadOmeTiffVolumes` instead. Spacing is in micrometres -
 * see `docs/ome-tiff-format.md`.
 */
export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const raw = await maybeDecompress(buffer)
  const source = describeTiff(parseTiff(raw))
  const channels = tiffChannelCount(source)
  const timepoints = tiffTimepointCount(source)
  if (channels > 1) {
    log.warn(
      `TIFF has ${channels} channels; loading channel 0 only. Use loadOmeTiffVolumes to load them all.`,
    )
  }
  if (timepoints > 1) {
    log.warn(`TIFF has ${timepoints} timepoints; loading timepoint 0 only.`)
  }
  const volume = await readTiffVolume(source, { channel: 0, timepoint: 0 })

  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.littleEndian = true
  hdr.dims = [3, volume.dims[0], volume.dims[1], volume.dims[2], 1, 1, 1, 1]
  hdr.pixDims = [
    1,
    volume.spacingUm[0],
    volume.spacingUm[1],
    volume.spacingUm[2],
    1,
    0,
    0,
    0,
  ]
  hdr.affine = tiffVolumeAffine(volume)
  hdr.datatypeCode = volume.datatypeCode
  hdr.numBitsPerVoxel = volume.bitsPerVoxel
  hdr.description = volume.name.slice(0, 80)
  return { hdr, img: volume.img }
}
