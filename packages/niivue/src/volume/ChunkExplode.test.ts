import { describe, expect, test } from 'bun:test'
import {
  chunkExplodedMatRAS,
  chunkExplodeOffsetFrac,
  explodedChunkAABB,
  explodeOffsetMMAtFrac,
  pickExplodedBlockFace,
  pickExplodedVoxel,
  rayBlockFacePointMM,
} from './ChunkExplode'
import { chunkVolume } from './chunking'

const IDENTITY_RAS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('ChunkExplode', () => {
  test('keeps compact chunks at scale 1', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 0, {
        enabled: true,
        scale: [1, 1, 1],
      }),
    ).toEqual([0, 0, 0])
  })

  test('offsets chunks around the grid center', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 0, {
        enabled: true,
        scale: [1.5, 1, 1],
      }),
    ).toEqual([-0.125, 0, 0])
    expect(
      chunkExplodeOffsetFrac(plan, 1, {
        enabled: true,
        scale: [1.5, 1, 1],
      }),
    ).toEqual([0.125, 0, 0])
  })

  test('translates matRAS in voxel space without changing scale', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    const mat = chunkExplodedMatRAS(plan, 1, IDENTITY_RAS, {
      enabled: true,
      scale: [1.5, 1, 1],
    })
    expect(Array.from(mat)).toEqual([
      1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ])
  })
})

describe('pickExplodedVoxel', () => {
  // 4 chunks along x (voxels [0,2),[2,4),[4,6),[6,8)); identity matRAS so mm =
  // voxel + explode shift. Scale 2 spreads the blocks to disjoint exploded x
  // ranges: chunk0 [-3,-1], chunk1 [1,3], chunk2 [5,7], chunk3 [9,11]; y,z [0,1].
  const plan = () => chunkVolume([8, 1, 1], 2, [0, 0, 0])
  const explode = {
    enabled: true,
    scale: [2, 2, 2] as [number, number, number],
  }

  test('returns null when explode is disabled', () => {
    expect(
      pickExplodedVoxel(
        plan(),
        IDENTITY_RAS,
        undefined,
        [6, 0.5, 5],
        [0, 0, -1],
      ),
    ).toBeNull()
  })

  test('a ray through a block picks that block', () => {
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [6, 0.5, 5],
      [0, 0, -1],
    )
    expect(hit?.chunkIndex).toBe(2)
    // recovered voxel lies in chunk 2's data region (x in [4,5])
    expect(hit?.voxel[0]).toBeGreaterThanOrEqual(4)
    expect(hit?.voxel[0]).toBeLessThanOrEqual(5)
  })

  test('picks a negative-x block (block 0)', () => {
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [-2, 0.5, 5],
      [0, 0, -1],
    )
    expect(hit?.chunkIndex).toBe(0)
    expect(hit?.voxel[0]).toBeGreaterThanOrEqual(0)
    expect(hit?.voxel[0]).toBeLessThanOrEqual(1)
  })

  test('a ray in the gap between blocks hits nothing', () => {
    // x = 0 is between block 0 ([-3,-1]) and block 1 ([1,3]).
    expect(
      pickExplodedVoxel(plan(), IDENTITY_RAS, explode, [0, 0.5, 5], [0, 0, -1]),
    ).toBeNull()
  })

  test('skips blocks not in the allowed (visible) set', () => {
    // The ray only crosses block 2's slab; excluding it from `allowed` (e.g. a
    // clip plane hid it) makes the pick miss rather than paint a hidden block.
    expect(
      pickExplodedVoxel(
        plan(),
        IDENTITY_RAS,
        explode,
        [6, 0.5, 5],
        [0, 0, -1],
        {
          allowed: new Set([0, 1, 3]),
        },
      ),
    ).toBeNull()
    // With block 2 allowed, it picks normally.
    expect(
      pickExplodedVoxel(
        plan(),
        IDENTITY_RAS,
        explode,
        [6, 0.5, 5],
        [0, 0, -1],
        {
          allowed: new Set([0, 1, 2, 3]),
        },
      )?.chunkIndex,
    ).toBe(2)
  })

  test('with a sampler, marches past empty space to the first opaque voxel', () => {
    // Single 8x8x8 chunk; only z<4 is "tissue". A -z ray entering at z=8 should
    // skip the empty front (z>=4) and land on the first tissue voxel (z<4),
    // not the bounding-box face at z=8.
    const p = chunkVolume([8, 8, 8], 16, [0, 0, 0])
    const sample = (_x: number, _y: number, z: number) => (z < 4 ? 1 : 0)
    const hit = pickExplodedVoxel(
      p,
      IDENTITY_RAS,
      { enabled: true, scale: [1.5, 1.5, 1.5] },
      [4, 4, 20],
      [0, 0, -1],
      { sample, threshold: 0.5 },
    )
    expect(hit).not.toBeNull()
    expect(hit?.voxel[2]).toBeLessThan(4) // skipped the empty z>=4 front
  })

  test('a sampler that is empty everywhere yields a miss', () => {
    const p = chunkVolume([8, 8, 8], 16, [0, 0, 0])
    const hit = pickExplodedVoxel(
      p,
      IDENTITY_RAS,
      { enabled: true, scale: [1.5, 1.5, 1.5] },
      [4, 4, 20],
      [0, 0, -1],
      { sample: () => 0, threshold: 0.5 },
    )
    expect(hit).toBeNull()
  })

  test('picks the nearest block along the ray', () => {
    // Aim down -x at y,z inside every block's slab; should hit the highest-x
    // block first (block 3, exploded x [9,11]).
    const hit = pickExplodedVoxel(
      plan(),
      IDENTITY_RAS,
      explode,
      [20, 0.5, 0.5],
      [-1, 0, 0],
    )
    expect(hit?.chunkIndex).toBe(3)
  })
})

