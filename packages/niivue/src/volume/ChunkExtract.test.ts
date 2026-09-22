import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import {
  extractChunkBlock,
  extractSubVolume,
  subVolumeAffine,
} from './ChunkExtract'

/** Row-major 4x4: 2 mm isotropic, origin at (-10, -20, -30). */
const PARENT_AFFINE = [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 2, -30, 0, 0, 0, 1]

/**
 * A volume with just the fields the extractor and `getImageDataRAS` read.
 * Voxel [x,y,z] holds a unique value so a copy can be checked positionally.
 */
function makeParent(
  dims: [number, number, number],
  opts: {
    affine?: number[]
    sclSlope?: number
    sclInter?: number
  } = {},
): NVImage {
  const [dx, dy, dz] = dims
  const img = new Float32Array(dx * dy * dz)
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        img[x + y * dx + z * dx * dy] = x + y * 100 + z * 10000
      }
    }
  }
  return {
    img,
    dimsRAS: [3, dx, dy, dz],
    img2RASstep: [1, dx, dx * dy],
    img2RASstart: [0, 0, 0],
    matRAS: Float32Array.from(opts.affine ?? PARENT_AFFINE),
    calMin: 5,
    calMax: 500,
    hdr: { scl_slope: opts.sclSlope ?? 1, scl_inter: opts.sclInter ?? 0 },
  } as unknown as NVImage
}

describe('subVolumeAffine', () => {
  test('walks the origin forward and leaves rotation/scale untouched', () => {
    const child = subVolumeAffine(PARENT_AFFINE, [3, 4, 5])
    // Same 3x3 block.
    expect(child.slice(0, 3)).toEqual([2, 0, 0])
    expect(child.slice(4, 7)).toEqual([0, 2, 0])
    expect(child.slice(8, 11)).toEqual([0, 0, 2])
    // Origin moved by voxelOrigin * spacing.
    expect(child[3]).toBeCloseTo(-10 + 3 * 2, 6)
    expect(child[7]).toBeCloseTo(-20 + 4 * 2, 6)
    expect(child[11]).toBeCloseTo(-30 + 5 * 2, 6)
    expect(child.slice(12)).toEqual([0, 0, 0, 1])
  })

  test('an oblique parent stays oblique', () => {
    // A 30-degree rotation about z, 1 mm spacing, origin at the corner.
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const oblique = [c, -s, 0, 1, s, c, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]
    const child = subVolumeAffine(oblique, [10, 0, 0])
    expect(child.slice(0, 3)).toEqual([c, -s, 0])
    expect(child.slice(4, 7)).toEqual([s, c, 0])
    // Moving 10 voxels along i walks the origin along the ROTATED i axis.
    expect(child[3]).toBeCloseTo(1 + 10 * c, 6)
    expect(child[7]).toBeCloseTo(2 + 10 * s, 6)
    expect(child[11]).toBeCloseTo(3, 6)
  })

  test('a zero origin is a no-op', () => {
    expect(subVolumeAffine(PARENT_AFFINE, [0, 0, 0])).toEqual(PARENT_AFFINE)
  })
})

