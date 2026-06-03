import { describe, expect, test } from 'bun:test'
import {
  chunksBackToFront,
  chunksInFrustum,
  chunksNotClippedOut,
  chunksOverlappingVoxelBox,
  orderByViewCenter,
  unionChunkSets,
} from './ChunkVisibility'
import { chunkVolume } from './chunking'

/** Column-major 4x4 identity. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major 4x4 with a translation — gl-matrix stores it in m[12..14]. */
function translate(tx: number, ty: number, tz: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]
}

function scaleTranslate(
  sx: number,
  sy: number,
  sz: number,
  tx: number,
  ty: number,
  tz: number,
): number[] {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, tx, ty, tz, 1]
}

/** A 4-chunk-along-x plan: chunk i covers x in [i*0.25, (i+1)*0.25]. */
function fourChunkPlan() {
  // 8 voxels, device limit 2, no halo => stride 2, gridDims[0] = 4.
  return chunkVolume([8, 1, 1], 2, [0, 0, 0])
}

describe('chunksInFrustum', () => {
  test('identity MVP keeps every chunk (unit cube fills the frustum)', () => {
    const plan = fourChunkPlan()
    expect(chunksInFrustum(plan, IDENTITY, true)).toEqual([0, 1, 2, 3])
  })

  test('translating the volume fully off-screen culls every chunk', () => {
    const plan = fourChunkPlan()
    // Push x far past the right clip plane: clip.x in [+10, +11], all > w.
    expect(chunksInFrustum(plan, translate(10, 0, 0), true)).toEqual([])
  })

  test('a partial translation culls only the chunks left of the frustum', () => {
    const plan = fourChunkPlan()
    // Shift x by -1: chunk i now spans clip.x in [i*0.25 - 1, (i+1)*0.25 - 1].
    // The left plane is clip.x >= -w = -1. Chunk 0 spans [-1, -0.75] — its
    // far corner touches -1, so it is NOT fully outside and survives.
    const visible = chunksInFrustum(plan, translate(-1.3, 0, 0), true)
    // Shift -1.3: chunk 0 spans [-1.3, -1.05] (all < -1 => culled),
    // chunk 1 spans [-1.05, -0.8] (straddles -1 => visible).
    expect(visible).toEqual([1, 2, 3])
  })

  test('single-chunk volume is reported visible under identity', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    expect(plan.chunks.length).toBe(1)
    expect(chunksInFrustum(plan, IDENTITY, true)).toEqual([0])
  })

  test('chunk behind the camera (w <= 0) is conservatively kept', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    // A projective MVP whose w row makes w negative across the cube.
    const mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]
    expect(chunksInFrustum(plan, mvp, true)).toEqual([0])
  })

  test('near-plane convention differs between backends', () => {
    const plan = chunkVolume([4, 4, 4], 8)
    // Map z in [0,1] to clip.z in [-2,-1] (w stays 1): fully behind the
    // WebGPU near plane (z >= 0) but the z = -1 corner sits exactly on the
    // WebGL2 near plane (z >= -w), so WebGL2 keeps the chunk.
    const mvp = translate(0, 0, -2)
    expect(chunksInFrustum(plan, mvp, true)).toEqual([]) // WebGPU: culled
    expect(chunksInFrustum(plan, mvp, false)).toEqual([0]) // WebGL2: kept
  })

  test('matRAS path matches the volume vertex shader transform', () => {
    const plan = fourChunkPlan()
    // The render shader maps fraction -> voxel-space `(frac * dims) - 0.5`,
    // then row-vector multiplies by matRAS before the MVP. This MVP maps that
    // voxel x back to `frac.x - 1.3`, reproducing the partial-cull case above.
    const voxelXToShiftedFrac = scaleTranslate(
      1 / 8,
      0,
      0,
      0.5 / 8 - 1.3,
      0,
      0.5,
    )
    expect(chunksInFrustum(plan, voxelXToShiftedFrac, true, IDENTITY)).toEqual([
      1, 2, 3,
    ])
  })

  test('optional chunk offsets move the culling AABB', () => {
    const plan = fourChunkPlan()
    const visible = chunksInFrustum(
      plan,
      translate(-1.3, 0, 0),
      true,
      undefined,
      (chunkIndex) => (chunkIndex === 0 ? [0.4, 0, 0] : [0, 0, 0]),
    )
    expect(visible).toEqual([0, 1, 2, 3])
  })
})