describe('pickExplodedBlockFace', () => {
  // Realistic fixture: a 3x3x3 grid of 10^3-voxel blocks, exploded. (The tiny
  // 2x1x1 fixture used elsewhere is too thin to exercise the face inset.)
  const V = 30
  const plan = () => chunkVolume([V, V, V], 10, [0, 0, 0])
  const explode = {
    enabled: true,
    scale: [2, 2, 2] as [number, number, number],
  }
  // Build a -z ray through a given block's exploded centre, so it enters that
  // block's front face. Restrict the pick to `ci` so we test that block's face.
  const rayIntoBlock = (
    ci: number,
  ): { origin: [number, number, number]; dir: [number, number, number] } => {
    const box = explodedChunkAABB(plan(), IDENTITY_RAS, explode, ci)
    if (!box) throw new Error(`no aabb for ${ci}`)
    return {
      origin: [
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        box.max[2] + 200,
      ],
      dir: [0, 0, -1],
    }
  }

  test('a face point re-explodes back INSIDE its block (the SVG stays on the block)', () => {
    // The bug: the render re-explodes each annotation vertex by looking up its
    // chunk with floor(texFrac * dims) (explodeOffsetMMAtFrac). A point on the
    // block's OUTER boundary floors into a neighbour and gets the wrong offset, so
    // the polygon scattered off the block. The face is inset inside the block's
    // voxels; verify entryMM re-explodes into THIS block's exploded AABB.
    for (const ci of [0, 4, 13, 22, 26]) {
      const box = explodedChunkAABB(plan(), IDENTITY_RAS, explode, ci)
      if (!box) throw new Error('aabb')
      const { origin, dir } = rayIntoBlock(ci)
      const face = pickExplodedBlockFace(
        plan(),
        IDENTITY_RAS,
        explode,
        origin,
        dir,
        {
          allowed: new Set([ci]),
        },
      )
      if (!face) throw new Error(`no face for ${ci}`)
      expect(face.chunkIndex).toBe(ci)
      expect(face.loMM[0]).toBeLessThanOrEqual(face.hiMM[0])
      expect(face.loMM[1]).toBeLessThanOrEqual(face.hiMM[1])
      // IDENTITY_RAS: mm == voxel, so the render's texture fraction is mm / dims.
      const frac = [
        face.entryMM[0] / V,
        face.entryMM[1] / V,
        face.entryMM[2] / V,
      ]
      const off = explodeOffsetMMAtFrac(plan(), explode, IDENTITY_RAS, frac)
      // Offset the render looks up for the vertex must equal the face's offset...
      expect(off[0]).toBeCloseTo(face.explodeOffsetMM[0])
      expect(off[1]).toBeCloseTo(face.explodeOffsetMM[1])
      expect(off[2]).toBeCloseTo(face.explodeOffsetMM[2])
      // ...and re-exploding the vertex lands inside this block's exploded box.
      for (let k = 0; k < 3; k++) {
        expect(face.entryMM[k] + off[k]).toBeGreaterThanOrEqual(
          box.min[k] - 1e-6,
        )
        expect(face.entryMM[k] + off[k]).toBeLessThanOrEqual(box.max[k] + 1e-6)
      }
    }
  })

  test('respects the allowed set and returns null on a miss', () => {
    const { origin, dir } = rayIntoBlock(13)
    // The ray only crosses block 13; excluding it makes the pick miss.
    expect(
      pickExplodedBlockFace(plan(), IDENTITY_RAS, explode, origin, dir, {
        allowed: new Set([0]),
      }),
    ).toBeNull()
    // A ray far outside the volume hits nothing.
    expect(
      pickExplodedBlockFace(
        plan(),
        IDENTITY_RAS,
        explode,
        [1000, 1000, 1000],
        [0, 0, -1],
      ),
    ).toBeNull()
  })
})