describe('extractSubVolume', () => {
  test('copies the requested box, not the whole volume', () => {
    const parent = makeParent([8, 8, 8])
    const sub = extractSubVolume(parent, [2, 3, 4], [2, 2, 2])
    expect(sub).not.toBeNull()
    if (!sub) return
    expect(sub.voxelOrigin).toEqual([2, 3, 4])
    expect(sub.voxelDims).toEqual([2, 2, 2])

    const voxels = new Float32Array(sub.nifti.buffer, 352, 8)
    // Block voxel [0,0,0] is parent voxel [2,3,4].
    expect(voxels[0]).toBe(2 + 3 * 100 + 4 * 10000)
    // Block voxel [1,0,0] is parent voxel [3,3,4].
    expect(voxels[1]).toBe(3 + 3 * 100 + 4 * 10000)
    // Block voxel [0,1,0] is parent voxel [2,4,4].
    expect(voxels[2]).toBe(2 + 4 * 100 + 4 * 10000)
    // Block voxel [0,0,1] is parent voxel [2,3,5].
    expect(voxels[4]).toBe(2 + 3 * 100 + 5 * 10000)
  })

  test('reports the block origin and centroid in the PARENT mm frame', () => {
    const parent = makeParent([8, 8, 8])
    const sub = extractSubVolume(parent, [2, 2, 2], [4, 4, 4])
    expect(sub).not.toBeNull()
    if (!sub) return
    // Voxel [2,2,2] of the parent: -10 + 2*2 = -6, etc.
    expect(sub.originMM[0]).toBeCloseTo(-6, 6)
    expect(sub.originMM[1]).toBeCloseTo(-16, 6)
    expect(sub.originMM[2]).toBeCloseTo(-26, 6)
    // Centre of a 4-voxel span sits 1.5 voxels (3 mm) in.
    expect(sub.centroidMM[0]).toBeCloseTo(-3, 6)
    expect(sub.centroidMM[1]).toBeCloseTo(-13, 6)
    expect(sub.centroidMM[2]).toBeCloseTo(-23, 6)
    expect(sub.spacingMM).toEqual([2, 2, 2])
  })

  test('bakes scl_slope / scl_inter so the parent window still applies', () => {
    const parent = makeParent([4, 4, 4], { sclSlope: 3, sclInter: 7 })
    const sub = extractSubVolume(parent, [1, 0, 0], [1, 1, 1])
    expect(sub).not.toBeNull()
    if (!sub) return
    const voxels = new Float32Array(sub.nifti.buffer, 352, 1)
    expect(voxels[0]).toBe(1 * 3 + 7)
    expect(sub.calMin).toBe(5)
    expect(sub.calMax).toBe(500)
  })

  test('clamps a box that overruns the parent', () => {
    const parent = makeParent([8, 8, 8])
    const sub = extractSubVolume(parent, [6, 6, 6], [4, 4, 4])
    expect(sub).not.toBeNull()
    if (!sub) return
    expect(sub.voxelOrigin).toEqual([6, 6, 6])
    expect(sub.voxelDims).toEqual([2, 2, 2])
  })

  test('clamps a negative origin, keeping the affine on the clamped corner', () => {
    const parent = makeParent([8, 8, 8])
    const sub = extractSubVolume(parent, [-3, -3, -3], [5, 5, 5])
    expect(sub).not.toBeNull()
    if (!sub) return
    expect(sub.voxelOrigin).toEqual([0, 0, 0])
    expect(sub.voxelDims).toEqual([2, 2, 2])
    expect(sub.originMM).toEqual([-10, -20, -30])
  })

  test('returns null for a box entirely outside the parent', () => {
    const parent = makeParent([8, 8, 8])
    expect(extractSubVolume(parent, [20, 0, 0], [4, 4, 4])).toBeNull()
    expect(extractSubVolume(parent, [0, 0, 0], [0, 4, 4])).toBeNull()
  })

  test('returns null without voxel data', () => {
    const parent = makeParent([4, 4, 4]) as unknown as Record<string, unknown>
    parent.img = undefined
    expect(
      extractSubVolume(parent as unknown as NVImage, [0, 0, 0], [2, 2, 2]),
    ).toBeNull()
  })

  test('writes the child affine into the emitted NIfTI sform', () => {
    const parent = makeParent([8, 8, 8])
    const sub = extractSubVolume(parent, [1, 2, 3], [2, 2, 2])
    expect(sub).not.toBeNull()
    if (!sub) return
    const view = new DataView(sub.nifti.buffer)
    expect(view.getInt16(42, true)).toBe(2) // dim[1]
    expect(view.getInt16(44, true)).toBe(2) // dim[2]
    expect(view.getInt16(46, true)).toBe(2) // dim[3]
    for (let i = 0; i < 12; i++) {
      expect(view.getFloat32(280 + 4 * i, true)).toBeCloseTo(sub.affine[i], 4)
    }
  })
})

describe('extractChunkBlock', () => {
  test('extracts a brick by its index in the chunk plan', () => {
    const parent = makeParent([8, 8, 8]) as unknown as Record<string, unknown>
    parent.chunkPlan = {
      chunks: [
        { voxelOrigin: [0, 0, 0], voxelDims: [4, 8, 8] },
        { voxelOrigin: [4, 0, 0], voxelDims: [4, 8, 8] },
      ],
    }
    const vol = parent as unknown as NVImage
    const sub = extractChunkBlock(vol, 1)
    expect(sub).not.toBeNull()
    if (!sub) return
    expect(sub.voxelOrigin).toEqual([4, 0, 0])
    expect(sub.voxelDims).toEqual([4, 8, 8])
    expect(sub.originMM[0]).toBeCloseTo(-10 + 4 * 2, 6)
    expect(extractChunkBlock(vol, 7)).toBeNull()
  })

  test('returns null when the volume is not chunked', () => {
    expect(extractChunkBlock(makeParent([4, 4, 4]), 0)).toBeNull()
  })
})