describe('chunksBackToFront', () => {
  test('draws high-x chunks first for a positive x ray', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(chunksBackToFront(plan, [1, 0, 0])).toEqual([1, 0])
  })

  test('draws low-x chunks first for a negative x ray', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(chunksBackToFront(plan, [-1, 0, 0])).toEqual([0, 1])
  })

  test('uses the far AABB corner for diagonal rays', () => {
    const plan = chunkVolume([4, 4, 2], 2, [0, 0, 0])
    const order = chunksBackToFront(plan, [1, 1, 0])
    expect(order.at(0)).toBe(3)
    expect(order.at(-1)).toBe(0)
  })

  test('includes chunk offsets in draw order', () => {
    const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
    expect(
      chunksBackToFront(plan, [1, 0, 0], (chunkIndex) =>
        chunkIndex === 0 ? [2, 0, 0] : [0, 0, 0],
      ),
    ).toEqual([0, 1])
  })

  test('sorts in scaled object space for anisotropic volumes', () => {
    const plan = chunkVolume([4, 4, 1], 2, [0, 0, 0])
    expect(chunksBackToFront(plan, [0.4, 1, 0]).indexOf(2)).toBeLessThan(
      chunksBackToFront(plan, [0.4, 1, 0]).indexOf(1),
    )
    const scaledOrder = chunksBackToFront(
      plan,
      [0.4, 1, 0],
      undefined,
      [1, 0.1, 1],
    )
    expect(scaledOrder.indexOf(1)).toBeLessThan(scaledOrder.indexOf(2))
  })

  test('keeps plan order when the ray direction is degenerate', () => {
    const plan = fourChunkPlan()
    expect(chunksBackToFront(plan, [0, 0, 0])).toEqual([0, 1, 2, 3])
    expect(chunksBackToFront(plan, [Number.NaN, 0, 0])).toEqual([0, 1, 2, 3])
  })
})

describe('unionChunkSets', () => {
  test('merges and sorts overlapping per-tile lists', () => {
    expect(unionChunkSets([[3, 1], [1, 2], [5]])).toEqual([1, 2, 3, 5])
  })

  test('empty input yields an empty set', () => {
    expect(unionChunkSets([])).toEqual([])
    expect(unionChunkSets([[], []])).toEqual([])
  })
})

describe('orderByViewCenter', () => {
  // Map frac [0,1] -> NDC [-1,1] so frac 0.5 is the screen centre. The
  // 4-chunk-along-x plan has chunk centres at frac x = 0.125/0.375/0.625/0.875,
  // i.e. NDC x = -0.75/-0.25/+0.25/+0.75 — chunks 1 and 2 are nearest centre.
  const CENTER_MVP = scaleTranslate(2, 2, 2, -1, -1, -1)

  test('orders chunks centre-first, then outward', () => {
    const plan = fourChunkPlan()
    expect(orderByViewCenter(plan, [0, 1, 2, 3], CENTER_MVP)).toEqual([
      1, 2, 0, 3,
    ])
  })

  test('is a permutation of the input set', () => {
    const plan = fourChunkPlan()
    const out = orderByViewCenter(plan, [3, 2, 1, 0], CENTER_MVP)
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
  })

  test('respects the input subset (only orders what it is given)', () => {
    const plan = fourChunkPlan()
    expect(orderByViewCenter(plan, [0, 3], CENTER_MVP)).toEqual([0, 3])
    expect(orderByViewCenter(plan, [2, 0], CENTER_MVP)).toEqual([2, 0])
  })

  test('chunks at/behind the camera (w <= 0) sort last', () => {
    const plan = fourChunkPlan()
    // w row negates w across the cube; all chunks score +Infinity, stable order.
    const mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0]
    expect(orderByViewCenter(plan, [0, 1, 2, 3], mvp)).toEqual([0, 1, 2, 3])
  })
})

