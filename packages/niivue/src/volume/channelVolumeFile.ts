/**
 * Wrap one assembled microscopy channel as a NIfTI `File` ready for
 * `loadVolumes`.
 *
 * The volume is centred on the origin so every channel (and every pyramid
 * level) of a dataset shares one world position regardless of which subset
 * was loaded. Shared by the Allen atlas, OME-TIFF and OME-Zarr channel
 * loaders so the three cannot drift on the affine convention.
 */

import type { TypedVoxelArray } from '@/NVTypes'
import { createNiftiArray } from './utils'

/** The origin-centred affine (flat row-major 4x4) for a `dims` voxel grid. */
export function centeredAffine(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
): number[] {
  const [nx, ny, nz] = dims
  const [sx, sy, sz] = spacing
  return [
    sx,
    0,
    0,
    -(nx - 1) * 0.5 * sx,
    0,
    sy,
    0,
    -(ny - 1) * 0.5 * sy,
    0,
    0,
    sz,
    -(nz - 1) * 0.5 * sz,
    0,
    0,
    0,
    1,
  ]
}

/** One channel's voxels as an origin-centred NIfTI named `${name}.nii`. */
export function channelVolumeFile(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  datatypeCode: number,
  img: TypedVoxelArray,
  name: string,
): File {
  const bytes = createNiftiArray(
    [dims[0], dims[1], dims[2]],
    [spacing[0], spacing[1], spacing[2]],
    centeredAffine(dims, spacing),
    datatypeCode,
    img,
  )
  return new File([bytes], `${name}.nii`, { type: 'application/octet-stream' })
}