describe('explodedChunkAABB', () => {
  const plan = () => chunkVolume([8, 1, 1], 2, [0, 0, 0])
  const explode = {
    enabled: true,
    scale: [2, 2, 2] as [number, number, number],
  }

  test('returns the exploded mm box for a block (chunk 2 -> x[5,7])', () => {
    const box = explodedChunkAABB(plan(), IDENTITY_RAS, explode, 2)
    expect(box?.min[0]).toBeCloseTo(5)
    expect(box?.max[0]).toBeCloseTo(7)
    expect(box?.min[1]).toBeCloseTo(0)
    expect(box?.max[1]).toBeCloseTo(1)
  })

  test('returns null when explode is off or the chunk is out of range', () => {
    expect(explodedChunkAABB(plan(), IDENTITY_RAS, undefined, 2)).toBeNull()
    expect(explodedChunkAABB(plan(), IDENTITY_RAS, explode, 99)).toBeNull()
  })
})

describe('rayBlockFacePointMM', () => {
  // The un-exploded z = 1 face with rect x[4,6], y[0,1] and a +1 x explode offset
  // (as pickExplodedBlockFace returns for chunk 2). The ray is in EXPLODED space,
  // so its x is shifted by -1 before intersecting, and the result is un-exploded.
  const face = {
    chunkIndex: 2,
    axis: 2 as const,
    planeMM: 1,
    inPlaneAxes: [0, 1] as [number, number],
    loMM: [4, 0] as [number, number],
    hiMM: [6, 1] as [number, number],
    entryMM: [5, 0.5, 1] as [number, number, number],
    explodeOffsetMM: [1, 0, 0] as [number, number, number],
  }

  test('projects an exploded-space ray onto the face and returns un-exploded mm', () => {
    // Exploded ray x = 6.5 -> un-exploded x = 5.5, inside the rect.
    const mm = rayBlockFacePointMM(face, [6.5, 0.9, 5], [0, 0, -1])
    expect(mm?.[0]).toBeCloseTo(5.5)
    expect(mm?.[1]).toBeCloseTo(0.9)
    expect(mm?.[2]).toBeCloseTo(1)
  })

  test('clamps the point to the block face rectangle', () => {
    // Exploded x = 9 -> un-exploded x = 8 (past hiMM 6); y = 2 (past hiMM 1).
    const mm = rayBlockFacePointMM(face, [9, 2, 5], [0, 0, -1])
    expect(mm?.[0]).toBeCloseTo(6) // clamped to hiMM x
    expect(mm?.[1]).toBeCloseTo(1) // clamped to hiMM y
    expect(mm?.[2]).toBeCloseTo(1)
  })

  test('returns null when the ray is parallel to the face', () => {
    expect(rayBlockFacePointMM(face, [6, 0.5, 5], [1, 0, 0])).toBeNull()
  })

  test('returns null when the crossing is behind the ray origin', () => {
    // Origin already past the plane (z = -5), looking further -z: t < 0.
    expect(rayBlockFacePointMM(face, [6, 0.5, -5], [0, 0, -1])).toBeNull()
  })
})

describe('explodeOffsetMMAtFrac', () => {
  // 4 chunks along x ([0,2),[2,4),[4,6),[6,8)); identity matRAS so mm == voxel.
  // Scale 2 shifts each block's origin: chunk0 -> -3, chunk3 -> +3.
  const plan = () => chunkVolume([8, 1, 1], 2, [0, 0, 0])
  const explode = {
    enabled: true,
    scale: [2, 2, 2] as [number, number, number],
  }

  test('returns the containing block offset (low-x block)', () => {
    const off = explodeOffsetMMAtFrac(plan(), explode, IDENTITY_RAS, [0, 0, 0])
    expect(off[0]).toBeCloseTo(-3)
    expect(off[1]).toBeCloseTo(0)
    expect(off[2]).toBeCloseTo(0)
  })

  test('returns the containing block offset (high-x block)', () => {
    // frac 0.9 -> voxel 7 -> chunk 3.
    const off = explodeOffsetMMAtFrac(
      plan(),
      explode,
      IDENTITY_RAS,
      [0.9, 0, 0],
    )
    expect(off[0]).toBeCloseTo(3)
  })

  test('is zero when explode is disabled', () => {
    expect(
      explodeOffsetMMAtFrac(plan(), undefined, IDENTITY_RAS, [0, 0, 0]),
    ).toEqual([0, 0, 0])
  })

  test('is zero outside the volume', () => {
    expect(
      explodeOffsetMMAtFrac(plan(), explode, IDENTITY_RAS, [1.5, 0, 0]),
    ).toEqual([0, 0, 0])
  })
})