describe('chunksNotClippedOut', () => {
  // Pad active planes out to model.clipPlanes' 6-plane / 24-float layout with
  // the [0,0,0,2] "no clip" sentinel.
  const SENTINEL = [0, 0, 0, 2]
  function clip(...planes: number[][]): number[] {
    const out: number[] = []
    for (const p of planes) out.push(...p)
    while (out.length < 6 * 4) out.push(...SENTINEL)
    return out
  }

  test('no active planes (all sentinel) keeps every chunk', () => {
    const plan = fourChunkPlan()
    expect(chunksNotClippedOut(plan, [0, 1, 2, 3], clip(), false)).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('a plane culls chunks fully on the removed side, keeps straddlers', () => {
    const plan = fourChunkPlan()
    // n=[1,0,0], a=0 cuts at x=0.5; kept side is dot(n,p-0.5)-a >= 0 ⇒ x >= 0.5.
    // chunk 0 (x∈[0,.25]) is fully removed; chunk 1 (x∈[.25,.5]) has its far
    // corner exactly on the plane (f=0, kept) so it survives conservatively.
    expect(
      chunksNotClippedOut(plan, [0, 1, 2, 3], clip([1, 0, 0, 0]), false),
    ).toEqual([1, 2, 3])
  })

  test('on-plane corner is conservatively kept', () => {
    const plan = fourChunkPlan()
    // chunk 1's far face sits exactly on the x=0.5 plane — must not be culled.
    expect(chunksNotClippedOut(plan, [1], clip([1, 0, 0, 0]), false)).toEqual([
      1,
    ])
  })

  test('cutaway flag disables culling (keeps all)', () => {
    const plan = fourChunkPlan()
    expect(
      chunksNotClippedOut(plan, [0, 1, 2, 3], clip([1, 0, 0, 0]), true),
    ).toEqual([0, 1, 2, 3])
  })

  test('multiple planes intersect (a chunk culled by either is dropped)', () => {
    const plan = fourChunkPlan()
    // Plane A removes chunk 0 (x<0.5); plane B (n=[-1,0,0], a=0) keeps x<=0.5,
    // removing chunk 3 (x∈[.75,1]). Together: chunks 1,2 survive.
    expect(
      chunksNotClippedOut(
        plan,
        [0, 1, 2, 3],
        clip([1, 0, 0, 0], [-1, 0, 0, 0]),
        false,
      ),
    ).toEqual([1, 2])
  })

  test('explode offset shifts the corners across the plane', () => {
    const plan = fourChunkPlan()
    // n=[1,0,0], a=0 would cull chunk 0, but an explode offset of +0.5 in x
    // pushes its corners to the kept side, so it survives.
    const offsetFor = (ci: number): [number, number, number] =>
      ci === 0 ? [0.5, 0, 0] : [0, 0, 0]
    expect(
      chunksNotClippedOut(
        plan,
        [0, 1, 2, 3],
        clip([1, 0, 0, 0]),
        false,
        offsetFor,
      ),
    ).toEqual([0, 1, 2, 3])
  })

  test('degenerate normal is treated as inactive', () => {
    const plan = fourChunkPlan()
    // n=[0,0,0] with an in-range a must not cull anything.
    expect(
      chunksNotClippedOut(plan, [0, 1, 2, 3], clip([0, 0, 0, 0]), false),
    ).toEqual([0, 1, 2, 3])
  })
})

describe('chunksOverlappingVoxelBox', () => {
  // fourChunkPlan: chunks cover x voxels [0,2),[2,4),[4,6),[6,8); y,z = [0,1).
  test('a box inside one chunk hits only that chunk', () => {
    const plan = fourChunkPlan()
    expect(chunksOverlappingVoxelBox(plan, [0, 0, 0], [1, 0, 0])).toEqual([0])
    expect(chunksOverlappingVoxelBox(plan, [4, 0, 0], [4, 0, 0])).toEqual([2])
  })

  test('a box straddling a boundary hits both chunks', () => {
    const plan = fourChunkPlan()
    // voxels 1..2: voxel 1 in chunk 0, voxel 2 in chunk 1.
    expect(chunksOverlappingVoxelBox(plan, [1, 0, 0], [2, 0, 0])).toEqual([
      0, 1,
    ])
    expect(chunksOverlappingVoxelBox(plan, [3, 0, 0], [5, 0, 0])).toEqual([
      1, 2,
    ])
  })

  test('a box spanning the volume hits every chunk', () => {
    const plan = fourChunkPlan()
    expect(chunksOverlappingVoxelBox(plan, [0, 0, 0], [7, 0, 0])).toEqual([
      0, 1, 2, 3,
    ])
  })

  test('a box outside the volume on any axis hits nothing', () => {
    const plan = fourChunkPlan()
    expect(chunksOverlappingVoxelBox(plan, [0, 1, 0], [7, 1, 0])).toEqual([])
  })
})
