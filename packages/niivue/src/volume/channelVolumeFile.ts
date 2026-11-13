/**
 * Wrap one assembled microscopy channel as a NIfTI `File` ready for
 * `loadVolumes`.
 *
 * By default the volume is centred on the origin so every channel (and every
 * pyramid level) of a dataset shares one world position regardless of which
 * subset was loaded (Allen atlas, OME-TIFF). OME-Zarr passes its own affine to
 * match its streamed volumes.
 */

import type { TypedVoxelArray } from '@/NVTypes'
import { createNiftiArray, NIFTI_UNITS_MICRON, withSpatialUnits } from './utils'

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

/**
 * One channel's voxels as a NIfTI named `${name}.nii`, with `spacing` in
 * micrometers and `xyzt_units` saying so. Origin-centred unless `affine`
 * (flat row-major 4x4) is given.
 */
export function channelVolumeFile(
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  datatypeCode: number,
  img: TypedVoxelArray,
  name: string,
  affine: number[] = centeredAffine(dims, spacing),
): File {
  const bytes = createNiftiArray(
    [dims[0], dims[1], dims[2]],
    [spacing[0], spacing[1], spacing[2]],
    affine,
    datatypeCode,
    img,
    withSpatialUnits(10, NIFTI_UNITS_MICRON), // um + sec
  )
  return new File([bytes], `${name}.nii`, { type: 'application/octet-stream' })
}
