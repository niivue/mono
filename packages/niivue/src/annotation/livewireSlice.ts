// Extract the current 2D slice into a voxel-grid image for the live-wire tool,
// with the coordinate mapping between the annotation slice-2D (mm) space and the
// grid. The grid is the volume's in-plane voxel lattice at the slice depth, so
// the live-wire snaps at native resolution and maps cleanly back to annotation
// coords. Mirrors the mm<->voxel plumbing in stats.ts.

import { mat4, vec4 } from 'gl-matrix'
import { sliceTypeDim } from '@/NVConstants'
import type { AnnotationPoint, NVImage } from '@/NVTypes'
import { getVoxelValue } from '@/volume/utils'
import { buildLivewireCost } from './livewire'
import { IN_PLANE_AXES, mmToSlice2D, slice2DToMM } from './sliceProjection'

export type LivewireSlice = {
  image: Float32Array
  /** Per-pixel traversal cost (low on edges), for the Dijkstra field. */
  cost: Float32Array
  width: number
  height: number
  ax0: number
  ax1: number
  depthDim: number
  depthVox: number
  sliceType: number
  slicePosition: number
  mm2vox: mat4
  vox2mm: mat4
}

/**
 * Build the live-wire grid for the current slice: the in-plane voxel image at
 * `slicePosition`'s depth, plus the transforms to map annotation coords to/from
 * grid pixels. Returns null if the volume lacks the needed geometry or the slice
 * is out of range.
 */
export function extractLivewireSlice(
  volume: NVImage,
  sliceType: number,
  slicePosition: number,
): LivewireSlice | null {
  if (!volume.dimsRAS || !volume.matRAS) return null
  const dims = volume.dimsRAS
  const depthDim = sliceTypeDim(sliceType)
  const [ax0, ax1] = IN_PLANE_AXES[sliceType] as [number, number]

  const vox2mm = mat4.clone(volume.matRAS)
  mat4.transpose(vox2mm, vox2mm)
  const mm2vox = mat4.create()
  mat4.invert(mm2vox, vox2mm)

  const v = vec4.create()
  const depthMM = slice2DToMM({ x: 0, y: 0 }, slicePosition, sliceType)
  vec4.set(v, depthMM[0], depthMM[1], depthMM[2], 1)
  vec4.transformMat4(v, v, mm2vox)
  const depthVox = Math.round(v[depthDim])
  if (depthVox < 0 || depthVox >= dims[depthDim + 1]) return null

  const width = dims[ax0 + 1]
  const height = dims[ax1 + 1]
  const image = new Float32Array(width * height)
  const ras: [number, number, number] = [0, 0, 0]
  ras[depthDim] = depthVox
  for (let j = 0; j < height; j++) {
    ras[ax1] = j
    for (let i = 0; i < width; i++) {
      ras[ax0] = i
      image[j * width + i] = getVoxelValue(volume, ras[0], ras[1], ras[2])
    }
  }

  return {
    image,
    cost: buildLivewireCost(image, width, height),
    width,
    height,
    ax0,
    ax1,
    depthDim,
    depthVox,
    sliceType,
    slicePosition,
    mm2vox,
    vox2mm,
  }
}

/** Annotation slice-2D point -> grid pixel (clamped to the image), or null. */
export function slice2DToGrid(
  slice: LivewireSlice,
  pt: AnnotationPoint,
): { x: number; y: number } {
  const mm = slice2DToMM(pt, slice.slicePosition, slice.sliceType)
  const v = vec4.fromValues(mm[0], mm[1], mm[2], 1)
  vec4.transformMat4(v, v, slice.mm2vox)
  const x = Math.min(slice.width - 1, Math.max(0, Math.round(v[slice.ax0])))
  const y = Math.min(slice.height - 1, Math.max(0, Math.round(v[slice.ax1])))
  return { x, y }
}

/** Grid pixel -> annotation slice-2D point (mm). */
export function gridToSlice2D(
  slice: LivewireSlice,
  gx: number,
  gy: number,
): AnnotationPoint {
  const ras: [number, number, number] = [0, 0, 0]
  ras[slice.ax0] = gx
  ras[slice.ax1] = gy
  ras[slice.depthDim] = slice.depthVox
  const v = vec4.fromValues(ras[0], ras[1], ras[2], 1)
  vec4.transformMat4(v, v, slice.vox2mm)
  return mmToSlice2D([v[0], v[1], v[2]], slice.sliceType)
}
